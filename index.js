import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT (LOUD DEBUG MODE)
================================ */
const app = express();

// 1. Capture Raw Body for Security
app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// 2. Global Logger - Prints EVERY request hitting the server
app.use((req, res, next) => {
  console.log(`📡 INCOMING: ${req.method} ${req.url}`);
  next();
});

/* ===============================
   🌍 CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===============================
   🔑 ENV
================================ */
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();
const {
  CLIENT_ID, CLIENT_SECRET, LOGIN_ID,
  BD_LICENCE_KEY_TRACK, BD_LICENCE_KEY_EDD,
  SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD,
  DATABASE_URL, SHOPIFY_WEBHOOK_SECRET
} = process.env;

/* ===============================
   🗄️ DATABASE
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🔐 SECURITY DEBUGGER
================================ */
function verifyShopify(req) {
  // 1. Check Secret
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret) {
    console.error("⚠️ SECURITY FAIL: SHOPIFY_WEBHOOK_SECRET is missing in .env");
    return true; // Allow in dev, but warn
  }

  // 2. Check Raw Body
  if (!req.rawBody) {
    console.error("⚠️ SECURITY FAIL: No rawBody captured. Is the payload empty?");
    return false;
  }

  // 3. Check Signature Header
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) {
    console.error("⚠️ SECURITY FAIL: Missing X-Shopify-Hmac-Sha256 header");
    return false;
  }

  // 4. Calculate Expected Signature
  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  // 5. Compare
  if (digest !== hmacHeader) {
    console.error(`❌ SIGNATURE MISMATCH!`);
    console.error(`   > Shopify Sent: ${hmacHeader}`);
    console.error(`   > We Calculated: ${digest}`);
    console.error(`   > Double check your SHOPIFY_WEBHOOK_SECRET in Render!`);
    return false;
  }

  console.log("✅ Security Passed: Valid Shopify Webhook");
  return true;
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
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return `/Date(${d.getTime()})/`;
}

/* ===============================
   🔐 TOKEN CACHE
================================ */
let bdJwt, bdJwtAt = 0;
let srJwt, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23*60*60*1000) return bdJwt;
  const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { 
    headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } 
  });
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}
async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 7*24*60*60*1000) return srJwt;
  const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { 
    email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) 
  });
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   📅 EDD ROUTE
================================ */
function confidenceBand(fastestDate) {
  if (!fastestDate || isNaN(fastestDate)) return null;
  const start = new Date(fastestDate);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const fmt = d => `${String(d.getDate()).padStart(2,"0")}-${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
  return `${fmt(start)}–${fmt(end)}`;
}

async function getCity(pin) {
  try {
    const r = await axios.get(`https://api.postalpincode.in/pincode/${pin}`);
    return r.data?.[0]?.PostOffice?.[0]?.District || null;
  } catch { return null; }
}

async function getBluedartEDD(pin) {
  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post("https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct", {
        pPinCodeFrom: "411022", pPinCodeTo: pin, pProductCode: "A", pSubProductCode: "P",
        pPudate: getNextWorkingDate(), pPickupTime: "16:00",
        profile: { Api_type: "S", LicenceKey: clean(BD_LICENCE_KEY_EDD), LoginID: clean(LOGIN_ID) }
      }, { headers: { JWTToken: jwt } });
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch { return null; }
}

async function getShiprocketEDD(pin) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pin}&cod=1&weight=0.5`, { headers: { Authorization: `Bearer ${t}` } });
    return r.data?.data?.available_courier_companies?.[0]?.etd || null;
  } catch { return null; }
}

app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode)) return res.json({ edd_display: null });
  const city = await getCity(pincode);
  let fastest = await getBluedartEDD(pincode) || await getShiprocketEDD(pincode);
  if (!fastest) return res.json({ edd_display: null });
  const METROS = ["MUMBAI","DELHI","BANGALORE","PUNE","CHENNAI","HYDERABAD","KOLKATA","AHMEDABAD"];
  const badge = city && METROS.some(m => city.toUpperCase().includes(m)) ? "METRO_EXPRESS" : "EXPRESS";
  res.json({ edd_display: confidenceBand(new Date(fastest)), city, badge });
});

/* ===============================
   📦 TRACKING
================================ */
function getStatusType(s="") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";
  if (s.includes("RTO") || s.includes("RETURN")) return "RT";
  if (s.includes("OUT FOR")) return "OF";
  return "UD";
}

async function trackBluedart(awb) {
  try {
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: "awb", numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 },
      responseType: "text"
    });
    if (r.data.includes("<html")) return null;
    const p = await xml2js.parseStringPromise(r.data, { explicitArray:false });
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;
    return {
      source: "bluedart", status: s.Status, statusType: getStatusType(s.Status),
      statusDate: s.StatusDate, statusTime: s.StatusTime, delivered: getStatusType(s.Status)==="DL",
      raw: Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail || null]
    };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } });
    const td = r.data?.tracking_data;
    if (!td) return null;
    const [date,time] = (td.shipment_track_activities?.[0]?.date || "").split(" ");
    return {
      source: "shiprocket", status: td.current_status, statusType: getStatusType(td.current_status),
      statusDate: date || null, statusTime: time || null, delivered: getStatusType(td.current_status)==="DL",
      raw: td.shipment_track_activities || []
    };
  } catch { return null; }
}

app.get("/track", async (req,res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error:"awb_required" });
  let courier = null;
  try {
      const { rows } = await pool.query("SELECT courier_source FROM shipments_ops WHERE awb=$1", [awb]);
      courier = rows[0]?.courier_source;
  } catch (e) {}
  let data = null;
  if (courier === "bluedart") data = await trackBluedart(awb);
  else if (courier === "shiprocket") data = await trackShiprocket(awb);
  else data = await trackBluedart(awb) || await trackShiprocket(awb);
  if (!data) return res.status(404).json({ error:"not_found" });
  res.json(data);
});

/* ===============================
   🧾 PHASE 3A – ORDERS (DEBUG)
================================ */
app.post("/webhooks/orders_paid", async (req,res) => {
  console.log("🔔 Webhook Triggered: orders_paid"); // VISIBILITY
  res.sendStatus(200);
  
  if (!verifyShopify(req)) return; // Fails loudly now

  const o = req.body;
  try {
    console.log(`💾 Saving Order: ${o.name}`);
    await pool.query(`
      INSERT INTO orders_ops (
        id, order_number, financial_status, fulfillment_status, 
        total_price, payment_gateway_names, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (id) DO UPDATE SET
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        payment_gateway_names = EXCLUDED.payment_gateway_names
    `, [
      o.id, o.name, o.financial_status, o.fulfillment_status,
      o.total_price, JSON.stringify(o.payment_gateway_names || [])
    ]);
    console.log("✅ Order Saved Successfully!");
  } catch (e) { 
    console.error("🔥 DB Error:", e.message); 
  }
});

/* ===============================
   📦 PHASE 3B – FULFILLMENT (DEBUG)
================================ */
app.post("/webhooks/fulfillments_create", async (req,res) => {
  console.log("🔔 Webhook Triggered: fulfillments_create"); // VISIBILITY
  res.sendStatus(200);

  if (!verifyShopify(req)) return;

  const f = req.body;
  const awb = f.tracking_number;
  if (!awb) return console.log("⚠️ No AWB in fulfillment, skipping.");

  const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  try {
    console.log(`🔗 Linking AWB ${awb} to ${courier}`);
    await pool.query(`
      INSERT INTO shipments_ops (order_id, awb, courier_source)
      VALUES ($1,$2,$3)
      ON CONFLICT (awb) DO NOTHING
    `,[f.order_id, f.tracking_number, courier]);
    console.log("✅ AWB Linked Successfully!");
  } catch (e) { 
    console.error("🔥 DB Error:", e.message); 
  }
});

/* ===============================
   📊 RECON (PARALLEL)
================================ */
async function processInChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...await Promise.all(chunk.map(fn)));
    await new Promise(r => setTimeout(r, 1000));
  }
  return out;
}

app.get("/reconciliation/cod", async (_,res) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.order_number, o.total_price, o.payment_gateway_names, o.financial_status,
             s.awb, s.courier_source
      FROM orders_ops o
      JOIN shipments_ops s ON s.order_id = o.id
      WHERE o.created_at > NOW() - INTERVAL '30 days'
    `);
    const candidates = rows.filter(r => {
      const isCOD = JSON.stringify(r.payment_gateway_names || "").toLowerCase().includes("cod");
      return isCOD && r.financial_status !== 'paid';
    });
    console.log(`🔍 Scanning ${candidates.length} COD orders...`);
    
    const checked = await processInChunks(candidates, 20, async r => {
      const t = r.courier_source === "bluedart" ? await trackBluedart(r.awb) : await trackShiprocket(r.awb);
      return { ...r, tracking: t };
    });

    const leaks = checked
      .filter(r => r.tracking?.delivered)
      .map(r => ({ order: r.order_number, awb: r.awb, amount: r.total_price, issue: "COD_LEAK" }));

    res.json({ checked: candidates.length, leaks_found: leaks.length, leaks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ===============================
   📊 OPS VIEW
================================ */
app.get("/ops/orders", async (_,res) => {
  const { rows } = await pool.query("SELECT * FROM orders_ops ORDER BY created_at DESC LIMIT 100");
  res.json({ count: rows.length, orders: rows });
});

app.get("/health", (_,res)=>res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log("🚀 Ops Logistics running on",PORT));