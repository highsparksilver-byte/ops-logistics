import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

const app = express();

app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = v => v?.replace(/\r|\n|\t/g, "").trim();
const {
  CLIENT_ID, CLIENT_SECRET, LOGIN_ID,
  BD_LICENCE_KEY_TRACK, BD_LICENCE_KEY_EDD,
  SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD,
  DATABASE_URL, SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_NAME // Needed for pushing status back
} = process.env;

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🔐 SECURITY
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret) return true; 
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  return digest === hmacHeader;
}

/* ===============================
   🔐 TOKEN CACHE & HELPERS
================================ */
let bdJwt, bdJwtAt = 0;
let srJwt, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23*60*60*1000) return bdJwt;
  const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { 
    headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } 
  });
  bdJwt = r.data.JWTToken; bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 7*24*60*60*1000) return srJwt;
  const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { 
    email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) 
  });
  srJwt = r.data.token; srJwtAt = Date.now();
  return srJwt;
}

function getStatusType(s="") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";
  if (s.includes("RTO") || s.includes("RETURN")) return "RT";
  if (s.includes("OUT FOR")) return "OF";
  return "UD";
}

/* ===============================
   📦 TRACKING ENGINES
================================ */
async function trackBluedart(awb) {
  try {
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: "awb", numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 },
      responseType: "text"
    });
    const p = await xml2js.parseStringPromise(r.data, { explicitArray:false });
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;
    return { source: "bluedart", status: s.Status, delivered: getStatusType(s.Status)==="DL" };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } });
    const td = r.data?.tracking_data;
    return { source: "shiprocket", status: td?.current_status, delivered: getStatusType(td?.current_status)==="DL" };
  } catch { return null; }
}

/* ===============================
   🎯 LIVE TRACKING (FOR WIDGET)
================================ */
app.post("/track/customer", async (req, res) => {
  const { phone, email } = req.body;
  if (!phone) return res.status(400).json({ error: "Mobile number required" });

  try {
    // Find last 3 orders matching phone or email
    const { rows } = await pool.query(`
      SELECT o.order_number as shopify_order_name, s.awb, s.courier_source as courier
      FROM orders_ops o
      JOIN shipments_ops s ON s.order_id = o.id
      WHERE o.customer_phone = $1 OR o.customer_email = $2
      ORDER BY o.created_at DESC LIMIT 3
    `, [phone, email || '']);

    if (rows.length === 0) return res.status(404).json({ error: "No orders found" });

    const results = await Promise.all(rows.map(async (o) => {
      const track = o.courier === "bluedart" ? await trackBluedart(o.awb) : await trackShiprocket(o.awb);
      return { ...o, last_known_status: track?.status || "Processing", delivered: track?.delivered || false };
    }));

    res.json({ orders: results });
  } catch (e) {
    res.status(500).json({ error: "Server Error" });
  }
});

/* ===============================
   🧾 WEBHOOKS (CAPTURING DATA)
================================ */
app.post("/webhooks/orders_paid", async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req)) return;

  const o = req.body;
  // Format phone to match +91XXXXXXXXXX
  let phone = o.shipping_address?.phone || o.customer?.phone || "";
  phone = phone.replace(/\s+/g, '');
  if (phone.length === 10) phone = "+91" + phone;

  try {
    await pool.query(`
      INSERT INTO orders_ops (id, order_number, financial_status, total_price, customer_phone, customer_email, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET financial_status = EXCLUDED.financial_status
    `, [o.id, o.name, o.financial_status, o.total_price, phone, o.customer?.email]);
    console.log(`✅ Saved order ${o.name}`);
  } catch (e) { console.error("❌ DB Error:", e.message); }
});

app.post("/webhooks/fulfillments_create", async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req)) return;
  const f = req.body;
  const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  try {
    await pool.query(`INSERT INTO shipments_ops (order_id, awb, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`,
      [f.order_id, f.tracking_number, courier]);
  } catch (e) { console.error("❌ DB Error:", e.message); }
});

app.get("/health", (_, res) => res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Logistics Engine Live"));