import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT & CONFIG
================================ */
const app = express();
const eddCache = new Map(); // ✅ Cache Init
const rateLimiter = new Map();
axios.defaults.timeout = 25000;

// 🟢 Capture Raw Body for Webhook Verification
app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));

app.use((req, res, next) => {
  const allowedOrigins = [
    "https://ops-dashboard-3c9eyrxoa-highsparksilver-1315s-projects.vercel.app", 
    "http://localhost:3000"
  ];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  
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
   🛠️ DB MIGRATION (Auto-Add Address Col)
================================ */
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Run this once on startup to fix the table structure
pool.query(`
  ALTER TABLE orders_ops 
  ADD COLUMN IF NOT EXISTS shipping_address JSONB;
`).catch(e => console.log("Migration Note: " + e.message));

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
   📝 SYSTEM LOGGER
================================ */
async function logEvent(level, module, message, meta = {}) {
  const logMsg = `[${module}] ${message}`;
  if (level === 'ERROR') console.error(`❌ ${logMsg}`, meta);
  else console.log(`✅ ${logMsg}`);

  pool.query(
    `INSERT INTO system_logs (level, module, message, meta) VALUES ($1, $2, $3, $4)`,
    [level, module, message, JSON.stringify(meta)]
  ).catch(e => console.error("Logger Failed:", e.message));
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
  if (!rateLimiter.has(ip)) { rateLimiter.set(ip, { c: 1, t: now }); return true; }
  const r = rateLimiter.get(ip);
  if (now - r.t > 60000) { r.c = 1; r.t = now; return true; }
  if (r.c >= 30) {
    logEvent('WARN', 'SECURITY', 'Rate Limit Exceeded', { ip });
    return false;
  }
  r.c++; return true;
}

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
    const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } });
    bdJwt = r.data.JWTToken; bdAt = Date.now(); return bdJwt; 
  } catch (e) { logEvent('ERROR', 'AUTH', 'BlueDart Auth Failed', { error: e.message }); return null; }
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srAt < 7 * 86400000) return srJwt;
  try {
    const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) });
    srJwt = r.data.token; srAt = Date.now(); return srJwt;
  } catch (e) { logEvent('ERROR', 'AUTH', 'Shiprocket Auth Failed', { error: e.response?.data || e.message }); return null; }
}

const IGNORE_SCANS = ["BAGGED", "MANIFEST", "NETWORK", "RELIEF", "PARTIAL"];

async function trackBluedart(awb) {
  try {
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: "awb", numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 },
      responseType: "text"
    });
    
    if (!r.data || r.data.trim().startsWith("<html")) {
      logEvent('ERROR', 'TRACKING', `BlueDart HTML/Error Response`, { awb });
      return null;
    }
    const p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = p?.ShipmentData?.Shipment; 
    if (!s) { logEvent('WARN', 'TRACKING', `BlueDart Empty Data`, { awb }); return null; }

    const isFinal = s.Status?.toUpperCase().includes("DELIVERED");
    const rawScans = Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail];
    
    const scans = rawScans.filter(x => {
      if (!x?.Scan) return false;
      if (isFinal) return true; 
      return !IGNORE_SCANS.some(k => x.Scan.toUpperCase().includes(k));
    });

    return { 
      status: s.Status, 
      delivered: isFinal, 
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
  } catch (e) { logEvent('ERROR', 'TRACKING', `BlueDart Exception`, { awb, error: e.message }); return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    if (!t) return null;
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } });
    const d = r.data?.tracking_data; 
    
    if (!d) { logEvent('WARN', 'TRACKING', `Shiprocket Empty Data`, { awb, response: r.data }); return null; }
    
    const status = d.current_status || d.shipment_track?.[0]?.current_status || "";

    return { 
      status: status, 
      delivered: status.toUpperCase().includes("DELIVERED"), 
      history: (d.shipment_track_activities || []).map(x => ({ status: x.activity, date: x.date, location: x.location })), 
      raw: d 
    };
  } catch (e) { 
    const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    logEvent('ERROR', 'TRACKING', `Shiprocket API Error`, { awb, error: errMsg }); 
    return null; 
  }
}

async function getCity(p){try{const r=await axios.get(`https://api.postalpincode.in/pincode/${p}`);return r.data?.[0]?.PostOffice?.[0]?.District||null}catch{return null}}

// 🟢 PREDICT BLUEDART EDD
async function predictBluedartEDD(p) {
  try {
    const j = await getBluedartJwt();
    if (!j) return null;
    const r = await axios.post("https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct", {
      pPinCodeFrom: "411022",
      pPinCodeTo: p,
      pProductCode: "A",
      pSubProductCode: "P",
      pPudate: getNextWorkingDate(), 
      pPickupTime: "16:00",
      profile: { Api_type: "S", LicenceKey: clean(BD_LICENCE_KEY_EDD), LoginID: clean(LOGIN_ID) }
    }, { headers: { JWTToken: j } });
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch (e) { 
    logEvent('ERROR', 'EDD', `BlueDart EDD Error`, { error: e.message });
    return null; 
  }
}

async function predictShiprocketEDD(p){try{const t=await getShiprocketJwt();if(!t)return null;const r=await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${p}&cod=1&weight=0.5`,{headers:{Authorization:`Bearer ${t}`}});return r.data?.data?.available_courier_companies?.[0]?.etd||null}catch{return null}}

/* ===============================
   🔄 SYNC & BACKGROUND
================================ */
async function syncOrder(o) {
  // Try to find phone in multiple places
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || null;
  
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
        shipping_address = EXCLUDED.shipping_address, -- Update address if it changes
        city = EXCLUDED.city
    `, [
      String(o.id), 
      o.name, 
      o.financial_status, 
      o.fulfillment_status, 
      o.total_price, 
      JSON.stringify(o.payment_gateway_names || []), 
      `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim(), 
      o.email || o.customer?.email, 
      phone, 
      o.shipping_address?.city, 
      JSON.stringify(o.shipping_address || {}), // 🟢 SAVING FULL ADDRESS HERE
      JSON.stringify(o.line_items || []), 
      o.name?.startsWith("EX-") || false, 
      o.name?.includes("-R") || false, 
      "shopify", 
      o.created_at
    ]);
    
    // Sync Fulfillments
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
    const { rows } = await pool.query(`SELECT awb, courier_source FROM shipments_ops WHERE delivered = FALSE AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '30 minutes') LIMIT 15`);
    
    for (const r of rows) {
      const t = r.courier_source === "bluedart" ? await trackBluedart(r.awb) : await trackShiprocket(r.awb);
      
      if (t) {
        // ✅ Success
        await pool.query(`UPDATE shipments_ops SET delivered=$1, last_status=$2, last_state=$3, history=$4::jsonb, raw_data=$5::jsonb, last_checked_at=NOW() WHERE awb=$6`, 
        [t.delivered, t.status, resolveShipmentState(t.status), JSON.stringify(t.history || []), JSON.stringify(t.raw || {}), r.awb]);
      } else {
        // ⚠️ Failure
        console.log(`⚠️ Marking failed AWB as checked: ${r.awb}`);
        await pool.query(`UPDATE shipments_ops SET last_checked_at=NOW() WHERE awb=$1`, [r.awb]);
      }
    }
  } catch (e) { logEvent('ERROR', 'SYNC', 'Stale Update Loop Failed', { error: e.message }); }
}

async function runBackfill() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) return;
  try {
    const r = await axios.get(`https://${clean(SHOP_NAME)}.myshopify.com/admin/api/${API_VER}/orders.json?status=any&limit=50`, { headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) } });
    for (const o of r.data.orders || []) await syncOrder(o);
    logEvent('INFO', 'BACKFILL', `Backfilled ${r.data.orders.length} orders`);
  } catch (e) { logEvent('ERROR', 'BACKFILL', 'Backfill Failed', { error: e.message }); }
}

setTimeout(runBackfill, 5000);
setInterval(() => { runBackfill(); updateStaleShipments(); }, 30 * 60 * 1000);

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
    `, [t.delivered, t.status, resolveShipmentState(t.status), JSON.stringify(t.history || []), JSON.stringify(t.raw || {}), awb]);
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
  await pool.query(`INSERT INTO shipments_ops (awb, order_id, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`, [req.body.tracking_number, String(req.body.order_id), courier]);
});

app.post("/webhooks/orders_cancelled", async (req, res) => {
  res.sendStatus(200);
  if (verifyShopify(req)) {
    logEvent('INFO', 'WEBHOOK', `Order Cancelled: ${req.body.name}`);
    await pool.query(`UPDATE orders_ops SET financial_status = 'cancelled' WHERE id = $1::text`, [String(req.body.id)]);
  }
});

app.post("/webhooks/returnprime", async (req, res) => {
  res.sendStatus(200); const e = req.body;
  if (!e.id || !e.order_number) return;
  logEvent('INFO', 'WEBHOOK', `Return Update: ${e.order_number}`, { status: e.status });
  await pool.query(`INSERT INTO returns_ops (return_id, order_number, status, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (return_id) DO UPDATE SET status=EXCLUDED.status, updated_at=NOW()`, [String(e.id), e.order_number, e.status || "created"]);
});

/* ===============================
   🔍 CUSTOMER ENDPOINT (HYBRID LIVE)
================================ */
app.post("/track/customer", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests" });
  if (!req.body?.phone) return res.status(400).json({ error: "Phone required" });

  try {
    const cleanInput = req.body.phone.toString().replace(/\D/g, "").slice(-10);
    const { rows } = await pool.query(`SELECT o.order_number, o.created_at, o.fulfillment_status, s.awb, s.courier_source, s.last_state, s.last_status, s.history as db_history, s.last_checked_at FROM orders_ops o LEFT JOIN shipments_ops s ON s.order_id::text = o.id::text WHERE o.customer_phone::text LIKE $1 ORDER BY o.created_at DESC LIMIT 5`, [`%${cleanInput}`]);

    const promises = rows.map(async (row) => {
      if (!row.awb || row.last_state === 'DELIVERED') return row; 
      const lastCheck = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
      if (Date.now() - lastCheck > 60 * 1000) { // 1 min stale check
        const fresh = await forceRefreshShipment(row.awb, row.courier_source);
        if (fresh) {
           row.last_state = resolveShipmentState(fresh.status);
           row.last_status = fresh.status;
           row.db_history = fresh.history;
        }
      }
      return row;
    });

    const refreshedRows = await Promise.all(promises);
    const results = refreshedRows.map((row) => {
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];
      if (row.fulfillment_status === 'fulfilled') history.push({ status: "Dispatched", date: "Order Packed", completed: true });
      if (Array.isArray(row.db_history)) history = [...history, ...row.db_history];

      return { shopify_order_name: row.order_number, awb: row.awb, current_state: row.last_state || (row.fulfillment_status === 'fulfilled' ? "IN_TRANSIT" : "PROCESSING"), courier: row.courier_source, last_known_status: row.last_status || "Shipment information will be updated shortly", tracking_history: history };
    });
    res.json({ orders: results });
  } catch (e) { 
    logEvent('ERROR', 'TRACKING', 'Customer Track Error', { error: e.message });
    res.status(500).json({ error: "Server error" }); 
  }
});

/* ===============================
   ✅ PAGINATED ORDERS ENDPOINT (CRASH PROOF1)
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

        -- 🟢 CRASH FIX: Check if data is array before expanding
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
    console.error(e); // Log error to Render console for deeper debugging
    res.status(500).json({ error: "Db Error: " + e.message }); 
  }
});
/* ===============================
   🚀 TEMP: LOGISTICS REFRESHER
================================ */
app.get("/ops/refresh-logistics", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  try {
    // 1. Get all shipments that are not delivered and were checked more than 1 hour ago
    const { rows } = await pool.query(`
      SELECT awb, courier_source 
      FROM shipments_ops 
      WHERE delivered = FALSE 
      LIMIT 100
    `);

    logEvent('INFO', 'RECOVERY', `Found ${rows.length} shipments to refresh.`);

    // 2. Loop through and force refresh
    for (const r of rows) {
      await forceRefreshShipment(r.awb, r.courier_source);
      // Small delay to avoid Shiprocket rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    res.json({ message: `Successfully queued refresh for ${rows.length} shipments.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===============================
   📊 ADMIN DASHBOARD & LOGS
================================ */
app.get("/ops/logs", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 50`);
    res.json({ logs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/recon/ops", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE is_exchange=FALSE AND is_return=FALSE) AS net_new_orders, COUNT(*) FILTER (WHERE is_return=TRUE) AS total_returns, COUNT(*) FILTER (WHERE financial_status!='paid' AND fulfillment_status='fulfilled') AS cod_at_risk FROM orders_ops WHERE created_at > NOW() - INTERVAL '30 days'`);
  res.json({ summary: rows[0] });
});

/* ===============================
   🚚 EDD ENDPOINT (RESTORED)
================================ */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!pincode) return res.status(400).json({ error: "Pincode is required" });

  if (eddCache.has(pincode)) return res.json({ ...eddCache.get(pincode), source: 'cache' });

  try {
    let edd = await predictBluedartEDD(pincode);
    let source = "bluedart";

    if (!edd) {
      edd = await predictShiprocketEDD(pincode);
      source = "shiprocket";
    }

    if (edd) {
      const response = { pincode, edd, source };
      eddCache.set(pincode, response);
      res.json(response);
    } else {
      res.status(404).json({ error: "Serviceability not found" });
    }
  } catch (e) {
    logEvent('ERROR', 'EDD', 'Endpoint Error', { error: e.message });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/health", (_, res) => res.send("READY"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 HighSpark Logistics Master LIVE", PORT));