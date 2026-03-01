// ==========================================
// 🚀 HIGHSPARK ELITE LOGISTICS MASTER (v5.1 - Egress Saver + Friend's Fixes)
// Merged: Full feature parity from v1 + Elite Scheduler from v2
// Upgrades: Circuit breaker, smarter EDD fallback, dedup webhook guard,
//           graceful shutdown, detailed health endpoint, backpressure protection,
//           Delta Sync (Egress Saver), Parameter Binding Bug Fix, DB Index Speedup
// ==========================================

import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";
import cron from "node-cron";
import https from "https";

/* ===============================
   🚀 APP INIT & GLOBAL AGENTS
================================ */
const app = express();
const eddCache = new Map();
const rateLimiter = new Map();

// Circuit Breaker State
const circuitBreakers = {
  bluedart: { failures: 0, openUntil: 0 },
  shiprocket: { failures: 0, openUntil: 0 }
};
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN = 5 * 60 * 1000;

axios.defaults.timeout = 25000;

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5 });

app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// 📢 THE DOORBELL: This will print every incoming request to your Render logs
app.use((req, res, next) => {
  console.log(`🔔 Incoming: ${req.method} ${req.path} from ${req.ip}`);
  next();
});

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
  SHOPIFY_ACCESS_TOKEN, SHOP_NAME, SHOPIFY_API_VERSION,
  ADMIN_SECRET
} = process.env;

const API_VER = clean(SHOPIFY_API_VERSION) || '2026-01';

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('❌ Unexpected idle client error:', err.message);
});

/* ===============================
   🛠️ DB SCHEMA MIGRATION
================================ */
async function runMigrations() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS orders_ops (
      id TEXT PRIMARY KEY, order_number TEXT, financial_status TEXT, fulfillment_status TEXT,
      total_price TEXT, payment_gateway_names JSONB, customer_name TEXT, customer_email TEXT,
      customer_phone TEXT, city TEXT, shipping_address JSONB, line_items JSONB,
      is_exchange BOOLEAN DEFAULT FALSE, is_return BOOLEAN DEFAULT FALSE,
      source TEXT DEFAULT 'shopify', created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS shipments_ops (
      awb TEXT PRIMARY KEY, order_id TEXT, courier_source TEXT,
      delivered BOOLEAN DEFAULT FALSE, last_status TEXT, last_state TEXT,
      history JSONB, raw_data JSONB, next_check_at TIMESTAMP,
      last_checked_at TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS returns_ops (
      return_id VARCHAR(255) PRIMARY KEY, order_number VARCHAR(255),
      status VARCHAR(255), updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS system_logs (
      id SERIAL PRIMARY KEY, level TEXT, module TEXT, message TEXT,
      meta JSONB, timestamp TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS api_usage_ops (
      log_date DATE DEFAULT CURRENT_DATE, provider VARCHAR(50), calls INT DEFAULT 1,
      PRIMARY KEY (log_date, provider)
    )`,
    `ALTER TABLE orders_ops ADD COLUMN IF NOT EXISTS shipping_address JSONB`,
    `ALTER TABLE shipments_ops ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMP`,
    `ALTER TABLE shipments_ops ADD COLUMN IF NOT EXISTS history JSONB`,
    `ALTER TABLE shipments_ops ADD COLUMN IF NOT EXISTS raw_data JSONB`,
    `ALTER TABLE orders_ops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    `CREATE TABLE IF NOT EXISTS processed_webhooks (
      webhook_id TEXT PRIMARY KEY, processed_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_shipments_next_check ON shipments_ops(next_check_at) WHERE delivered IS DISTINCT FROM TRUE`,
    `CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders_ops(customer_phone)`,
    `CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments_ops(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON system_logs(timestamp DESC)`,
    // FRIEND'S FIX 1: Activated the speed index for your database
    `CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders_ops(updated_at DESC)`
  ];

  for (const q of queries) {
    await pool.query(q).catch(e => console.log(`Migration note: ${e.message.substring(0, 80)}`));
  }
  console.log("✅ Migrations complete");
}

/* ===============================
   🕒 DATE HELPERS
================================ */
function nowIST() {
  const d = new Date();
  return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
}

function getNextWorkingDate() {
  const d = nowIST();
  if (d.getHours() >= 14) {
    d.setDate(d.getDate() + 1);
  }
  if (d.getDay() === 0) {
    d.setDate(d.getDate() + 1);
  }
  d.setHours(0, 0, 0, 0);
  return `/Date(${d.getTime()})/`;
}

/* ===============================
   📝 LOGGER & USAGE TRACKER
================================ */
async function logEvent(level, module, message, meta = {}) {
  const logMsg = `[${module}] ${message}`;
  if (level === 'ERROR') console.error(`❌ ${logMsg}`, Object.keys(meta).length ? meta : '');
  else console.log(`✅ ${logMsg}`);

  pool.query(
    `INSERT INTO system_logs (level, module, message, meta) VALUES ($1, $2, $3, $4)`,
    [level, module, message, JSON.stringify(meta)]
  ).catch(e => console.error("Logger failed:", e.message));
}

async function trackApiUsage(provider) {
  pool.query(`
    INSERT INTO api_usage_ops (log_date, provider, calls) VALUES (CURRENT_DATE, $1, 1)
    ON CONFLICT (log_date, provider) DO UPDATE SET calls = api_usage_ops.calls + 1
  `, [provider]).catch(e => console.error("Usage track failed:", e.message));
}

/* ===============================
   🔐 SECURITY & HELPERS
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret || !req.rawBody) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  return digest === req.headers["x-shopify-hmac-sha256"];
}

function verifyAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.key;
  const validKey = clean(ADMIN_SECRET) || clean(SHOPIFY_WEBHOOK_SECRET);
  return key === validKey;
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimiter.has(ip)) { rateLimiter.set(ip, { c: 1, t: now }); return true; }
  const r = rateLimiter.get(ip);
  if (now - r.t > 60000) { r.c = 1; r.t = now; return true; }
  if (r.c >= 30) { logEvent('WARN', 'SECURITY', 'Rate Limit Exceeded', { ip }); return false; }
  r.c++;
  return true;
}

async function isWebhookDuplicate(webhookId) {
  if (!webhookId) return false;
  try {
    const r = await pool.query(
      `INSERT INTO processed_webhooks (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING webhook_id`,
      [webhookId]
    );
    return r.rowCount === 0;
  } catch (e) {
    return false;
  }
}

/* ===============================
   🧠 STATE LOGIC
================================ */
function resolveShipmentState(status = "", history = []) {
  let s = status.toUpperCase();
  if (history && history.length > 0) {
    const latest = history[history.length - 1];
    if (latest?.status) s += " " + latest.status.toUpperCase();
  }
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("RETURN") || s.includes("RTO")) return "RTO";
  if (s.includes("FAILED") || s.includes("UNDELIVERED") || s.includes("REFUSED") ||
      s.includes("REJECTED") || s.includes("CANCEL")) return "NDR";
  if (s.includes("OUT FOR") || s.includes("OFD") || s.includes("DISPATCHED") ||
      s.includes("IN TRANSIT") || s.includes("ARRIVED") || s.includes("PICKED") ||
      s.includes("CONNECTED") || s.includes("SHIPPED")) return "IN_TRANSIT";
  return "PROCESSING";
}

function getNextCheckDelay(state) {
  switch (state) {
    case "DELIVERED": return null;
    case "RTO":       return 24 * 60 * 60 * 1000;
    case "NDR":       return 2 * 60 * 60 * 1000;
    case "IN_TRANSIT":return 45 * 60 * 1000;
    default:          return 60 * 60 * 1000;
  }
}

function formatConfidenceBand(dStr) {
  if (!dStr) return null;
  const s = new Date(dStr);
  if (isNaN(s.getTime())) return null;
  const e = new Date(s); e.setDate(e.getDate() + 1);
  const f = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return `${f(s)} - ${f(e)}`;
}

/* ===============================
   🔌 CIRCUIT BREAKER
================================ */
function isCircuitOpen(provider) {
  const cb = circuitBreakers[provider];
  if (!cb) return false;
  if (cb.openUntil > Date.now()) return true;
  if (cb.openUntil && cb.openUntil <= Date.now()) {
    cb.failures = 0; cb.openUntil = 0;
  }
  return false;
}

function recordApiSuccess(provider) {
  if (circuitBreakers[provider]) circuitBreakers[provider].failures = 0;
}

const RETRYABLE_ERRORS = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "ECONNREFUSED"]);

function isNetworkError(e) {
  return RETRYABLE_ERRORS.has(e.code) || (e.response?.status >= 500 && e.response?.status < 600);
}

function recordApiFailure(provider, error) {
  if (!isNetworkError(error)) return;
  const cb = circuitBreakers[provider];
  if (!cb) return;
  cb.failures++;
  if (cb.failures >= CIRCUIT_THRESHOLD) {
    cb.openUntil = Date.now() + CIRCUIT_COOLDOWN;
    logEvent('WARN', 'CIRCUIT_BREAKER', `${provider} circuit OPEN for 5 minutes after ${cb.failures} network failures`);
  }
}

/* ===============================
   📦 COURIER ENGINES (WITH SUPABASE DIET)
================================ */
let srJwt, srAt = 0, bdJwt, bdAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdAt < 23 * 3600000) return bdJwt;
  try {
    const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", {
      headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) }, httpsAgent
    });
    bdJwt = r.data.JWTToken; bdAt = Date.now();
    return bdJwt;
  } catch (e) { logEvent('ERROR', 'AUTH', 'BlueDart Auth Failed', { error: e.message }); return null; }
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srAt < 7 * 86400000) return srJwt;
  try {
    const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", {
      email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD)
    }, { httpsAgent });
    srJwt = r.data.token; srAt = Date.now();
    return srJwt;
  } catch (e) { logEvent('ERROR', 'AUTH', 'Shiprocket Auth Failed', { error: e.response?.data || e.message }); return null; }
}

const IGNORE_SCANS = ["BAGGED", "MANIFEST", "NETWORK", "RELIEF", "PARTIAL"];

async function trackBluedart(awb, retry = false) {
  if (!/^[89]\d{10}$/.test(awb)) return null;
  if (isCircuitOpen('bluedart')) {
    logEvent('WARN', 'CIRCUIT_BREAKER', `BlueDart circuit open, skipping ${awb}`);
    return null;
  }

  try {
    trackApiUsage('bluedart_tracking');
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      httpsAgent,
      params: {
        handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID),
        awb: "awb", numbers: awb, format: "xml",
        lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1
      },
      responseType: "text"
    });

    if (!r.data || r.data.trim().startsWith("<html")) return null;

    let p;
    try {
      p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    } catch (parseErr) {
      logEvent('WARN', 'TRACKING', 'BlueDart XML parse failed', { awb, error: parseErr.message });
      return null;
    }

    const shipments = p?.ShipmentData?.Shipment;
    if (!shipments) return null;

    const fwd = Array.isArray(shipments) ? shipments[0] : shipments;
    const ret = Array.isArray(shipments) && shipments.length > 1 ? shipments[1] : null;

    const isFwdDelivered = fwd.Status?.toUpperCase().includes("DELIVERED");
    const isRetDelivered = ret ? ret.Status?.toUpperCase().includes("DELIVERED") : false;
    const isFinallyDone = isFwdDelivered || isRetDelivered;

    let finalStatus = fwd.Status;
    if (ret) {
      const retAwb = ret.$?.WaybillNo || ret.WaybillNo || 'UNKNOWN';
      finalStatus = `RTO | RET AWB: ${retAwb} | STATUS: ${ret.Status}`;
    }

    const rawScans = Array.isArray(fwd.Scans?.ScanDetail) ? fwd.Scans.ScanDetail : [fwd.Scans?.ScanDetail];
    let allScans = rawScans;
    if (ret && Array.isArray(ret.Scans?.ScanDetail)) {
      // 🟢 FRIEND'S FIX: Append return scans to the END so chronological order is maintained
      allScans = [...allScans, ...ret.Scans.ScanDetail]; 
    }

    const scans = allScans.filter(x => {
      if (!x?.Scan) return false;
      if (isFinallyDone) return true;
      return !IGNORE_SCANS.some(k => x.Scan.toUpperCase().includes(k));
    });

    recordApiSuccess('bluedart');
    return {
      status: finalStatus,
      delivered: isFinallyDone,
      history: scans.map(x => ({
        status: x.Scan,
        date: `${(x.ScanDate || "").trim()} ${(x.ScanTime || "00:00").trim()}`,
        location: x.ScannedLocation
      })),
      // 🟢 THE TERMINAL SCRUB (SUPABASE FREE TIER SAVER)
      raw: isFinallyDone ? {} : p 
    };
  } catch (e) {
    if (e.code && RETRYABLE_ERRORS.has(e.code) && !retry) {
      await new Promise(res => setTimeout(res, 2000));
      return trackBluedart(awb, true);
    }
    recordApiFailure('bluedart', e);
    logEvent('ERROR', 'TRACKING', 'BlueDart Exception', { awb, error: e.message, code: e.code });
    return null;
  }
}

async function trackShiprocket(awb) {
  if (isCircuitOpen('shiprocket')) {
    logEvent('WARN', 'CIRCUIT_BREAKER', `Shiprocket circuit open, skipping ${awb}`);
    return null;
  }

  try {
    trackApiUsage('shiprocket_tracking');
    const t = await getShiprocketJwt();
    if (!t) return null;

    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, {
      headers: { Authorization: `Bearer ${t}` },
      httpsAgent,
      validateStatus: (s) => s < 600
    });

    const d = r.data?.tracking_data;
    if (!d) { logEvent('WARN', 'TRACKING', 'Shiprocket Empty Response', { awb }); return null; }

    // 🟢 UPGRADE: Check the deep status first! This catches "RTO Delivered" hiding under a "Cancelled" top-level flag.
    const deepStatus = d.shipment_track?.[0]?.current_status || "";
    const topStatus = d.current_status || "";
    
    let finalStatus = topStatus;
    
    // If the deep status says RTO or Return, trust it over a "Cancelled" top status
    if (deepStatus.toUpperCase().includes('RTO') || deepStatus.toUpperCase().includes('RETURN')) {
        finalStatus = deepStatus;
    } else if (r.data?.message?.includes("cancel") || topStatus.toLowerCase().includes("cancel")) {
        finalStatus = "CANCELLED";
    } else if (deepStatus) {
        finalStatus = deepStatus;
    }

    recordApiSuccess('shiprocket');
    const isTerminal = finalStatus.toUpperCase().includes("DELIVERED") || finalStatus.toUpperCase().includes("RTO");

    return {
      status: finalStatus,
      delivered: finalStatus.toUpperCase().includes("DELIVERED") && !finalStatus.toUpperCase().includes("RTO"),
      history: (d.shipment_track_activities || []).map(x => ({
        status: x.activity, date: x.date, location: x.location
      })),
      // 🟢 THE TERMINAL SCRUB (SUPABASE FREE TIER SAVER)
      raw: isTerminal ? { shipment_track: d.shipment_track || [] } : d 
    };
  } catch (e) {
    recordApiFailure('shiprocket', e);
    logEvent('ERROR', 'TRACKING', 'Shiprocket Exception', { awb, error: e.message, code: e.code });
    return null;
  }
}

/* ===============================
   🏙️ CITY LOOKUP
================================ */
async function getCity(p) {
  try {
    const r = await axios.get(`https://api.postalpincode.in/pincode/${p}`, { timeout: 5000 });
    return r.data?.[0]?.PostOffice?.[0]?.District || null;
  } catch { return null; }
}

/* ===============================
   🚚 EDD ENGINE
================================ */
async function predictBluedartEDD(p) {
  try {
    const j = await getBluedartJwt();
    if (!j) return null;
    await new Promise(res => setTimeout(res, Math.random() * 400 + 100));

    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: p,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: getNextWorkingDate(),
        pPickupTime: "14:00",
        profile: { Api_type: "S", LicenceKey: clean(BD_LICENCE_KEY_EDD), LoginID: clean(LOGIN_ID) }
      },
      { headers: { JWTToken: j }, httpsAgent }
    );
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch (e) {
    const errDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    logEvent('ERROR', 'EDD', 'BlueDart EDD Failed', { error: errDetail });
    return null;
  }
}

async function predictShiprocketEDD(p) {
  try {
    const t = await getShiprocketJwt();
    if (!t) return null;
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${p}&cod=1&weight=0.5`,
      { headers: { Authorization: `Bearer ${t}` }, httpsAgent }
    );
    return r.data?.data?.available_courier_companies?.[0]?.etd || null;
  } catch { return null; }
}

/* ===============================
   🔄 ORDER SYNC
================================ */
async function syncOrder(o) {
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || null;
  const actualFinancialStatus = o.cancelled_at ? 'cancelled' : o.financial_status;

  try {
    await pool.query(`
      INSERT INTO orders_ops (
        id, order_number, financial_status, fulfillment_status, total_price,
        payment_gateway_names, customer_name, customer_email, customer_phone,
        city, shipping_address, line_items, is_exchange, is_return, source, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, NOW())
      ON CONFLICT (id) DO UPDATE SET
        financial_status    = EXCLUDED.financial_status,
        fulfillment_status  = EXCLUDED.fulfillment_status,
        customer_phone      = EXCLUDED.customer_phone,
        shipping_address    = EXCLUDED.shipping_address,
        city                = EXCLUDED.city,
        updated_at          = NOW()
    `, [
      String(o.id), o.name, actualFinancialStatus, o.fulfillment_status, o.total_price,
      JSON.stringify(o.payment_gateway_names || []),
      `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim(),
      o.email || o.customer?.email, phone,
      o.shipping_address?.city,
      JSON.stringify(o.shipping_address || {}),
      JSON.stringify(o.line_items || []),
      o.name?.startsWith("EX-") || false,
      o.name?.includes("-R") || false,
      "shopify", o.created_at
    ]);

    if (o.fulfillments) {
      for (const f of o.fulfillments) {
        if (!f.tracking_number) continue;
        const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
        await pool.query(`
          INSERT INTO shipments_ops (awb, order_id, courier_source, next_check_at)
          VALUES ($1, $2, $3, NOW() + (random() * interval '5 minutes'))
          ON CONFLICT (awb) DO NOTHING
        `, [f.tracking_number, String(o.id), courier]);
      }
    }
  } catch (e) {
    logEvent('ERROR', 'SYNC', `Order Sync Failed: ${o.name}`, { error: e.message });
  }
}

/* ===============================
   🧠 SMART ROUTING ENGINE (NEW)
================================ */
async function smartTrack(awb, intendedCourier) {
  let result = null;
  let actualCourier = intendedCourier; // Assume the original is correct until proven otherwise
  const cleanAwb = String(awb || "").trim();
  const isBdFormat = /^[89]\d{10}$/.test(cleanAwb);

  if (intendedCourier === "bluedart") {
    if (isBdFormat) result = await trackBluedart(cleanAwb);
    
    // Fallback to Shiprocket
    if (!result) {
      console.log(`🔄 Routing Fallback: Checking Shiprocket for ${cleanAwb}`);
      result = await trackShiprocket(cleanAwb);
      if (result) actualCourier = "shiprocket"; // 🟢 Found it! Switch the label.
    }
  } else {
    result = await trackShiprocket(cleanAwb);
    
    // Fallback to BlueDart
    if (!result && isBdFormat) {
      console.log(`🔄 Routing Fallback: Checking BlueDart for ${cleanAwb}`);
      result = await trackBluedart(cleanAwb);
      if (result) actualCourier = "bluedart"; // 🟢 Found it! Switch the label.
    }
  }
  
  // Attach the winning courier to the result so the database knows
  if (result) result.actual_courier = actualCourier;
  
  return result;
}

/* ===============================
   🚀 ELITE SCHEDULER (WITH DB LOCK)
================================ */
let schedulerRunning = false;
let lastQueueSize = 0;

async function schedulerLoop() {
  if (schedulerRunning) return;
  schedulerRunning = true;

  // 🟢 FRIEND'S FIX: Postgres Advisory Lock (Prevents 2 Render instances from colliding)
  const lock = await pool.query(`SELECT pg_try_advisory_lock(1042)`);
  if (!lock.rows[0].pg_try_advisory_lock) {
    schedulerRunning = false;
    return; // Another instance is already running the scheduler
  }

  try {
    const countRes = await pool.query(`
      SELECT COUNT(*) FROM shipments_ops
      WHERE delivered IS DISTINCT FROM TRUE
        AND (last_status IS NULL OR last_status NOT LIKE '%CANCEL%')
        AND (next_check_at IS NULL OR next_check_at <= NOW())
    `);
    lastQueueSize = parseInt(countRes.rows[0].count) || 0;

    const { rows } = await pool.query(`
      SELECT awb, courier_source FROM shipments_ops
      WHERE delivered IS DISTINCT FROM TRUE
        AND (last_status IS NULL OR last_status NOT LIKE '%CANCEL%')
        AND (next_check_at IS NULL OR next_check_at <= NOW())
      ORDER BY next_check_at ASC NULLS FIRST, last_checked_at ASC NULLS FIRST
      LIMIT 1
    `);

    if (rows.length === 0) return;

    const job = rows[0];
    const safeAwb = String(job.awb || "").trim();

    if (safeAwb.toUpperCase().includes('TEST') || safeAwb.length < 5) {
      await pool.query(`UPDATE shipments_ops SET next_check_at = NULL, last_status = 'INVALID_AWB' WHERE awb = $1`, [job.awb]);
      return;
    }

    const result = await smartTrack(job.awb, job.courier_source);

    if (result) {
      const state = resolveShipmentState(result.status, result.history);
      const delay = getNextCheckDelay(state);
      const nextCheck = delay ? new Date(Date.now() + delay) : null;

      await pool.query(`
        UPDATE shipments_ops SET
          last_status = $1, last_state = $2, delivered = $3,
          history = $4::jsonb, raw_data = $5::jsonb,
          next_check_at = $6, last_checked_at = NOW(),
          courier_source = $8
        WHERE awb = $7
      `, [result.status, state, result.delivered,
          JSON.stringify(result.history || []),
          JSON.stringify(result.raw || {}),
          nextCheck, job.awb, result.actual_courier]);

      if (result.delivered) logEvent('INFO', 'SCHEDULER', `✅ Delivered & stopped tracking: ${job.awb}`);
    } else {
      await pool.query(`UPDATE shipments_ops SET next_check_at = NOW() + INTERVAL '2 hours' WHERE awb = $1`, [job.awb]);
    }
  } catch (e) {
    console.error("Scheduler Error:", e.message);
  } finally {
    // 🟢 FRIEND'S FIX: Always release the lock when done, even if it crashes!
    await pool.query(`SELECT pg_advisory_unlock(1042)`);
    schedulerRunning = false;
  }
}

let schedulerInterval = null;
function startScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);

  async function adaptiveTick() {
    await schedulerLoop();
    const nextDelay = lastQueueSize > 20 ? 3000 : lastQueueSize > 5 ? 10000 : 30000;
    schedulerInterval = setTimeout(adaptiveTick, nextDelay);
  }
  schedulerInterval = setTimeout(adaptiveTick, 5000);
}

/* ===============================
   ⚡️ LIVE REFRESH
================================ */
async function forceRefreshShipment(awb, courier) {
  if (!awb) return null;
  
  const result = await smartTrack(awb, courier);

  if (result) {
    const state = resolveShipmentState(result.status, result.history);
    const delay = getNextCheckDelay(state);
    
    // 🟢 UPGRADE: Also updates courier_source ($8) during live manual refreshes
    await pool.query(`
      UPDATE shipments_ops SET
        delivered = $1, last_status = $2, last_state = $3,
        history = $4::jsonb, raw_data = $5::jsonb,
        next_check_at = $6, last_checked_at = NOW(),
        courier_source = $8
      WHERE awb = $7
    `, [result.delivered, result.status, state,
        JSON.stringify(result.history || []),
        JSON.stringify(result.raw || {}),
        delay ? new Date(Date.now() + delay) : null, awb, result.actual_courier]);

    logEvent('INFO', 'TRACKING', `Live refreshed ${awb}`, { status: result.status });
  }
  return result;
}

/* ===============================
   🔔 WEBHOOKS
================================ */
app.post("/webhooks/orders_paid", async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req)) return;
  const webhookId = req.headers["x-shopify-webhook-id"];
  if (await isWebhookDuplicate(`paid_${webhookId}`)) return;
  logEvent('INFO', 'WEBHOOK', `Order Paid: ${req.body.name}`);
  syncOrder(req.body);
});

app.post("/webhooks/fulfillments_create", async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req) || !req.body.tracking_number) return;
  const webhookId = req.headers["x-shopify-webhook-id"];
  if (await isWebhookDuplicate(`fulf_${webhookId}`)) return;
  const courier = req.body.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  logEvent('INFO', 'WEBHOOK', `Fulfillment: ${req.body.tracking_number} (${courier})`);
  await pool.query(`
    INSERT INTO shipments_ops (awb, order_id, courier_source, next_check_at)
    VALUES ($1, $2, $3, NOW() + (random() * interval '5 minutes'))
    ON CONFLICT (awb) DO NOTHING
  `, [req.body.tracking_number, String(req.body.order_id), courier]);
});

app.post("/webhooks/orders_cancelled", async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req)) return;
  const webhookId = req.headers["x-shopify-webhook-id"];
  if (await isWebhookDuplicate(`cancel_${webhookId}`)) return;
  logEvent('INFO', 'WEBHOOK', `Order Cancelled: ${req.body.name}`);
  await pool.query(
    `UPDATE orders_ops SET financial_status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [String(req.body.id)]
  );
});

app.post("/webhooks/orders_updated", async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req)) return;
  const webhookId = req.headers["x-shopify-webhook-id"];
  if (await isWebhookDuplicate(`upd_${webhookId}`)) return;
  logEvent('INFO', 'WEBHOOK', `Order Updated: ${req.body.name}`);
  syncOrder(req.body);
});

app.post("/webhooks/returnprime", async (req, res) => {
  res.sendStatus(200);
  const rp = req.body?.request;
  if (!rp) { logEvent('WARN', 'WEBHOOK', 'ReturnPrime missing "request" object'); return; }

  const { id: returnId, order, status: returnStatus } = rp;
  const orderNumber = order?.name;

  if (!returnId || !orderNumber) {
    logEvent('WARN', 'WEBHOOK', 'ReturnPrime missing ID or Order Number');
    return;
  }

  try {
    await pool.query(`
      INSERT INTO returns_ops (return_id, order_number, status, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (return_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
    `, [String(returnId), String(orderNumber), String(returnStatus)]);
    logEvent('INFO', 'WEBHOOK', `ReturnPrime: ${orderNumber} → ${returnStatus}`);
  } catch (e) {
    logEvent('ERROR', 'WEBHOOK', `ReturnPrime DB Error`, { error: e.message });
  }
});

/* ===============================
   🔍 CUSTOMER TRACKING ENDPOINT
================================ */
app.post("/track/customer", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const input = req.body?.tracking_id || req.body?.awb || req.body?.phone;
  if (!input) return res.status(400).json({ error: "Tracking ID required" });

  try {
    const cleanInput = input.toString().trim().replace(/[^a-zA-Z0-9-]/g, "");
    const phoneMatch = cleanInput.replace(/\D/g, "").slice(-10);
    const phoneQuery = phoneMatch.length >= 10 ? `%${phoneMatch}%` : 'NO_MATCH';

    const { rows } = await pool.query(`
      SELECT o.order_number, o.created_at, o.fulfillment_status, o.financial_status,
             s.awb, s.courier_source, s.last_state, s.last_status,
             s.history AS db_history, s.last_checked_at
      FROM orders_ops o
      LEFT JOIN shipments_ops s ON s.order_id::text = o.id::text
      WHERE o.customer_phone::text LIKE $1 OR s.awb ILIKE $2
      ORDER BY o.created_at DESC LIMIT 5
    `, [phoneQuery, cleanInput]);

    // 🟢 FRIEND'S FIX: Sequential fetching to prevent API rate-limit bans
    const refreshed = [];
    for (const row of rows) {
      if (!row.awb || row.last_state === 'DELIVERED') {
        refreshed.push(row);
        continue;
      }
      const safeAwb = String(row.awb || "").toUpperCase();
      const isTestAwb = safeAwb.includes('TEST') || safeAwb.length < 5;
      const lastCheck = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
      
      if (!isTestAwb && Date.now() - lastCheck > 30 * 60 * 1000) {
        const fresh = await forceRefreshShipment(row.awb, row.courier_source);
        if (fresh) {
          row.last_state = resolveShipmentState(fresh.status, fresh.history);
          row.last_status = fresh.status;
          row.db_history = fresh.history;
        }
        await new Promise(r => setTimeout(r, 400)); // Breathe for 400ms between live calls!
      }
      refreshed.push(row);
    }
    const results = refreshed.map(row => {
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];
      if (row.fulfillment_status === 'fulfilled') {
        history.push({ status: "Dispatched", date: "Order Packed", completed: true });
      }
      if (Array.isArray(row.db_history)) history = [...history, ...row.db_history];

      let currentState = row.last_state || (row.fulfillment_status === 'fulfilled' ? "IN_TRANSIT" : "PROCESSING");

      const historyStr = JSON.stringify(row.db_history || []).toUpperCase();
      if (
        row.financial_status === 'cancelled' ||
        row.financial_status === 'voided' ||
        row.financial_status === 'refunded' ||
        row.last_status?.toUpperCase().includes('CANCEL') ||
        historyStr.includes('CANCEL')
      ) {
        currentState = "CANCELLED";
      }

      return {
        shopify_order_name: row.order_number,
        awb: row.awb,
        current_state: currentState,
        courier: row.courier_source,
        last_known_status: row.last_status || "Shipment info will be updated shortly",
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
   🚚 EDD ENDPOINT
================================ */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^\d{6}$/.test(pincode)) return res.json({ edd_display: null });
  if (eddCache.has(pincode)) return res.json(eddCache.get(pincode));

  const city = await getCity(pincode);

  let rawDate = await predictBluedartEDD(pincode);
  let source = "BlueDart";

  if (!rawDate) {
    rawDate = await predictShiprocketEDD(pincode);
    source = "Shiprocket";
  }

  if (!rawDate) return res.json({ edd_display: null });

  const METRO = ["MUMBAI", "DELHI", "BANGALORE", "PUNE", "HYDERABAD", "CHENNAI", "KOLKATA"];
  const data = {
    edd_display: formatConfidenceBand(rawDate),
    city,
    badge: city && METRO.some(m => city.toUpperCase().includes(m)) ? "METRO_EXPRESS" : "EXPRESS",
    source
  };

  const EDD_CACHE_MAX = 500;
  if (eddCache.size >= EDD_CACHE_MAX) {
    eddCache.delete(eddCache.keys().next().value);
  }
  eddCache.set(pincode, data);
  res.json(data);
});

/* ===============================
   ✅ PAGINATED ORDERS ENDPOINT (OPS) - 🟢 EGRESS PROTECTED
================================ */
app.get("/ops/orders", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 250);
    const offset = (page - 1) * limit;

    let whereClause = "";
    let queryArgs = [limit, offset];      

    // FRIEND'S FIX 2: We use $3 for the main query, and $1 for the count query later
    if (req.query.updated_after) {
      whereClause = `WHERE o.updated_at >= $3 OR s.last_checked_at >= $3 OR r.updated_at >= $3`;
      queryArgs.push(req.query.updated_after);
    }

    const { rows } = await pool.query(`
      SELECT
        o.id, o.order_number, o.created_at, o.financial_status, o.fulfillment_status,
        o.total_price, o.payment_gateway_names, o.line_items, o.is_exchange, o.is_return, o.source,
        COALESCE(o.customer_name, s.raw_data->'shipment_track'->0->>'consignee_name', 'Guest') AS customer_name,
        COALESCE(o.customer_email, s.raw_data->'shipment_track'->0->>'email') AS customer_email,
        COALESCE(o.customer_phone, s.raw_data->'shipment_track'->0->>'mobile') AS customer_phone,
        COALESCE(o.city, s.raw_data->'shipment_track'->0->>'destination') AS city,
        COALESCE(
          CONCAT(o.shipping_address->>'address1', ', ', o.shipping_address->>'city', ' - ', o.shipping_address->>'zip'),
          o.city
        ) AS full_address,
        s.awb, s.courier_source, s.last_state, s.last_status,
        s.raw_data->'shipment_track'->0->>'delivered_date' AS delivered_date,
        s.raw_data->'shipment_track'->0->>'edd' AS expected_delivery_date,
        (
          SELECT activity FROM jsonb_to_recordset(
            CASE WHEN jsonb_typeof(s.raw_data->'shipment_track_activities') = 'array'
              THEN s.raw_data->'shipment_track_activities' ELSE '[]'::jsonb END
          ) AS x(activity text, "sr-status" text)
          WHERE "sr-status" IN ('6','13','14','19','20','21','53','54','55','56') LIMIT 1
        ) AS ndr_reason,
        r.status AS return_status
      FROM orders_ops o
      -- 🟢 FRIEND'S FIX: LATERAL JOIN picks only the newest AWB if an order has multiples
      LEFT JOIN LATERAL (
        SELECT * FROM shipments_ops 
        WHERE order_id::text = o.id::text 
        ORDER BY last_checked_at DESC NULLS LAST 
        LIMIT 1
      ) s ON true
      LEFT JOIN returns_ops r ON r.order_number::text = o.order_number::text
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $1 OFFSET $2
    `, queryArgs);

    // FRIEND'S FIX 3: Safe, fast count query separated out
    let countRes;
    
    if (req.query.updated_after) {
      countRes = await pool.query(`
        SELECT COUNT(*)
        FROM orders_ops o
        LEFT JOIN shipments_ops s ON s.order_id::text = o.id::text
        LEFT JOIN returns_ops r ON r.order_number::text = o.order_number::text
        WHERE o.updated_at >= $1 OR s.last_checked_at >= $1 OR r.updated_at >= $1
      `, [req.query.updated_after]); 
    } else {
      countRes = await pool.query(`SELECT COUNT(*) FROM orders_ops`);
    }

    const optimizedRows = rows.map(r => ({
      ...r,
      line_items: (r.line_items || []).map(item => ({ title: item.title }))
    }));

    res.json({
      orders: optimizedRows,
      pagination: {
        total: parseInt(countRes.rows[0].count),
        page,
        totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limit)
      }
    });
  } catch (e) {
    res.status(500).json({ error: "DB Error: " + e.message });
  }
});

/* ===============================
   📊 OPS ENDPOINTS
================================ */
app.get("/ops/logs", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 100`);
    res.json({ logs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/ops/api-usage", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`
      SELECT log_date, provider, calls FROM api_usage_ops
      WHERE log_date >= CURRENT_DATE - INTERVAL '14 days'
      ORDER BY log_date DESC, provider ASC
    `);
    res.json({ usage: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/recon/ops", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_exchange = FALSE AND is_return = FALSE) AS net_new_orders,
        COUNT(*) FILTER (WHERE is_return = TRUE) AS total_returns,
        COUNT(*) FILTER (WHERE financial_status != 'paid' AND fulfillment_status = 'fulfilled') AS cod_at_risk
      FROM orders_ops
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);
    res.json({ summary: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ===============================
   🔍 ADMIN DEBUG TOOLS
================================ */
app.get("/admin/debug-awb", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB Required" });
  try {
    const { rows } = await pool.query(
      `SELECT awb, order_id, courier_source, delivered, last_status, last_state, next_check_at, last_checked_at FROM shipments_ops WHERE awb = $1`,
      [awb]
    );
    if (rows.length === 0) return res.status(404).json({ error: "AWB not found" });
    res.json({ db_row: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/debug-order", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Order ID Required" });
  try {
    const { rows } = await pool.query(
      `SELECT id, order_number, financial_status, fulfillment_status, created_at FROM orders_ops WHERE id = $1 OR order_number = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Order not found" });
    res.json({ db_row: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/debug-returns", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  try {
    const { rows } = await pool.query(`SELECT * FROM returns_ops ORDER BY updated_at DESC LIMIT 50`);
    res.json({ total_records: rows.length, recent_data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/circuit-status", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const status = {};
  for (const [provider, cb] of Object.entries(circuitBreakers)) {
    status[provider] = {
      failures: cb.failures,
      isOpen: cb.openUntil > Date.now(),
      opensAt: cb.openUntil ? new Date(cb.openUntil).toISOString() : null
    };
  }
  res.json({ circuit_breakers: status });
});

app.get("/admin/force-single", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB Required" });
  try {
    const r = await pool.query(`SELECT courier_source FROM shipments_ops WHERE awb = $1`, [awb]);
    if (r.rows.length === 0) return res.status(404).json({ error: "AWB not in DB" });
    const result = await forceRefreshShipment(awb, r.rows[0].courier_source);
    res.json({ success: !!result, data: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ===============================
   🚀 DEEP SYNC
================================ */
app.get("/admin/deep-sync", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  res.json({ message: "Deep sync started from Jan 1, 2026. Check Render logs for progress." });

  (async () => {
    const minDate = new Date("2026-01-01T00:00:00Z").toISOString();
    let url = `https://${clean(SHOP_NAME)}.myshopify.com/admin/api/${API_VER}/orders.json?status=any&limit=250&updated_at_min=${minDate}`;
    let totalSynced = 0;

    while (url) {
      try {
        const r = await axios.get(url, { headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) } });
        const orders = r.data.orders || [];
        if (orders.length === 0) break;

        for (const o of orders) {
          await syncOrder(o);
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        totalSynced += orders.length;
        logEvent('INFO', 'DEEP_SYNC', `Progress: ${totalSynced} orders`);
        console.log(`✅ Synced ${totalSynced} orders so far...`);

        const link = r.headers.link || '';
        const match = link.match(/<([^>]+)>;\s*rel="next"/);
        url = match ? match[1] : null;
      } catch (e) {
        logEvent('ERROR', 'DEEP_SYNC', 'Page failed', { error: e.message });
        break;
      }
    }
    logEvent('INFO', 'DEEP_SYNC', `Complete: ${totalSynced} orders synced from Jan 1st.`);
    console.log(`🎉 DEEP SYNC COMPLETE. Total: ${totalSynced} orders.`);
  })();
});

/* ===============================
   🚀 LOGISTICS BATCH REFRESH
================================ */
let massRefreshRunning = false; // 🟢 THE LOCK

app.get("/ops/refresh-logistics", async (req, res) => {
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
  
  // 🟢 BOUNCE SPAMMERS
  if (massRefreshRunning) {
    return res.status(429).json({ error: "A mass-refresh is already running! Please check back in 15 minutes." });
  }
  
  massRefreshRunning = true;
  res.json({ message: "Background mass-refresh started. Up to 500 packages. Check back in ~15 mins." });

  (async () => {
    try {
      const { rows } = await pool.query(`
        SELECT awb, courier_source FROM shipments_ops
        WHERE (delivered = FALSE OR delivered IS NULL)
        ORDER BY last_checked_at ASC NULLS FIRST LIMIT 500
      `);
      logEvent('INFO', 'RECOVERY', `Background sweep started for ${rows.length} shipments`);
      for (const r of rows) {
        await forceRefreshShipment(r.awb, r.courier_source);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      logEvent('INFO', 'RECOVERY', `Background sweep finished`);
    } catch (e) {
      logEvent('ERROR', 'RECOVERY', 'Sweep crashed', { error: e.message });
    } finally {
      massRefreshRunning = false; // 🟢 RELEASE THE LOCK
    }
  })();
});

/* ===============================
   ⏰ BACKGROUND JOBS
================================ */
async function runBackfill() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) return;
  try {
    const r = await axios.get(
      `https://${clean(SHOP_NAME)}.myshopify.com/admin/api/${API_VER}/orders.json?status=any&limit=50`,
      { headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) } }
    );
    for (const o of r.data.orders || []) await syncOrder(o);
    logEvent('INFO', 'BACKFILL', `Backfilled ${r.data.orders?.length} orders`);
  } catch (e) { logEvent('ERROR', 'BACKFILL', 'Backfill Failed', { error: e.message }); }
}

async function runSafetyNet() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOP_NAME) return;
  const d = new Date(); d.setDate(d.getDate() - 10);
  try {
    logEvent('INFO', 'SAFETY_NET', 'Running 10-day catch-up scan...');
    const r = await axios.get(
      `https://${clean(SHOP_NAME)}.myshopify.com/admin/api/${API_VER}/orders.json?status=any&limit=250&updated_at_min=${d.toISOString()}`,
      { headers: { "X-Shopify-Access-Token": clean(SHOPIFY_ACCESS_TOKEN) } }
    );
    const orders = r.data.orders || [];
    for (const o of orders) await syncOrder(o);
    logEvent('INFO', 'SAFETY_NET', `Updated ${orders.length} orders`);
  } catch (e) { logEvent('ERROR', 'SAFETY_NET', 'Safety Net Failed', { error: e.message }); }
}

cron.schedule('0 */12 * * *', runSafetyNet);

cron.schedule('10 14 * * *', () => {
  eddCache.clear();
  logEvent('INFO', 'CACHE', 'EDD Cache cleared at 14:10 IST');
}, { scheduled: true, timezone: "Asia/Kolkata" });

cron.schedule('0 3 * * *', async () => {
  await pool.query(`DELETE FROM processed_webhooks WHERE processed_at < NOW() - INTERVAL '7 days'`).catch(console.error);
  await pool.query(`DELETE FROM system_logs WHERE timestamp < NOW() - INTERVAL '30 days'`).catch(console.error);
  logEvent('INFO', 'CLEANUP', 'Old logs and webhook records pruned');
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of rateLimiter.entries()) {
    if (now - r.t > 60000) rateLimiter.delete(ip);
  }
}, 60 * 60 * 1000);

/* ===============================
   🏥 HEALTH ENDPOINT
================================ */
app.get("/health", async (req, res) => {
  try {
    const dbRes = await pool.query('SELECT COUNT(*) FROM shipments_ops WHERE delivered IS DISTINCT FROM TRUE AND next_check_at <= NOW()');
    const pending = parseInt(dbRes.rows[0].count);
    const cbStatus = {};
    for (const [p, cb] of Object.entries(circuitBreakers)) {
      cbStatus[p] = cb.openUntil > Date.now() ? 'OPEN' : 'CLOSED';
    }
    res.json({
      status: "READY",
      pendingShipments: pending,
      circuitBreakers: cbStatus,
      eddCacheSize: eddCache.size,
      uptime: Math.floor(process.uptime()) + "s"
    });
  } catch (e) {
    res.status(500).json({ status: "DEGRADED", error: e.message });
  }
});

/* ===============================
   🛑 GRACEFUL SHUTDOWN
================================ */
async function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  if (schedulerInterval) clearTimeout(schedulerInterval);
  
  // 🟢 FRIEND'S FIX: Hard-unlock all advisory locks on shutdown
  await pool.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
  
  await pool.end();
  console.log("✅ DB pool closed. Exiting.");
  process.exit(0);
}

/* ===============================
   🚀 STARTUP SEQUENCE
================================ */
const PORT = process.env.PORT || 10000;

(async () => {
  await runMigrations();
  setTimeout(runBackfill, 5000);
  startScheduler();
  app.listen(PORT, () => console.log(`🚀 HighSpark Logistics Master v5.1 LIVE on :${PORT}`));
})();