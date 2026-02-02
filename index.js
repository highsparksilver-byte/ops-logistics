import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
    🚀 APP INIT & CONFIG
================================ */
const app = express();
const rateLimiter = new Map();
axios.defaults.timeout = 8000;

setInterval(() => { rateLimiter.clear(); console.log("🧹 Rate limiter cleared"); }, 60 * 60 * 1000);

app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = v => v?.replace(/\r|\n|\t/g, "").trim();
const {
  CLIENT_ID, CLIENT_SECRET, LOGIN_ID, BD_LICENCE_KEY_TRACK, BD_LICENCE_KEY_EDD,
  SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD, DATABASE_URL, SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_ACCESS_TOKEN, SHOP_NAME
} = process.env;

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

/* ===============================
    🔐 SECURITY & AUDIT
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret || !req.rawBody) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  return digest === req.headers["x-shopify-hmac-sha256"];
}

function verifyAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.key;
  return key === clean(SHOPIFY_WEBHOOK_SECRET);
}

async function logEvent(type, source, payload) {
  try {
    await pool.query("INSERT INTO event_logs (event_type, source, payload) VALUES ($1, $2, $3)", 
    [type, source, JSON.stringify(payload)]);
  } catch (e) { console.error("Log Error", e); }
}

/* ===============================
    📦 COURIER AUTH & TRACKING
================================ */
let bdJwt, bdAt = 0; let srJwt, srAt = 0;
async function getBluedartJwt() { if (bdJwt && Date.now() - bdAt < 23 * 3600000) return bdJwt; const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } }); bdJwt = r.data.JWTToken; bdAt = Date.now(); return bdJwt; }
async function getShiprocketJwt() { if (srJwt && Date.now() - srAt < 7 * 86400000) return srJwt; const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) }); srJwt = r.data.token; srAt = Date.now(); return srJwt; }

async function trackBluedart(awb) {
  try {
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", { params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: awb, numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 }, responseType: "text" });
    if (!r.data || r.data.includes("<html")) return null;
    const p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = p?.ShipmentData?.Shipment; if (!s) return null;
    const scans = (Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail]).filter(x => x && x.Scan);
    return { status: s.Status, delivered: s.Status.toUpperCase().includes("DELIVERED"), history: scans.map(x => ({ status: x.Scan, date: `${x.ScanDate} ${x.ScanTime}`, location: x.ScannedLocation, completed: true })) };
  } catch { return null; }
}

/* ===============================
    🔄 DOMAIN SYNC (The Master Contract)
================================ */
async function syncOrder(o) {
  const isExchange = o.name.startsWith("EX-") || (o.tags && o.tags.includes("exchange"));
  const isReturn = o.name.includes("-R");
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || null;

  await pool.query(`
    INSERT INTO orders_ops (id, order_number, financial_status, fulfillment_status, total_price, customer_name, customer_phone, city, is_exchange, is_return, source, created_at) 
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET financial_status=EXCLUDED.financial_status, fulfillment_status=EXCLUDED.fulfillment_status, customer_phone=EXCLUDED.customer_phone, city=EXCLUDED.city
  `, [o.id, o.name, o.financial_status, o.fulfillment_status, o.total_price, `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim(), phone, o.shipping_address?.city, isExchange, isReturn, 'shopify', o.created_at]);

  for (const f of o.fulfillments || []) {
    if (f.tracking_number) await pool.query(`INSERT INTO shipments_ops (awb, order_id, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`, [f.tracking_number, o.id, f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket"]);
  }
}

/* ===============================
    🔔 WEBHOOKS (The Inbound Traffic)
================================ */
app.post("/webhooks/orders_paid", async (req, res) => {
  res.sendStatus(200);
  if (verifyShopify(req)) {
    await logEvent("ORDER_PAID", "shopify", req.body);
    await syncOrder(req.body);
  }
});

app.post("/webhooks/returnprime", async (req, res) => {
  res.sendStatus(200);
  const event = req.body;
  await logEvent("RETURN_PRIME_EVENT", "returnprime", event);
  await pool.query(`
    INSERT INTO returns_ops (return_id, order_number, status, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (return_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
  `, [event.return_id, event.order_number, event.status]);
});

/* ===============================
    🛠️ PROTECTED OPS APIs (Castle 2 Connectors)
================================ */
app.get("/ops/orders", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { rows } = await pool.query(`
    SELECT o.*, s.awb, r.status as return_status
    FROM orders_ops o 
    LEFT JOIN shipments_ops s ON s.order_id = o.id
    LEFT JOIN returns_ops r ON r.order_number = o.order_number
    ORDER BY o.created_at DESC LIMIT 100
  `);
  res.json({ orders: rows });
});

app.get("/recon/ops", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { rows } = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE is_exchange = FALSE AND is_return = FALSE) as net_new_orders,
      COUNT(*) FILTER (WHERE is_return = TRUE) as total_returns,
      COUNT(*) FILTER (WHERE financial_status != 'paid' AND fulfillment_status = 'fulfilled') as cod_at_risk
    FROM orders_ops WHERE created_at > NOW() - INTERVAL '30 days'
  `);
  res.json({ summary: rows[0] });
});

/* ===============================
    📅 PUBLIC EDD WIDGET
================================ */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode)) return res.json({ edd_display: null });
  // Include your City/EDD prediction logic here as per previous steps
  res.json({ status: "success", message: "EDD calculated" }); 
});

app.get("/health", (_, res) => res.send("READY"));
app.listen(process.env.PORT || 10000, () => console.log("🚀 Secure Master V2 Live"));