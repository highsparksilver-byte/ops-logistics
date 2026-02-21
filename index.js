import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";
import cron from "node-cron"; // ✅ Ensure node-cron is imported

/* ===============================
   🚀 APP INIT & CONFIG
================================ */
const app = express();
const eddCache = new Map(); 
const rateLimiter = new Map();
axios.defaults.timeout = 25000;

// 🟢 Capture Raw Body for Webhook Verification
app.use(express.json({ 
  limit: "2mb", 
  verify: (req, res, buf) => { req.rawBody = buf.toString(); } 
}));

// 🟢 REVERTED TO GOLD STANDARD: Allows Shopify and Vercel to fetch EDD without CORS errors
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
  SHOPIFY_ACCESS_TOKEN, SHOP_NAME, SHOPIFY_API_VERSION
} = process.env;

const API_VER = clean(SHOPIFY_API_VERSION) || '2026-01';
const { Pool } = pg;

/* ===============================
   🛠️ DB MIGRATION
================================ */
const pool = new Pool({ 
  connectionString: DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

// Prevent app crash on idle client errors
pool.on('error', (err, client) => {
    console.error('❌ Unexpected error on idle client', err);
});

// Orders schema updates
pool.query(`
  ALTER TABLE orders_ops 
  ADD COLUMN IF NOT EXISTS shipping_address JSONB;
`).catch(e => console.log("Migration Note: " + e.message));

// API Usage Tracking Table (NEW)
pool.query(`
  CREATE TABLE IF NOT EXISTS api_usage_ops (
    log_date DATE DEFAULT CURRENT_DATE,
    provider VARCHAR(50),
    calls INT DEFAULT 1,
    PRIMARY KEY (log_date, provider)
  );
`).catch(e => console.log("API Table Setup Note: " + e.message));

/* ===============================
   🕒 DATE HELPERS
================================ */
function nowIST() {
  const d = new Date();
  return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
}

function getNextWorkingDate() {
  const d = nowIST();
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); 
  return `/Date(${d.getTime()})/`; 
}

/* ===============================
   📝 SYSTEM LOGGER & USAGE TRACKER
================================ */
async function logEvent(level, module, message, meta = {}) {
  const logMsg = `[${module}] ${message}`;
  if (level === 'ERROR') {
    console.error(`❌ ${logMsg}`, meta);
  } else {
    console.log(`✅ ${logMsg}`);
  }

  pool.query(
    `INSERT INTO system_logs (level, module, message, meta) VALUES ($1, $2, $3, $4)`,
    [level, module, message, JSON.stringify(meta)]
  ).catch(e => console.error("Logger Failed:", e.message));
}

// 📈 NEW: API Usage Counter
async function trackApiUsage(provider) {
  try {
    await pool.query(`
      INSERT INTO api_usage_ops (log_date, provider, calls) 
      VALUES (CURRENT_DATE, $1, 1) 
      ON CONFLICT (log_date, provider) 
      DO UPDATE SET calls = api_usage_ops.calls + 1
    `, [provider]);
  } catch (e) {
    console.error("Failed to track API usage:", e.message);
  }
}

/* ===============================
   🔐 SECURITY & HELPERS
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret || !req.rawBody) {
    logEvent('WARN', 'WEBHOOK', 'Skipped: No Secret or Body');
    return false;
  }
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  const received = req.headers["x-shopify-hmac-sha256"];
  if (digest === received) return true;
  logEvent('ERROR', 'WEBHOOK', 'Signature Mismatch', { expected: digest, received });
  return false;
}

function verifyAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.key;
  return key === clean(SHOPIFY_WEBHOOK_SECRET);
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimiter.has(ip)) { 
    rateLimiter.set(ip, { c: 1, t: now }); 
    return true; 
  }
  const r = rateLimiter.get(ip);
  if (now - r.t > 60000) { 
    r.c = 1; r.t = now; 
    return true; 
  }
  if (r.c >= 30) {
    logEvent('WARN', 'SECURITY', 'Rate Limit Exceeded', { ip });
    return false;
  }
  r.c++; 
  return true;
}

function resolveShipmentState(status = "", history = []) {
  let s = status.toUpperCase();
  
  // 🟢 SMART BACKEND: Dig into the latest scan history to catch hidden errors
  if (history && history.length > 0) {
      const latestScan = history[history.length - 1];
      if (latestScan && latestScan.status) {
          s += " " + latestScan.status.toUpperCase(); 
      }
  }

  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("RETURN") || s.includes("RTO")) return "RTO";
  if (s.includes("FAILED") || s.includes("UNDELIVERED") || s.includes("REFUSED") || s.includes("REJECTED") || s.includes("CANCEL")) return "NDR";
  if (s.includes("OUT FOR") || s.includes("OFD") || s.includes("DISPATCHED") || s.includes("IN TRANSIT") || s.includes("ARRIVED") || s.includes("PICKED") || s.includes("CONNECTED") || s.includes("SHIPPED")) return "IN_TRANSIT";
  return "PROCESSING";
}

function formatConfidenceBand(dStr) {
  if (!dStr) return null;
  const s = new Date(dStr); 
  if (isNaN(s.getTime())) return null;
  const e = new Date(s); 
  e.setDate(e.getDate() + 1);
  const f = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return `${f(s)} - ${f(e)}`;
}

/* ===============================
   📦 COURIER ENGINE
================================ */
let srJwt, srAt = 0, bdJwt, bdAt = 0;

async function getBluedartJwt() { 
  if (bdJwt && Date.now() - bdAt < 23 * 3600000) return bdJwt; 
  try {
    const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { 
      headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } 
    });
    bdJwt = r.data.JWTToken; 
    bdAt = Date.now(); 
    return bdJwt; 
  } catch (e) { 
    logEvent('ERROR', 'AUTH', 'BlueDart Auth Failed', { error: e.message }); 
    return null; 
  }
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srAt < 7 * 86400000) return srJwt;
  try {
    const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { 
      email: clean(SHIPROCKET_EMAIL), 
      password: clean(SHIPROCKET_PASSWORD) 
    });
    srJwt = r.data.token; 
    srAt = Date.now(); 
    return srJwt;
  } catch (e) { 
    logEvent('ERROR', 'AUTH', 'Shiprocket Auth Failed', { error: e.response?.data || e.message }); 
    return null; 
  }
}

const IGNORE_SCANS = ["BAGGED", "MANIFEST", "NETWORK", "RELIEF", "PARTIAL"];

// 🟢 UPGRADED: Detects Return Journeys and grabs the New AWB + API Usage tracking
async function trackBluedart(awb) {
  try {
    trackApiUsage('bluedart_tracking'); // 📈 Log API Usage

    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      params: { 
        handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), 
        awb: "awb", numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), 
        verno: 1, scan: 1 
      },
      responseType: "text"
    });
    
    if (!r.data || r.data.trim().startsWith("<html")) {
      return null;
    }
    
    const p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const shipments = p?.ShipmentData?.Shipment; 
    
    if (!shipments) return null;

    // Handle Array (RTO) vs Object (Normal)
    const fwd = Array.isArray(shipments) ? shipments[0] : shipments;
    const ret = Array.isArray(shipments) && shipments.length > 1 ? shipments[1] : null;

    const isFwdDelivered = fwd.Status?.toUpperCase().includes("DELIVERED");
    const isRetDelivered = ret ? ret.Status?.toUpperCase().includes("DELIVERED") : false;

    // The AWB is truly "Done" if it reached the customer OR it reached the warehouse safely.
    const isFinallyDone = isFwdDelivered || isRetDelivered;

    // Create a smart compound status for the Google Sheet to read
    let finalStatus = fwd.Status;
    if (ret) {
        const retAwb = ret.$?.WaybillNo || ret.WaybillNo || 'UNKNOWN';
        finalStatus = `RTO | RET AWB: ${retAwb} | STATUS: ${ret.Status}`;
    }

    const rawScans = Array.isArray(fwd.Scans?.ScanDetail) ? fwd.Scans.ScanDetail : [fwd.Scans?.ScanDetail];
    let allScans = rawScans;
    
    // Combine return scans into the history log so customers can see it travelling back
    if (ret && Array.isArray(ret.Scans?.ScanDetail)) {
        allScans = [...ret.Scans.ScanDetail, ...allScans]; 
    }

    const scans = allScans.filter(x => {
      if (!x?.Scan) return false;
      if (isFinallyDone) return true; 
      return !IGNORE_SCANS.some(k => x.Scan.toUpperCase().includes(k));
    });

    return { 
      status: finalStatus, 
      delivered: isFinallyDone, // Automatically stops the watchdog loop!
      history: scans.map(x => {
        const date = x.ScanDate ? x.ScanDate.trim() : "";
        const time = x.ScanTime ? x.ScanTime.trim() : "00:00";
        return { 
          status: x.Scan, 
          date: (date && time) ? `${date} ${time}` : new Date().toDateString(), 
          location: x.ScannedLocation 
        };
      }),
      raw: p 
    };
  } catch (e) { 
    logEvent('ERROR', 'TRACKING', `BlueDart Exception`, { awb, error: e.message }); 
    return null; 
  }
}

async function trackShiprocket(awb) {
  try {
    trackApiUsage('shiprocket_tracking'); // 📈 Log API Usage

    const t = await getShiprocketJwt();
    if (!t) return null;
    
    // We expect 200 OK, but Shiprocket sends 500/404 for cancelled AWBs sometimes
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { 
      headers: { Authorization: `Bearer ${t}` },
      validateStatus: (status) => status < 600 
    });

    // 🛡️ SPECIFIC FIX FOR "AWB CANCELLED"
    const errorMsg = r.data?.message || JSON.stringify(r.data);
    if (errorMsg.includes("cancelled") || errorMsg.includes("canceled")) {
      return { status: "CANCELLED", delivered: false, history: [], raw: r.data };
    }

    const d = r.data?.tracking_data; 
    if (!d) { 
        logEvent('WARN', 'TRACKING', `Shiprocket Empty/Error`, { awb, response: r.data }); 
        return null; 
    }
    
    const status = d.current_status || d.shipment_track?.[0]?.current_status || "";

    return { 
      status: status, 
      delivered: status.toUpperCase().includes("DELIVERED"), 
      history: (d.shipment_track_activities || []).map(x => ({ 
        status: x.activity, 
        date: x.date, 
        location: x.location 
      })), 
      raw: d 
    };
  } catch (e) { 
    const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    logEvent('ERROR', 'TRACKING', `Shiprocket API Error`, { awb, error: errMsg }); 
    return null; 
  }
}

async function getCity(p){
  try{
    const r=await axios.get(`https://api.postalpincode.in/pincode/${p}`);
    return r.data?.[0]?.PostOffice?.[0]?.District||null;
  }catch{
    return null;
  }
}

// 🟢 RESTORED TO GOLD STANDARD: Exactly matches BlueDart's strict WCF /Date(ms)/ format
async function predictBluedartEDD(p) {
  try {
    const j = await getBluedartJwt();
    if (!j) return null;

    const pickupDateStr = getNextWorkingDate();
    
    const r = await axios.post("https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct", {
      pPinCodeFrom: "411022",
      pPinCodeTo: p,
      pProductCode: "A",
      pSubProductCode: "P",
      pPudate: pickupDateStr, 
      pPickupTime: "16:00", 
      profile: { Api_type: "S", LicenceKey: clean(BD_LICENCE_KEY_EDD), LoginID: clean(LOGIN_ID) }
    }, { headers: { JWTToken: j } });
    
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch (e) { 
    logEvent('ERROR', 'EDD', `BlueDart EDD API Failed`, { error: e.message });
    return null; 
  }
}

async function predictShiprocketEDD(p){
  try{
    const t=await getShiprocketJwt();
    if(!t)return null;
    const r=await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${p}&cod=1&weight=0.5`,{
      headers:{Authorization:`Bearer ${t}`}
    });
    return r.data?.data?.available_courier_companies?.[0]?.etd||null;
  }catch{
    return null;
  }
}

/* ===============================
   🔄 SYNC & BACKGROUND
================================ */
async function syncOrder(o) {
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || null;
  
  // 🟢 FIX: If Shopify has a cancelled_at date, forcefully lock the status to 'cancelled'
  const actualFinancialStatus = o.cancelled_at ? 'cancelled' : o.financial_status;
  
  try {
    await pool.query(`
      INSERT INTO orders_ops (
        id, order_number, financial_status, fulfillment_status, total_price, 
        payment_gateway_names, customer_name, customer_email, customer_phone, 
        city, shipping_address, line_items, is_exchange, is_return, source, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::boolean, $14::boolean, $15, $16)
      ON CONFLICT (id) DO UPDATE SET 
        financial_status = EXCLUDED.financial_status, 
        fulfillment_status = EXCLUDED.fulfillment_status, 
        customer_phone = EXCLUDED.customer_phone, 
        shipping_address = EXCLUDED.shipping_address, 
        city = EXCLUDED.city
    `, [
      String(o.id), 
      o.name, 
      actualFinancialStatus, // 🟢 USING THE LOCKED STATUS HERE
      o.fulfillment_status, 
      o.total_price, 
      JSON.stringify(o.payment_gateway_names || []), 
      `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim(), 
      o.email || o.customer?.email, 
      phone, 
      o.shipping_address?.city, 
      JSON.stringify(o.shipping_address || {}), 
      JSON.stringify(o.line_items || []), 
      o.name?.startsWith("EX-") || false, 
      o.name?.includes("-R") || false, 
      "shopify", 
      o.created_at
    ]);
    
    if (o.fulfillments) {
      for (const f of o.fulfillments) {
        if (f.tracking_number) {
          await pool.query(
            `INSERT INTO shipments_ops (awb, order_id, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`, 
            [f.tracking_number, String(o.id), f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket"]
          );
        }
      }
    }
  } catch (e) { 
    logEvent('ERROR', 'SYNC', `Order Sync Failed: ${o.name}`, { error: e.message }); 
  }
}

async function updateStaleShipments() {
  try {
    const { rows } = await pool.query(`
      SELECT awb, courier_source 
      FROM shipments_ops 
      -- 🟢 THE FIX: Catch both FALSE and NULL statuses
      WHERE (delivered = FALSE OR delivered IS NULL) 
      AND (last_status IS NULL OR last_status NOT LIKE '%CANCEL%')
      AND (
        (COALESCE(last_state, '') != 'RTO' AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '30 minutes'))
        OR 
        (last_state = 'RTO' AND last_checked_at < NOW() - INTERVAL '24 hours')
      )
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT 50
    `);
    
    if (rows.length > 0) logEvent('INFO', 'WATCHDOG', `Checking ${rows.length} stale orders...`);

    for (const r of rows) {
      const t = r.courier_source === "bluedart" ? await trackBluedart(r.awb) : await trackShiprocket(r.awb);
      
      if (t) {
        await pool.query(`
          UPDATE shipments_ops 
          SET delivered=$1, last_status=$2, last_state=$3, history=$4::jsonb, raw_data=$5::jsonb, last_checked_at=NOW() 
          WHERE awb=$6`, 
        [t.delivered, t.status, resolveShipmentState(t.status, t.history), JSON.stringify(t.history || []), JSON.stringify(t.raw || {}), r.awb]);
      } else {
        await pool.query(`UPDATE shipments_ops SET last_checked_at=NOW() WHERE awb=$1`, [r.awb]);
      }
      
      await new Promise(res => setTimeout(res, 2000));
    }
  } catch (e) { 
    logEvent('ERROR', 'SYNC', 'Stale Update Loop Failed', { error: e.message }); 
  }
}

async function runBackfill() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) return;
  
  try {
    const r = await axios.get(`https://${clean(SHOP_NAME)}.myshopify.com/admin/api/${API_VER}/orders.json?status=any&limit=50`, { 
      headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) } 
    });
    
    for (const o of r.data.orders || []) {
      await syncOrder(o);
    }
    
    logEvent('INFO', 'BACKFILL', `Backfilled ${r.data.orders.length} orders`);
  } catch (e) { 
    logEvent('ERROR', 'BACKFILL', 'Backfill Failed', { error: e.message }); 
  }
}

// 🟢 NEW: SAFETY NET (CATCH MISSED CANCELLATIONS)
async function runSafetyNet() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) return;
  
  // Calculate date 10 days ago
  const d = new Date();
  d.setDate(d.getDate() - 10);
  const minDate = d.toISOString();
  
  try {
    logEvent('INFO', 'SAFETY_NET', `Scanning orders updated since ${minDate}...`);
    
    const url = `https://${clean(SHOP_NAME)}.myshopify.com/admin/api/${API_VER}/orders.json?status=any&limit=250&updated_at_min=${minDate}`;
    const r = await axios.get(url, { 
      headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) } 
    });
    
    const orders = r.data.orders || [];
    for (const o of orders) {
      await syncOrder(o);
    }
    
    logEvent('INFO', 'SAFETY_NET', `Safety Sync Complete: Updated ${orders.length} orders.`);
  } catch (e) {
    logEvent('ERROR', 'SAFETY_NET', 'Safety Net Failed', { error: e.message });
  }
}

// ⏲️ CRON SCHEDULES
setTimeout(runBackfill, 5000); // Run once on startup

// 1. Watchdog ONLY (Every 10 mins) - Backfill removed to save Shopify API
setInterval(() => { 
  updateStaleShipments(); 
}, 10 * 60 * 1000);

// 2. Safety Net: Every 12 Hours (0 */12 * * *)
cron.schedule('0 */12 * * *', async () => {
    await runSafetyNet();
});

// 3. Clear EDD Cache Daily at 14:10 IST
cron.schedule('10 14 * * *', () => {
    console.log("🧹 Clearing EDD Cache...");
    eddCache.clear();
    logEvent('INFO', 'CACHE', 'EDD Cache cleared automatically at 14:10');
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" 
});

/* ===============================
   ⚡️ INSTANT SYNC HELPER
================================ */
async function forceRefreshShipment(awb, courier) {
  if (!awb) return null;
  
  const t = courier === "bluedart" ? await trackBluedart(awb) : await trackShiprocket(awb);
  
  if (t) {
    logEvent('INFO', 'TRACKING', `Live Refreshed ${awb}`, { status: t.status });
    
    await pool.query(`
      UPDATE shipments_ops 
      SET delivered=$1, last_status=$2, last_state=$3, history=$4::jsonb, raw_data=$5::jsonb, last_checked_at=NOW() 
      WHERE awb=$6
    `, [t.delivered, t.status, resolveShipmentState(t.status, t.history), JSON.stringify(t.history || []), JSON.stringify(t.raw || {}), awb]);
  } else {
    logEvent('WARN', 'TRACKING', `Live Refresh Failed`, { awb, courier });
  }
  return t;
}

/* ===============================
   🔔 WEBHOOKS
================================ */
app.post("/webhooks/orders_paid", (req, res) => { 
  res.sendStatus(200); 
  
  if (verifyShopify(req)) {
    logEvent('INFO', 'WEBHOOK', `Order Paid: ${req.body.name}`);
    syncOrder(req.body); 
  }
});

app.post("/webhooks/fulfillments_create", async (req, res) => {
  res.sendStatus(200); 
  
  if (!verifyShopify(req) || !req.body.tracking_number) return;
  
  const courier = req.body.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  logEvent('INFO', 'WEBHOOK', `Fulfillment: ${req.body.tracking_number} (${courier})`);
  
  await pool.query(
    `INSERT INTO shipments_ops (awb, order_id, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`, 
    [req.body.tracking_number, String(req.body.order_id), courier]
  );
});

app.post("/webhooks/orders_cancelled", async (req, res) => {
  res.sendStatus(200);
  
  if (verifyShopify(req)) {
    logEvent('INFO', 'WEBHOOK', `Order Cancelled: ${req.body.name}`);
    await pool.query(
      `UPDATE orders_ops SET financial_status = 'cancelled' WHERE id = $1::text`, 
      [String(req.body.id)]
    );
  }
});

app.post("/webhooks/returnprime", async (req, res) => {
  res.sendStatus(200); 
  const e = req.body;
  if (!e.id || !e.order_number) return;
  
  logEvent('INFO', 'WEBHOOK', `Return Update: ${e.order_number}`, { status: e.status });
  
  await pool.query(
    `INSERT INTO returns_ops (return_id, order_number, status, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (return_id) DO UPDATE SET status=EXCLUDED.status, updated_at=NOW()`, 
    [String(e.id), e.order_number, e.status || "created"]
  );
});

/* ===============================
   🔍 CUSTOMER ENDPOINT (HYBRID LIVE)
================================ */
app.post("/track/customer", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests" });
  }
  
  const input = req.body?.tracking_id || req.body?.awb || req.body?.phone; 
  if (!input) {
    return res.status(400).json({ error: "Tracking ID required" });
  }

  try {
    const cleanInput = input.toString().trim().replace(/[^a-zA-Z0-9-]/g, ""); 
    const phoneMatch = cleanInput.replace(/\D/g, "").slice(-10);
    const phoneQuery = phoneMatch.length >= 10 ? `%${phoneMatch}%` : 'NO_MATCH';

    const { rows } = await pool.query(`
      SELECT o.order_number, o.created_at, o.fulfillment_status, o.financial_status,
             s.awb, s.courier_source, s.last_state, s.last_status, s.history as db_history, s.last_checked_at 
      FROM orders_ops o 
      LEFT JOIN shipments_ops s ON s.order_id::text = o.id::text 
      WHERE o.customer_phone::text LIKE $1 
         OR s.awb ILIKE $2
      ORDER BY o.created_at DESC 
      LIMIT 5
    `, [phoneQuery, cleanInput]);

   const promises = rows.map(async (row) => {
      if (!row.awb || row.last_state === 'DELIVERED') return row; 
      
      const lastCheck = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
      
      // 🟢 THE FIX: Increased cooldown to 30 mins (30 * 60 * 1000) & blocked TEST/fake AWBs
      const isTestAwb = row.awb.toUpperCase().includes('TEST') || row.awb.length < 5;
      
      if (!isTestAwb && Date.now() - lastCheck > 30 * 60 * 1000) { 
        const fresh = await forceRefreshShipment(row.awb, row.courier_source);
        if (fresh) {
           row.last_state = resolveShipmentState(fresh.status, fresh.history);
           row.last_status = fresh.status;
           row.db_history = fresh.history;
        }
      }
      return row;
    });

    const refreshedRows = await Promise.all(promises);
    
    const results = refreshedRows.map((row) => {
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];
      
      if (row.fulfillment_status === 'fulfilled') {
        history.push({ status: "Dispatched", date: "Order Packed", completed: true });
      }
      
      if (Array.isArray(row.db_history)) {
        history = [...history, ...row.db_history];
      }

      let currentState = row.last_state || (row.fulfillment_status === 'fulfilled' ? "IN_TRANSIT" : "PROCESSING");
      
      // 🟢 FIX: Multi-layer check for cancelled orders (Now includes 'refunded')
      const isCancelled = 
        row.financial_status === 'cancelled' || 
        row.financial_status === 'voided' || 
        row.financial_status === 'refunded' || 
        (row.last_status && row.last_status.toUpperCase().includes('CANCEL'));

      if (isCancelled) {
          currentState = "CANCELLED";
      }

      return { 
          shopify_order_name: row.order_number, 
          awb: row.awb, 
          current_state: currentState, 
          courier: row.courier_source, 
          last_known_status: row.last_status || "Shipment information will be updated shortly", 
          tracking_history: history 
      };
    });
    
    res.json({ orders: results });
  } catch (e) { 
    logEvent('ERROR', 'TRACKING', 'Customer Track Error', { error: e.message });
    res.status(500).json({ error: "Server error" }); 
  }
});

/* ===============================
   ✅ PAGINATED ORDERS ENDPOINT
================================ */
app.get("/ops/orders", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const query = `
      SELECT 
        o.id,
        o.order_number,
        o.created_at,
        o.financial_status,
        o.fulfillment_status,
        o.total_price,
        o.payment_gateway_names,
        o.line_items,
        o.is_exchange,
        o.is_return,
        o.source,
        
        -- Smart Customer Info
        COALESCE(o.customer_name, s.raw_data->'shipment_track'->0->>'consignee_name', 'Guest') as customer_name,
        COALESCE(o.customer_email, s.raw_data->'shipment_track'->0->>'email') as customer_email,
        COALESCE(o.customer_phone, s.raw_data->'shipment_track'->0->>'mobile') as customer_phone,
        
        -- Address Logic
        COALESCE(o.city, s.raw_data->'shipment_track'->0->>'destination') as city,
        COALESCE(
            CONCAT(o.shipping_address->>'address1', ', ', o.shipping_address->>'address2', ', ', o.shipping_address->>'city', ' - ', o.shipping_address->>'zip'),
            CONCAT(s.raw_data->'shipment_track'->0->>'destination', ' ', s.raw_data->'shipment_track'->0->>'location'),
            o.city
        ) as full_address,

        -- Shipment Core
        s.awb, 
        s.courier_source,
        s.last_state, 
        s.last_status,
        
        -- Dates
        s.raw_data->'shipment_track'->0->>'delivered_date' as delivered_date,
        s.raw_data->'shipment_track'->0->>'edd' as expected_delivery_date,

        -- NDR Parsing
        (
          SELECT activity 
          FROM jsonb_to_recordset(
            CASE 
              WHEN jsonb_typeof(s.raw_data->'shipment_track_activities') = 'array' 
              THEN s.raw_data->'shipment_track_activities' 
              ELSE '[]'::jsonb 
            END
          ) as x(activity text, "sr-status" text)
          WHERE "sr-status" IN ('6', '13', '14', '19', '20', '21', '53', '54', '55', '56') 
          LIMIT 1
        ) as ndr_reason,

        r.status AS return_status 

      FROM orders_ops o 
      LEFT JOIN shipments_ops s ON s.order_id::text = o.id::text 
      LEFT JOIN returns_ops r ON r.order_number::text = o.order_number::text 
      ORDER BY o.created_at DESC 
      LIMIT $1 OFFSET $2
    `;

    const { rows } = await pool.query(query, [limit, offset]);
    const countRes = await pool.query(`SELECT COUNT(*) FROM orders_ops`);

    res.json({ 
      orders: rows,
      pagination: {
        total: parseInt(countRes.rows[0].count),
        page,
        totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limit)
      }
    });

  } catch (e) { 
    console.error(e); 
    res.status(500).json({ error: "Db Error: " + e.message }); 
  }
});

/* ===============================
   🚀 FORCE SINGLE AWB
================================ */
app.get("/admin/force-single", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB Required" });

  try {
    // Find courier source first
    const r = await pool.query("SELECT courier_source FROM shipments_ops WHERE awb=$1", [awb]);
    if (r.rows.length === 0) return res.status(404).json({ error: "AWB not in DB" });

    const result = await forceRefreshShipment(awb, r.rows[0].courier_source);
    res.json({ success: !!result, data: result });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

/* ===============================
   🔍 DATABASE X-RAY (DEBUG TOOL)
================================ */
app.get("/admin/debug-awb", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB Required" });

  try {
    const { rows } = await pool.query(`
      SELECT 
        awb, 
        order_id, 
        courier_source, 
        delivered, 
        last_status, 
        last_state, 
        last_checked_at 
      FROM shipments_ops 
      WHERE awb = $1
    `, [awb]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "AWB not found in database at all!" });
    }

    res.json({ 
      message: "Here is the exact data sitting in PostgreSQL:",
      db_row: rows[0] 
    });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

/* ===============================
   🚀 DEEP SYNC
================================ */
app.get("/admin/deep-sync", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  try {
    const d = new Date();
    d.setDate(d.getDate() - 20); // Sync last 20 days
    const minDate = d.toISOString();

    logEvent('INFO', 'DEEP_SYNC', `Starting Deep Sync from ${minDate}...`);

    let url = `https://${clean(SHOP_NAME)}.myshopify.com/admin/api/${API_VER}/orders.json?status=any&limit=250&updated_at_min=${minDate}`;
    let totalSynced = 0;

    // 🟢 PAGINATION LOOP: Keep fetching until we hit 1000 or run out
    while (url && totalSynced < 1000) {
       const r = await axios.get(url, { 
         headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) } 
       });
       
       const orders = r.data.orders || [];
       if (orders.length === 0) break;

       for (const o of orders) {
         await syncOrder(o);
       }
       
       totalSynced += orders.length;
       
       // 🟢 CHECK FOR NEXT PAGE (Cursor Pagination)
       const linkHeader = r.headers.link || r.headers['link']; 
       if (linkHeader && linkHeader.includes('rel="next"')) {
           const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
           url = match ? match[1] : null;
       } else {
           url = null; // No more pages
       }
    }

    logEvent('INFO', 'DEEP_SYNC', `Deep Sync Complete. Total Orders: ${totalSynced}`);
    res.json({ success: true, count: totalSynced, message: `Synced ${totalSynced} orders.` });

  } catch (e) {
    logEvent('ERROR', 'DEEP_SYNC', 'Failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

/* ===============================
   🚀 LOGISTICS REFRESHER (BACKGROUND BATCH)
================================ */
app.get("/ops/refresh-logistics", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  res.json({ message: "🚀 Background mass-refresh started! Processing up to 500 packages. Please check your sheet in about 15 minutes." });

  (async () => {
    try {
      const { rows } = await pool.query(`
        SELECT awb, courier_source 
        FROM shipments_ops 
        -- 🟢 THE FIX: Ensure the manual sweeper also catches NULLs
        WHERE (delivered = FALSE OR delivered IS NULL) 
        ORDER BY last_checked_at ASC NULLS FIRST
        LIMIT 500
      `);

      logEvent('INFO', 'RECOVERY', `Background sweep started for ${rows.length} stuck shipments.`);

      for (const r of rows) {
        await forceRefreshShipment(r.awb, r.courier_source);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      logEvent('INFO', 'RECOVERY', `✅ Background sweep finished successfully!`);
    } catch (e) {
      logEvent('ERROR', 'RECOVERY', 'Background sweep crashed', { error: e.message });
    }
  })(); 
});

/* ===============================
   📊 ADMIN DASHBOARD & LOGS
================================ */
app.get("/ops/logs", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 50`);
    res.json({ logs: rows });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.get("/recon/ops", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE is_exchange=FALSE AND is_return=FALSE) AS net_new_orders, 
        COUNT(*) FILTER (WHERE is_return=TRUE) AS total_returns, 
        COUNT(*) FILTER (WHERE financial_status!='paid' AND fulfillment_status='fulfilled') AS cod_at_risk 
      FROM orders_ops 
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    res.json({ summary: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/ops/api-usage", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`
      SELECT log_date, provider, calls 
      FROM api_usage_ops 
      WHERE log_date >= CURRENT_DATE - INTERVAL '14 days'
      ORDER BY log_date DESC, provider ASC
    `);
    res.json({ usage: rows });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

/* ===============================
   🚚 EDD ENDPOINT (FINAL PRODUCTION VERSION)
================================ */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^\d{6}$/.test(pincode)) return res.json({ edd_display: null });
  
  if (eddCache.has(pincode)) return res.json(eddCache.get(pincode));

  const city = await getCity(pincode);
  
  // 🟢 PRIMARY: Try BlueDart
  let rawDate = await predictBluedartEDD(pincode);
  let source = "BlueDart"; 

  // 🟢 SECONDARY: Fallback to Shiprocket ONLY if BlueDart fails
  if (!rawDate) {
    rawDate = await predictShiprocketEDD(pincode);
    source = "Shiprocket";
  }
  
  if (!rawDate) return res.json({ edd_display: null });
  
  const data = { 
    edd_display: formatConfidenceBand(rawDate), 
    city, 
    badge: city && ["MUMBAI","DELHI","BANGALORE","PUNE"].some(m=>city.toUpperCase().includes(m)) ? "METRO_EXPRESS" : "EXPRESS",
    source: source 
  };
  
  eddCache.set(pincode, data);
  res.json(data);
});

// 🧹 CLEANUP: Clear Rate Limiter every hour to prevent memory leaks
setInterval(() => { 
  rateLimiter.clear(); 
}, 60 * 60 * 1000);

app.get("/health", (_, res) => res.send("READY"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 HighSpark Logistics Master LIVE", PORT));