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
   🔄 SELF-HEALING SYNC
================================ */
async function runBackfill(limit = 50) {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) {
    console.log("⚠️ Sync Skipped: Missing API Config");
    return { success: false, message: "Missing Config" };
  }

  if (limit > 100) limit = 100;

  console.log(`🔄 Running Auto-Sync (Last ${limit} Orders)...`);
  try {
    const r = await axios.get(`https://${clean(SHOP_NAME)}.myshopify.com/admin/api/2023-10/orders.json?status=any&limit=${limit}`, {
      headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) }
    });

    const orders = r.data.orders || [];
    let savedCount = 0;
    let awbCount = 0;

    for (const o of orders) {
      const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || "";
      const email = o.email || o.customer?.email || o.contact_email;
      
      await pool.query(`
        INSERT INTO orders_ops (
          id, order_number, financial_status, fulfillment_status, 
          total_price, payment_gateway_names, customer_email, customer_phone, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET
          financial_status = EXCLUDED.financial_status,
          fulfillment_status = EXCLUDED.fulfillment_status,
          customer_phone = EXCLUDED.customer_phone
      `, [o.id, o.name, o.financial_status, o.fulfillment_status, o.total_price, JSON.stringify(o.payment_gateway_names || []), email, phone, o.created_at]);
      
      savedCount++;

      if (o.fulfillments && o.fulfillments.length > 0) {
        for (const f of o.fulfillments) {
          if (!f.tracking_number) continue;
          const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
          await pool.query(`
            INSERT INTO shipments_ops (order_id, awb, courier_source)
            VALUES ($1,$2,$3)
            ON CONFLICT (awb) DO NOTHING
          `, [o.id, f.tracking_number, courier]);
          awbCount++;
        }
      }
    }
    
    console.log(`✅ Sync Complete: ${savedCount} Orders, ${awbCount} Shipments Saved`);
    return { success: true, orders: savedCount, shipments: awbCount };
  } catch (e) {
    console.error("❌ Sync Failed:", e.message);
    return { success: false, error: e.message };
  }
}

// ⏰ CRON SCHEDULE
setInterval(() => { runBackfill(50); }, 30 * 60 * 1000);
setTimeout(() => { runBackfill(50); }, 5000);

/* ===============================
   📦 TRACKING CORE
================================ */
function getStatusType(s = "") { s = s.toUpperCase(); if (s.includes("DELIVERED")) return "DL"; if (s.includes("RTO") || s.includes("RETURN")) return "RT"; if (s.includes("OUT FOR")) return "OF"; return "UD"; }
function formatConfidenceBand(dStr) { if (!dStr) return null; const s = new Date(dStr); if (isNaN(s.getTime())) return null; const e = new Date(s); e.setDate(e.getDate() + 1); const f = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); return `${f(s)} - ${f(e)}`; }

async function trackBluedart(awb) { try { const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", { params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: "awb", numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 }, responseType: "text" }); if (r.data.includes("<html")) return null; const p = await xml2js.parseStringPromise(r.data, { explicitArray: false }); const s = p?.ShipmentData?.Shipment; if (!s) return null; const h = (Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail]).filter(Boolean).map(x => ({ status: x.Scan, date: `${x.ScanDate} ${x.ScanTime}`, location: x.ScannedLocation, completed: true })); return { source: "bluedart", status: s.Status, statusType: getStatusType(s.Status), delivered: getStatusType(s.Status) === "DL", edd: s.ExpectedDateDelivery, history: h }; } catch { return null; } }
async function trackShiprocket(awb) { try { const t = await getShiprocketJwt(); const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } }); const d = r.data?.tracking_data; if (!d) return null; const h = (d.shipment_track_activities || []).map(x => ({ status: x.activity, date: x.date, location: x.location, completed: true })); return { source: "shiprocket", status: d.current_status, statusType: getStatusType(d.current_status), delivered: getStatusType(d.current_status) === "DL", edd: d.etd, history: h }; } catch { return null; } }

/* ===============================
   🔍 CUSTOMER ENDPOINT
================================ */
app.post("/track/customer", async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const { phone } = req.body;
  const cleanInput = phone?.replace(/[^0-9]/g, "").trim(); 
  if (!cleanInput || cleanInput.length < 10) return res.status(400).json({ error: "Invalid phone" });

  try {
    const { rows } = await pool.query(`SELECT o.order_number, o.fulfillment_status, s.awb, s.courier_source, o.created_at, s.delivered as db_delivered, s.last_status, s.last_checked_at FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id = o.id WHERE o.customer_phone LIKE $1 ORDER BY o.created_at DESC LIMIT 5`, [`%${cleanInput.slice(-10)}`]);
    if (rows.length === 0) return res.json({ orders: [] });

    const ordersWithTracking = await Promise.all(rows.map(async (row) => {
      let tracking = null;
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];

      if (row.awb) {
         history.push({ status: "Dispatched", date: "Processing", completed: true });
         const now = Date.now();
         const isFresh = row.last_checked_at && (now - new Date(row.last_checked_at).getTime() < 30 * 60 * 1000);

         if (row.db_delivered) {
             tracking = { delivered: true, status: row.last_status || "Delivered", history: [] };
         } else if (isFresh && row.last_status) {
             tracking = { delivered: false, status: row.last_status, history: [] };
         } else {
             if (row.courier_source === "bluedart") tracking = await trackBluedart(row.awb);
             else if (row.courier_source === "shiprocket") tracking = await trackShiprocket(row.awb);
             
             if (tracking) {
                 await pool.query(`UPDATE shipments_ops SET delivered = $1, last_status = $2, last_checked_at = NOW() WHERE awb = $3`, [tracking.delivered, tracking.status, row.awb]);
             }
         }
         if (tracking && tracking.history) history = [...history, ...tracking.history];
      }

      if ((tracking?.delivered || row.db_delivered) && !history.some(h=>h.status.toLowerCase().includes("delivered"))) {
         history.push({ status: "Delivered", date: "Delivered", completed: true });
      }

      return {
        shopify_order_name: row.order_number,
        awb: row.awb || null,
        courier: row.courier_source || null,
        fulfillment_status: row.fulfillment_status,
        delivered: tracking?.delivered || row.db_delivered,
        edd: tracking?.edd ? formatConfidenceBand(tracking.edd) : null,
        last_known_status: tracking?.status || row.last_status || "Order Placed",
        tracking_history: history
      };
    }));
    res.json({ orders: ordersWithTracking });
  } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

/* ===============================
   🛠️ ADMIN ROUTES
================================ */
app.get("/admin/sync-shopify", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).send("Unauthorized");
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const result = await runBackfill(limit);
  res.send(result.success ? `✅ Synced ${result.orders} orders & ${result.shipments} shipments.` : `❌ Failed: ${result.error}`);
});

app.get("/admin/export-csv", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).send("Unauthorized");
  try {
    const { rows } = await pool.query(`SELECT o.order_number, o.customer_phone, o.created_at, o.fulfillment_status, s.awb, s.delivered FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id = o.id ORDER BY o.created_at DESC LIMIT 1000`);
    
    // --- 🛡️ EMPTY DB GUARD (Friend's Fix) ---
    if (!rows.length) return res.send("No data");
    
    const csv = [Object.keys(rows[0]).join(","), ...rows.map(r => Object.values(r).map(v => v ? `"${v}"` : "").join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="ops_orders.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).send("Export Failed"); }
});

app.get("/recon/ops", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const [counts, stuck] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE fulfillment_status = 'fulfilled') as dispatched, COUNT(*) FILTER (WHERE fulfillment_status IS NULL) as pending_dispatch, COUNT(s.awb) FILTER (WHERE s.delivered = TRUE) as delivered FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id = o.id WHERE o.created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT o.order_number, s.awb, o.created_at, s.last_status FROM orders_ops o JOIN shipments_ops s ON s.order_id = o.id WHERE o.created_at < NOW() - INTERVAL '5 days' AND o.created_at > NOW() - INTERVAL '30 days' AND (s.delivered = FALSE OR s.delivered IS NULL) AND (s.last_checked_at < NOW() - INTERVAL '24 hours' OR s.last_checked_at IS NULL) LIMIT 20`)
    ]);
    res.json({ summary_30_days: counts.rows[0], attention_needed: stuck.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ===============================
   🧾 WEBHOOKS
================================ */
app.post("/webhooks/orders_paid", async (req,res) => {
  res.sendStatus(200); if (!verifyShopify(req)) return;
  const o = req.body;
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || "";
  try { await pool.query(`INSERT INTO orders_ops (id, order_number, financial_status, fulfillment_status, total_price, payment_gateway_names, customer_email, customer_phone, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET financial_status=EXCLUDED.financial_status, fulfillment_status=EXCLUDED.fulfillment_status, customer_phone=EXCLUDED.customer_phone`, [o.id, o.name, o.financial_status, o.fulfillment_status, o.total_price, JSON.stringify(o.payment_gateway_names || []), o.email, phone, o.created_at]); } catch (e) { console.error("DB Error:", e.message); }
});

app.post("/webhooks/fulfillments_create", async (req,res) => {
  res.sendStatus(200); if (!verifyShopify(req)) return;
  const f = req.body;
  const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  if(f.tracking_number) try { await pool.query(`INSERT INTO shipments_ops (order_id, awb, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`,[f.order_id, f.tracking_number, courier]); } catch (e) { console.error("DB Error:", e.message); }
});

// EDD & HEALTH
async function getCity(p){try{const r=await axios.get(`https://api.postalpincode.in/pincode/${p}`);return r.data?.[0]?.PostOffice?.[0]?.District||null}catch{return null}}
async function getBluedartEDD(p){try{const j=await getBluedartJwt();const r=await axios.post("https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",{pPinCodeFrom:"411022",pPinCodeTo:p,pProductCode:"A",pSubProductCode:"P",pPudate:new Date(new Date().getTime()+(330+new Date().getTimezoneOffset())*60000).toISOString(),pPickupTime:"16:00",profile:{Api_type:"S",LicenceKey:clean(BD_LICENCE_KEY_EDD),LoginID:clean(LOGIN_ID)}},{headers:{JWTToken:j}});return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery||null}catch{return null}}
async function getShiprocketEDD(p){try{const t=await getShiprocketJwt();const r=await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${p}&cod=1&weight=0.5`,{headers:{Authorization:`Bearer ${t}`}});return r.data?.data?.available_courier_companies?.[0]?.etd||null}catch{return null}}
app.post("/edd",async(req,res)=>{const{pincode}=req.body;if(!/^[0-9]{6}$/.test(pincode))return res.json({edd_display:null});const c=await getCity(pincode),f=await getBluedartEDD(pincode)||await getShiprocketEDD(pincode);if(!f)return res.json({edd_display:null});res.json({edd_display:formatConfidenceBand(f),city:c,badge:c&&["MUMBAI","DELHI","BANGALORE","PUNE"].some(m=>c.toUpperCase().includes(m))?"METRO_EXPRESS":"EXPRESS"})});
app.get("/health", (_,res)=>res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log("🚀 Ops Logistics running on",PORT));