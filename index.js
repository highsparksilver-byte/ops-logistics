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
   🧠 LOGICS & STATE MACHINE
================================ */
function resolveShipmentState(status = "") {
  const s = status.toUpperCase();
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("RETURN") || s.includes("RTO")) return "RTO";
  if (s.includes("FAILED") || s.includes("UNDELIVERED") || s.includes("REFUSED") || s.includes("CANCEL")) return "NDR";
  if (s.includes("OUT FOR") || s.includes("DISPATCHED") || s.includes("IN TRANSIT") || s.includes("ARRIVED") || s.includes("PICKED") || s.includes("CONNECTED") || s.includes("SHIPPED")) return "IN_TRANSIT";
  return "PROCESSING";
}

function formatConfidenceBand(dStr) {
  if (!dStr) return null;
  const s = new Date(dStr); if (isNaN(s.getTime())) return null;
  const e = new Date(s); e.setDate(e.getDate() + 1);
  const f = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return `${f(s)} - ${f(e)}`;
}

/* ===============================
   🔐 SECURITY
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

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimiter.has(ip)) { rateLimiter.set(ip, { c: 1, t: now }); return true; }
  const r = rateLimiter.get(ip);
  if (now - r.t > 60000) { r.c = 1; r.t = now; return true; }
  if (r.c >= 30) return false;
  r.c++; return true;
}

/* ===============================
   📦 COURIER ENGINE
================================ */
let srJwt, srAt = 0, bdJwt, bdAt = 0;

async function getBluedartJwt() { 
  if (bdJwt && Date.now() - bdAt < 23 * 3600000) return bdJwt; 
  const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } });
  bdJwt = r.data.JWTToken; bdAt = Date.now(); return bdJwt; 
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srAt < 7 * 86400000) return srJwt;
  const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) });
  srJwt = r.data.token; srAt = Date.now(); return srJwt;
}

const IGNORE_SCANS = ["BAGGED", "MANIFEST", "NETWORK", "RELIEF", "PARTIAL"];

async function trackBluedart(awb) {
  try {
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: awb, numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 },
      responseType: "text"
    });
    if (!r.data || r.data.includes("<html")) return null;
    const p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = p?.ShipmentData?.Shipment; if (!s) return null;

    // 🟢 FIX 1: SAFETY GUARD - Never drop scans if delivered
    const isFinal = s.Status?.toUpperCase().includes("DELIVERED");
    const rawScans = Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail];
    
    const scans = rawScans.filter(x => {
      if (!x?.Scan) return false;
      if (isFinal) return true; // Keep everything if delivered
      return !IGNORE_SCANS.some(k => x.Scan.toUpperCase().includes(k));
    });

    return { 
      status: s.Status, 
      delivered: isFinal, 
      history: scans.map(x => ({ status: x.Scan, date: `${x.ScanDate} ${x.ScanTime}`, location: x.ScannedLocation })),
      raw: p 
    };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } });
    const d = r.data?.tracking_data; if (!d) return null;
    
    return { 
      status: d.current_status, 
      delivered: d.current_status.toUpperCase().includes("DELIVERED"), 
      history: (d.shipment_track_activities || []).map(x => ({ status: x.activity, date: x.date, location: x.location })),
      raw: d 
    };
  } catch { return null; }
}

// 🔮 PREDICTION
async function getCity(p){try{const r=await axios.get(`https://api.postalpincode.in/pincode/${p}`);return r.data?.[0]?.PostOffice?.[0]?.District||null}catch{return null}}
async function predictBluedartEDD(p){try{const j=await getBluedartJwt();const r=await axios.post("https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",{pPinCodeFrom:"411022",pPinCodeTo:p,pProductCode:"A",pSubProductCode:"P",pPudate:new Date(new Date().getTime()+330*60000).toISOString(),pPickupTime:"16:00",profile:{Api_type:"S",LicenceKey:clean(BD_LICENCE_KEY_EDD),LoginID:clean(LOGIN_ID)}},{headers:{JWTToken:j}});return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery||null}catch{return null}}
async function predictShiprocketEDD(p){try{const t=await getShiprocketJwt();const r=await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${p}&cod=1&weight=0.5`,{headers:{Authorization:`Bearer ${t}`}});return r.data?.data?.available_courier_companies?.[0]?.etd||null}catch{return null}}

/* ===============================
   🔄 SYNC & BACKGROUND
================================ */
async function syncOrder(o) {
  const isExchange = o.name?.startsWith("EX-") || o.tags?.includes("exchange");
  const isReturn = o.name?.includes("-R");
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || null;

  // 🟢 FIX 2: String(o.id) for 64-bit safety
  await pool.query(`
    INSERT INTO orders_ops (id, order_number, financial_status, fulfillment_status, total_price, payment_gateway_names, customer_name, customer_email, customer_phone, city, line_items, is_exchange, is_return, source, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (id) DO UPDATE SET financial_status = EXCLUDED.financial_status, fulfillment_status = EXCLUDED.fulfillment_status, customer_phone = EXCLUDED.customer_phone, city = EXCLUDED.city
  `, [String(o.id), o.name, o.financial_status, o.fulfillment_status, o.total_price, JSON.stringify(o.payment_gateway_names || []), `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim(), o.email || o.customer?.email, phone, o.shipping_address?.city, JSON.stringify(o.line_items || []), isExchange, isReturn, "shopify", o.created_at]);
  
  if (o.fulfillments) {
    for (const f of o.fulfillments) {
      if (f.tracking_number) await pool.query(`INSERT INTO shipments_ops (awb, order_id, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`, [f.tracking_number, String(o.id), f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket"]);
    }
  }
}

async function updateStaleShipments() {
  try {
    const { rows } = await pool.query(`SELECT awb, courier_source FROM shipments_ops WHERE delivered = FALSE AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '30 minutes') LIMIT 15`);
    for (const r of rows) {
      const t = r.courier_source === "bluedart" ? await trackBluedart(r.awb) : await trackShiprocket(r.awb);
      if (t) {
        // 🟢 FIX 3: Capture raw_data and cast jsonb correctly
        await pool.query(`UPDATE shipments_ops SET delivered=$1, last_status=$2, last_state=$3, history=$4::jsonb, raw_data=$5::jsonb, last_checked_at=NOW() WHERE awb=$6`, 
        [t.delivered, t.status, resolveShipmentState(t.status), JSON.stringify(t.history || []), JSON.stringify(t.raw || {}), r.awb]);
      }
    }
  } catch (e) { console.error("Sync loop error:", e.message); }
}

async function runBackfill() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) return;
  try {
    const r = await axios.get(`https://${SHOP_NAME}.myshopify.com/admin/api/2023-10/orders.json?status=any&limit=50`, { headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN } });
    for (const o of r.data.orders || []) await syncOrder(o);
  } catch (e) { console.error("Backfill error:", e.message); }
}

setTimeout(runBackfill, 5000);
setInterval(() => { runBackfill(); updateStaleShipments(); }, 30 * 60 * 1000);

/* ===============================
   🔍 CUSTOMER ENDPOINT (DB-ONLY)
================================ */
app.post("/track/customer", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests" });
  const cleanInput = req.body?.phone?.replace(/\D/g, "").slice(-10);
  if (!cleanInput) return res.status(400).json({ error: "Invalid phone" });

  try {
    const { rows } = await pool.query(`
      SELECT o.order_number, o.created_at, o.fulfillment_status, s.awb, s.courier_source, s.last_state, s.last_status, s.history as db_history
      FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id = o.id 
      WHERE o.customer_phone LIKE $1 ORDER BY o.created_at DESC LIMIT 5
    `, [`%${cleanInput}`]);

    const results = rows.map((row) => {
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];
      if (row.fulfillment_status === 'fulfilled') history.push({ status: "Dispatched", date: "Order Packed", completed: true });
      if (Array.isArray(row.db_history)) history = [...history, ...row.db_history];

      return { 
        shopify_order_name: row.order_number, awb: row.awb, 
        current_state: row.last_state || (row.fulfillment_status === 'fulfilled' ? "IN_TRANSIT" : "PROCESSING"), 
        courier: row.courier_source, 
        last_known_status: row.last_status || "Shipment information will be updated shortly", 
        tracking_history: history 
      };
    });
    res.json({ orders: results });
  } catch (e) { res.status(500).json({ error: "Server error" }); }
});

/* ===============================
   📅 EDD (Product Page)
================================ */
const eddCache = new Map();

// 🟢 FIX 4: Cache reset at 11 AM IST
function msUntil11AM() {
  const now = new Date();
  const next = new Date();
  next.setHours(11, 0, 0, 0);
  if (now > next) next.setDate(next.getDate() + 1);
  return next - now;
}
setTimeout(() => {
  eddCache.clear();
  setInterval(() => eddCache.clear(), 24 * 60 * 60 * 1000);
}, msUntil11AM());

app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^\d{6}$/.test(pincode)) return res.json({ edd_display: null });
  if (eddCache.has(pincode)) return res.json(eddCache.get(pincode));

  const city = await getCity(pincode);
  const rawDate = await predictBluedartEDD(pincode) || await predictShiprocketEDD(pincode);
  
  if (!rawDate) return res.json({ edd_display: null });
  
  const data = { edd_display: formatConfidenceBand(rawDate), city, badge: city && ["MUMBAI","DELHI","BANGALORE","PUNE"].some(m=>city.toUpperCase().includes(m)) ? "METRO_EXPRESS" : "EXPRESS" };
  eddCache.set(pincode, data);
  res.json(data);
});

/* ===============================
   🔔 WEBHOOKS & ADMIN
================================ */
app.post("/webhooks/orders_paid", (req, res) => { res.sendStatus(200); if (verifyShopify(req)) syncOrder(req.body); });
app.post("/webhooks/fulfillments_create", async (req, res) => {
  res.sendStatus(200); if (!verifyShopify(req) || !req.body.tracking_number) return;
  const courier = req.body.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  await pool.query(`INSERT INTO shipments_ops (awb, order_id, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`, [req.body.tracking_number, String(req.body.order_id), courier]);
});
app.post("/webhooks/returnprime", async (req, res) => {
  res.sendStatus(200); const e = req.body;
  if (!e.id || !e.order_number) return;
  await pool.query(`INSERT INTO returns_ops (return_id, order_number, status, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (return_id) DO UPDATE SET status=EXCLUDED.status, updated_at=NOW()`, [String(e.id), e.order_number, e.status || "created"]);
});

app.get("/ops/orders", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { rows } = await pool.query(`SELECT o.*, s.awb, s.last_state, r.status AS return_status FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id = o.id LEFT JOIN returns_ops r ON r.order_number = o.order_number ORDER BY o.created_at DESC LIMIT 100`);
  res.json({ orders: rows });
});

app.get("/recon/ops", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE is_exchange=FALSE AND is_return=FALSE) AS net_new_orders, COUNT(*) FILTER (WHERE is_return=TRUE) AS total_returns, COUNT(*) FILTER (WHERE financial_status!='paid' AND fulfillment_status='fulfilled') AS cod_at_risk FROM orders_ops WHERE created_at > NOW() - INTERVAL '30 days'`);
  res.json({ summary: rows[0] });
});

app.get("/health", (_, res) => res.send("READY"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 HighSpark Logistics Master LIVE", PORT));