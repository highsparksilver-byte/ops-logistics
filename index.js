import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT & CONFIG
================================ */
const app = express();
const trackingCache = new Map();
const rateLimiter = new Map();

// 🧹 MEMORY CLEANUP
setInterval(() => {
  rateLimiter.clear();
  console.log("🧹 Rate limiter cleared");
}, 60 * 60 * 1000);

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
  SHOPIFY_ACCESS_TOKEN, SHOP_NAME
} = process.env;

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

/* ===============================
   🧠 STATE MACHINE (REFINED)
================================ */
function resolveShipmentState(status = "") {
  const s = status.toUpperCase();

  // 1. DELIVERED (Top Priority)
  if (s.includes("DELIVERED")) return "DELIVERED";

  // 2. RTO (Overrides NDR)
  if (s.includes("RTO") || s.includes("RETURN")) return "RTO";

  // 3. NDR / ISSUES
  if (
    s.includes("REFUSED") ||
    s.includes("NOT AVAILABLE") ||
    s.includes("LOCKED") ||
    s.includes("CLOSED") ||
    s.includes("UNDELIVERED") ||
    s.includes("FAILED") ||
    s.includes("REJECT") ||
    s.includes("ATTEMPTED") ||
    s.includes("CANCEL")
  ) return "NDR";

  // 4. TRANSIT
  if (
    s.includes("OUT FOR") ||
    s.includes("DISPATCHED") ||
    s.includes("IN TRANSIT") ||
    s.includes("ARRIVED") ||
    s.includes("PICKED") ||
    s.includes("CONNECTED") || // Kept here for logic
    s.includes("SHIPPED")
  ) return "IN_TRANSIT";

  return "PROCESSING";
}

/* ===============================
   🛡️ SECURITY & HELPERS
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret) { console.error("⛔ SECURITY: Webhook Secret Missing!"); return false; }
  if (!req.rawBody) return false;
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
  if (r.c >= 10) return false;
  r.c++; return true;
}

// TOKEN CACHING
let bdJwt, bdAt = 0; let srJwt, srAt = 0;
async function getBluedartJwt() { if (bdJwt && Date.now() - bdAt < 23 * 3600000) return bdJwt; const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } }); bdJwt = r.data.JWTToken; bdAt = Date.now(); return bdJwt; }
async function getShiprocketJwt() { if (srJwt && Date.now() - srAt < 7 * 86400000) return srJwt; const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) }); srJwt = r.data.token; srAt = Date.now(); return srJwt; }

/* ===============================
   🔄 BACKFILL
================================ */
async function runBackfill(limit = 50) {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) {
    console.log("⚠️ Sync Skipped: Missing API Config");
    return { success: false, message: "Missing Config" };
  }
  if (limit > 100) limit = 100;

  try {
    const r = await axios.get(`https://${clean(SHOP_NAME)}.myshopify.com/admin/api/2023-10/orders.json?status=any&limit=${limit}`, {
      headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) }
    });
    const orders = r.data.orders || [];
    let savedCount = 0;

    for (const o of orders) {
      const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || "";
      await pool.query(`INSERT INTO orders_ops (id, order_number, financial_status, fulfillment_status, total_price, payment_gateway_names, customer_email, customer_phone, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET financial_status = EXCLUDED.financial_status, fulfillment_status = EXCLUDED.fulfillment_status, customer_phone = EXCLUDED.customer_phone`, [o.id, o.name, o.financial_status, o.fulfillment_status, o.total_price, JSON.stringify(o.payment_gateway_names || []), o.email || o.customer?.email, phone, o.created_at]);
      savedCount++;

      if (o.fulfillments && o.fulfillments.length > 0) {
        for (const f of o.fulfillments) {
          if (!f.tracking_number) continue;
          const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
          await pool.query(`INSERT INTO shipments_ops (order_id, awb, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`, [o.id, f.tracking_number, courier]);
        }
      }
    }
    return { success: true, count: savedCount };
  } catch (e) { return { success: false, error: e.message }; }
}
setInterval(() => { runBackfill(50); }, 30 * 60 * 1000);
setTimeout(() => { runBackfill(50); }, 5000);

/* ===============================
   📦 TRACKING CORE (UPDATED)
================================ */
// 🟢 FIX 1: Removed "CONNECTED" from ignore list so it shows in timeline
const IGNORE_SCANS = ["FURTHER", "BAGGED", "MANIFEST", "NETWORK", "RELIEF", "PARTIAL"];

function formatConfidenceBand(dStr) { if (!dStr) return null; const s = new Date(dStr); if (isNaN(s.getTime())) return null; const e = new Date(s); e.setDate(e.getDate() + 1); const f = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); return `${f(s)} - ${f(e)}`; }

async function trackBluedart(awb) {
  try {
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", { params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: "awb", numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 }, responseType: "text" });
    if (r.data.includes("<html")) return null;
    const p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;
    
    // Filter Noise
    const rawScans = Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail];
    const h = rawScans
      .filter(x => x && x.Scan && !IGNORE_SCANS.some(k => x.Scan.toUpperCase().includes(k)))
      .map(x => ({ status: x.Scan, date: `${x.ScanDate} ${x.ScanTime}`, location: x.ScannedLocation, completed: true }));

    return { source: "bluedart", status: s.Status, delivered: s.Status.toUpperCase().includes("DELIVERED"), edd: s.ExpectedDateDelivery, history: h };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } });
    const d = r.data?.tracking_data;
    if (!d) return null;

    // Filter Noise
    const h = (d.shipment_track_activities || [])
      .filter(x => x && x.activity && !IGNORE_SCANS.some(k => x.activity.toUpperCase().includes(k)))
      .map(x => ({ status: x.activity, date: x.date, location: x.location, completed: true }));

    return { source: "shiprocket", status: d.current_status, delivered: d.current_status.toUpperCase().includes("DELIVERED"), edd: d.etd, history: h };
  } catch { return null; }
}

/* ===============================
   🔍 CUSTOMER ENDPOINT (REFINED)
================================ */
app.post("/track/customer", async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const { phone } = req.body;
  const cleanInput = phone?.replace(/[^0-9]/g, "").trim(); 
  if (!cleanInput || cleanInput.length < 10) return res.status(400).json({ error: "Invalid phone" });

  try {
    const { rows } = await pool.query(`SELECT o.order_number, o.fulfillment_status, s.awb, s.courier_source, o.created_at, s.delivered as db_delivered, s.last_status, s.last_state, s.last_checked_at FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id = o.id WHERE o.customer_phone LIKE $1 ORDER BY o.created_at DESC LIMIT 5`, [`%${cleanInput.slice(-10)}`]);
    if (rows.length === 0) return res.json({ orders: [] });

    const ordersWithTracking = await Promise.all(rows.map(async (row) => {
      let tracking = null;
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];
      
      let currentState = row.last_state || "PROCESSING";
      
      // 🟢 FIX 2: Default to DISPATCHED (State 2) instead of IN_TRANSIT (State 3)
      // This ensures we don't show "In Transit" until the courier *actually* scans it.
      if (row.fulfillment_status === 'fulfilled' && row.awb) {
         currentState = "DISPATCHED";
      }
      
      if (row.db_delivered) currentState = "DELIVERED";

      if (row.awb) {
         history.push({ status: "Dispatched", date: "Processing", completed: true });
         
         const now = Date.now();
         // Aggressive Cache (15 mins) for active items
         const isFresh = row.last_checked_at && (now - new Date(row.last_checked_at).getTime() < 15 * 60 * 1000);

         if (!row.db_delivered && !isFresh) {
             if (row.courier_source === "bluedart") tracking = await trackBluedart(row.awb);
             else if (row.courier_source === "shiprocket") tracking = await trackShiprocket(row.awb);
             
             if (tracking) {
                 const resolvedState = resolveShipmentState(tracking.status);
                 await pool.query(`UPDATE shipments_ops SET delivered = $1, last_status = $2, last_state = $3, last_checked_at = NOW() WHERE awb = $4`, [tracking.delivered, tracking.status, resolvedState, row.awb]);
                 currentState = resolvedState;
             }
         }
         
         if (tracking && tracking.history) history = [...history, ...tracking.history];
      }

      if ((currentState === "DELIVERED") && !history.some(h=>h.status.toLowerCase().includes("delivered"))) {
         history.push({ status: "Delivered", date: "Package Delivered", completed: true });
      }

      history.sort((a,b) => new Date(a.date || 0) - new Date(b.date || 0));

      return {
        shopify_order_name: row.order_number,
        awb: row.awb || null,
        courier: row.courier_source || null,
        fulfillment_status: row.fulfillment_status,
        delivered: currentState === "DELIVERED",
        current_state: currentState,
        edd: tracking?.edd ? formatConfidenceBand(tracking.edd) : null,
        last_known_status: tracking?.status || row.last_status || "Order Placed",
        tracking_history: history
      };
    }));
    res.json({ orders: ordersWithTracking });
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

/* ===============================
   🛠️ OPS AWB ENDPOINT
================================ */
app.get("/ops/track/awb", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  try {
    const { rows } = await pool.query(`SELECT s.awb, s.courier_source, s.delivered, s.last_status, s.last_state, s.last_checked_at, o.order_number, o.customer_phone FROM shipments_ops s LEFT JOIN orders_ops o ON o.id = s.order_id WHERE s.awb = $1 LIMIT 1`, [awb]);
    if (!rows.length) return res.status(404).json({ error: "AWB not found" });

    const row = rows[0];
    let tracking = null;
    const now = Date.now();
    const isFresh = row.last_checked_at && (now - new Date(row.last_checked_at).getTime() < 15 * 60 * 1000);

    if (!row.delivered && !isFresh) {
      if (row.courier_source === "bluedart") tracking = await trackBluedart(awb);
      else if (row.courier_source === "shiprocket") tracking = await trackShiprocket(awb);
      
      if (tracking) {
        const resolvedState = resolveShipmentState(tracking.status);
        await pool.query(`UPDATE shipments_ops SET delivered=$1, last_status=$2, last_state=$3, last_checked_at=NOW() WHERE awb=$4`, [tracking.delivered, tracking.status, resolvedState, awb]);
        row.last_state = resolvedState;
        row.last_status = tracking.status;
      }
    }

    res.json({ awb: row.awb, current_state: row.last_state || "PROCESSING", last_status: tracking?.status || row.last_status, tracking_history: tracking?.history || [] });
  } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// ADMIN & WEBHOOKS
app.get("/admin/sync-shopify", async (req, res) => { if (!verifyAdmin(req)) return res.status(403).send("Unauthorized"); const r = await runBackfill(req.query.limit || 50); res.send(r.success ? `✅ Synced ${r.count} orders.` : `❌ Failed: ${r.error}`); });
app.get("/admin/export-csv", async (req, res) => { if (!verifyAdmin(req)) return res.status(403).send("Unauthorized"); try { const { rows } = await pool.query(`SELECT * FROM orders_ops LIMIT 1000`); if(!rows.length) return res.send("No Data"); const csv = [Object.keys(rows[0]).join(","), ...rows.map(r => Object.values(r).map(v => v ? `"${v}"` : "").join(","))].join("\n"); res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", `attachment; filename="ops_orders.csv"`); res.send(csv); } catch (e) { res.status(500).send("Error"); } });
app.get("/recon/ops", async (req, res) => { if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" }); try { const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE fulfillment_status='fulfilled') as d, COUNT(s.awb) FILTER (WHERE s.delivered=TRUE) as c FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id=o.id`); res.json({ summary: r.rows[0] }); } catch (e) { res.status(500).json({ error: e.message }); }});
app.post("/webhooks/orders_paid", async (req,res) => { res.sendStatus(200); if (!verifyShopify(req)) return; const o=req.body; try { await pool.query(`INSERT INTO orders_ops (id, order_number, financial_status, fulfillment_status, total_price, payment_gateway_names, customer_email, customer_phone, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET financial_status=EXCLUDED.financial_status, fulfillment_status=EXCLUDED.fulfillment_status, customer_phone=EXCLUDED.customer_phone`, [o.id, o.name, o.financial_status, o.fulfillment_status, o.total_price, JSON.stringify(o.payment_gateway_names||[]), o.email, o.phone||o.customer?.phone, o.created_at]); } catch(e){} });
app.post("/webhooks/fulfillments_create", async (req,res) => { res.sendStatus(200); if (!verifyShopify(req)) return; const f=req.body; if(f.tracking_number) try { await pool.query(`INSERT INTO shipments_ops (order_id, awb, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`,[f.order_id, f.tracking_number, f.tracking_company?.toLowerCase().includes("blue")?"bluedart":"shiprocket"]); } catch(e){} });
app.post("/edd",async(req,res)=>{res.json({edd_display:null});}); 
app.get("/health", (_,res)=>res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log("🚀 Ops Logistics running on",PORT));