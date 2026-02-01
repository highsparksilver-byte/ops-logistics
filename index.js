import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT
================================ */
const app = express();

app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

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
   🔐 SECURITY
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret) {
    console.error("⚠️ SECURITY WARN: No Secret in .env");
    return true; 
  }
  if (!req.rawBody) {
    console.error("⚠️ SECURITY FAIL: No Body");
    return false;
  }
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  const isValid = digest === req.headers["x-shopify-hmac-sha256"];
  
  if (!isValid) console.error("❌ SIGNATURE MISMATCH");
  return isValid;
}

/* ===============================
   🕒 HELPERS
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
   📦 TRACKING HELPERS (NORMALIZED)
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
    
    // Normalize History
    const rawScans = Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail || null];
    const history = rawScans.filter(Boolean).map(scan => ({
        status: scan.Scan,
        date: `${scan.ScanDate} ${scan.ScanTime}`,
        location: scan.ScannedLocation,
        completed: true
    }));

    return {
      source: "bluedart", status: s.Status, statusType: getStatusType(s.Status),
      delivered: getStatusType(s.Status)==="DL",
      history: history
    };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } });
    const td = r.data?.tracking_data;
    if (!td) return null;

    // Normalize History
    const rawScans = td.shipment_track_activities || [];
    const history = rawScans.map(scan => ({
        status: scan.activity,
        date: scan.date,
        location: scan.location,
        completed: true
    }));

    return {
      source: "shiprocket", status: td.current_status, statusType: getStatusType(td.current_status),
      delivered: getStatusType(td.current_status)==="DL",
      history: history
    };
  } catch { return null; }
}

/* ===============================
   🔍 CUSTOMER LOOKUP (NEW!)
================================ */
app.post("/track/customer", async (req, res) => {
  const { phone, email } = req.body;
  // Match last 10 digits
  const cleanPhone = phone?.replace(/\D/g, "").slice(-10);

  if (!cleanPhone && !email) return res.status(400).json({ error: "Phone or Email required" });

  try {
    // 1. Find Orders by Phone OR Email
    const { rows } = await pool.query(`
      SELECT o.order_number, o.financial_status, o.fulfillment_status, o.payment_gateway_names,
             s.awb, s.courier_source, o.created_at
      FROM orders_ops o
      LEFT JOIN shipments_ops s ON s.order_id = o.id
      WHERE (o.customer_phone LIKE $1) OR (o.customer_email = $2)
      ORDER BY o.created_at DESC
      LIMIT 5
    `, [`%${cleanPhone}`, email]);

    if (rows.length === 0) return res.json({ orders: [] });

    // 2. Fetch Live Tracking
    const ordersWithTracking = await Promise.all(rows.map(async (row) => {
      let tracking = null;
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];

      if (row.awb) {
         history.push({ status: "Dispatched", date: "Processing", completed: true });
         if (row.courier_source === "bluedart") tracking = await trackBluedart(row.awb);
         else if (row.courier_source === "shiprocket") tracking = await trackShiprocket(row.awb);
         
         if (tracking && tracking.history) history = [...history, ...tracking.history];
      }

      const isCod = JSON.stringify(row.payment_gateway_names || "").toLowerCase().includes("cod");
      
      return {
        shopify_order_name: row.order_number,
        awb: row.awb || "Pending",
        courier: row.courier_source || "Pending",
        financial_status: row.financial_status,
        fulfillment_status: row.fulfillment_status,
        is_cod: isCod,
        delivered: tracking?.delivered || false,
        last_known_status: tracking?.status || "Processing",
        tracking_history: history
      };
    }));

    res.json({ orders: ordersWithTracking });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ===============================
   📦 TRACKING (LEGACY)
================================ */
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
   🧾 WEBHOOKS (FINAL VERSION)
================================ */
app.post("/webhooks/orders_paid", async (req,res) => {
  console.log("🔔 Webhook: orders_paid");
  res.sendStatus(200);
  if (!verifyShopify(req)) return;

  const o = req.body;
  const email = o.email || o.customer?.email;
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone;
  // Use Shopify Date (or fallback to Now)
  const trueDate = o.created_at || new Date().toISOString();

  try {
    await pool.query(`
      INSERT INTO orders_ops (
        id, order_number, financial_status, fulfillment_status, 
        total_price, payment_gateway_names, customer_email, customer_phone, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        payment_gateway_names = EXCLUDED.payment_gateway_names,
        customer_email = EXCLUDED.customer_email,
        customer_phone = EXCLUDED.customer_phone,
        created_at = EXCLUDED.created_at
    `, [
      o.id, o.name, o.financial_status, o.fulfillment_status,
      o.total_price, JSON.stringify(o.payment_gateway_names || []),
      email, phone, trueDate
    ]);
    console.log(`✅ Saved Order ${o.name} | Date: ${trueDate} | Phone: ${phone}`);
  } catch (e) { console.error("🔥 DB Error:", e.message); }
});

app.post("/webhooks/fulfillments_create", async (req,res) => {
  console.log("🔔 Webhook: fulfillments_create");
  res.sendStatus(200);
  if (!verifyShopify(req)) return;

  const f = req.body;
  const awb = f.tracking_number;
  if (!awb) return;
  const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  try {
    await pool.query(`
      INSERT INTO shipments_ops (order_id, awb, courier_source)
      VALUES ($1,$2,$3)
      ON CONFLICT (awb) DO NOTHING
    `,[f.order_id, f.tracking_number, courier]);
    console.log(`✅ Linked AWB ${awb} to ${courier}`);
  } catch (e) { console.error("🔥 DB Error:", e.message); }
});

/* ===============================
   📊 RECON (CHUNKED)
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

app.get("/ops/orders", async (_,res) => {
  const { rows } = await pool.query("SELECT * FROM orders_ops ORDER BY created_at DESC LIMIT 100");
  res.json({ count: rows.length, orders: rows });
});

app.get("/health", (_,res)=>res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log("🚀 Ops Logistics running on",PORT));