import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import crypto from "crypto";
import pg from "pg";

/* ===============================
   🚀 APP INIT
================================ */
const app = express();
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

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
  DATABASE_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  LOGIN_ID,
  BD_LICENCE_KEY_EDD,
  BD_LICENCE_KEY_TRACK,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
  SHOPIFY_WEBHOOK_SECRET
} = process.env;

/* ===============================
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🧱 DB SCHEMA (SAFE)
================================ */
async function bootstrapDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders_ops (
      shopify_order_id TEXT PRIMARY KEY,
      order_name TEXT,
      payment_type TEXT,
      order_total NUMERIC,
      financial_status TEXT,
      created_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS shipments (
      awb TEXT PRIMARY KEY,
      shopify_order_id TEXT,
      platform TEXT,
      actual_courier TEXT,
      last_known_status TEXT,
      delivered_at TIMESTAMP,
      next_check_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);
  console.log("✅ DB schema ready");
}
bootstrapDB();

/* ===============================
   🕒 IST TIME
================================ */
function nowIST() {
  const d = new Date();
  return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
}

/* ===============================
   🏙️ METROS (BADGE ONLY)
================================ */
const METROS = [
  "MUMBAI","DELHI","NEW DELHI","NOIDA","GURGAON","GURUGRAM",
  "BANGALORE","BENGALURU","PUNE","CHENNAI","HYDERABAD",
  "KOLKATA","AHMEDABAD"
];

function badgeFor(city) {
  if (!city) return "STANDARD";
  return METROS.some(m => city.toUpperCase().includes(m))
    ? "METRO_EXPRESS"
    : "EXPRESS";
}

/* ===============================
   🔐 TOKEN CACHE
================================ */
let bdJwt, bdJwtAt = 0;
let srJwt, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;
  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers: { ClientID: CLIENT_ID, clientSecret: CLIENT_SECRET } }
  );
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 7 * 24 * 60 * 60 * 1000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   📅 EDD CORE
================================ */
function confidenceBand(fastestDate) {
  if (!fastestDate) return null;
  const start = new Date(fastestDate);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const fmt = d =>
    `${String(d.getDate()).padStart(2,"0")}-${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

  return `${fmt(start)}–${fmt(end)}`;
}

async function getCity(pin) {
  try {
    const r = await axios.get(`https://api.postalpincode.in/pincode/${pin}`);
    return r.data?.[0]?.PostOffice?.[0]?.District || null;
  } catch {
    return null;
  }
}

async function getBluedartEDD(pin) {
  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pin,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: `/Date(${nowIST().getTime()})/`,
        pPickupTime: "16:00",
        profile: {
          Api_type: "S",
          LicenceKey: BD_LICENCE_KEY_EDD,
          LoginID: LOGIN_ID
        }
      },
      { headers: { JWTToken: jwt } }
    );

    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult
      ?.ExpectedDateDelivery || null;
  } catch {
    return null;
  }
}

async function getShiprocketEDD(pin) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pin}&cod=1&weight=0.5`,
      { headers: { Authorization: `Bearer ${t}` } }
    );
    return r.data?.data?.available_courier_companies?.[0]?.etd || null;
  } catch {
    return null;
  }
}

/* ===============================
   📦 EDD API
================================ */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode))
    return res.json({ edd_display: null });

  const city = await getCity(pincode);
  let fastest = await getBluedartEDD(pincode);
  if (!fastest) fastest = await getShiprocketEDD(pincode);

  if (!fastest) return res.json({ edd_display: null });

  res.json({
    edd_display: confidenceBand(new Date(fastest)),
    city,
    badge: badgeFor(city)
  });
});

/* ===============================
   🚚 TRACKING (UNCHANGED)
================================ */
function normalizeStatus(v) {
  if (!v) return "IN TRANSIT";
  return v.toUpperCase().includes("DELIVERED")
    ? "DELIVERED"
    : "IN TRANSIT";
}

async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${BD_LICENCE_KEY_TRACK}&scan=1`;
    const r = await axios.get(url, { responseType: "text" });
    const p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: normalizeStatus(s.Status),
      delivered: normalizeStatus(s.Status) === "DELIVERED",
      raw: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : [s.Scans?.ScanDetail || null]
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${t}` } }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || null,
      status: normalizeStatus(td.current_status),
      delivered: normalizeStatus(td.current_status) === "DELIVERED",
      raw: td.shipment_track || []
    };
  } catch {
    return null;
  }
}

app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (!data) return res.status(404).json({ error: "not_found" });

  res.json(data);
});

/* ===============================
   🛍️ SHOPIFY WEBHOOKS (READ ONLY)
================================ */
function verifyShopify(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody, "utf8")
    .digest("base64");
  return digest === hmac;
}

app.post("/webhooks/orders_paid", async (req, res) => {
  if (!verifyShopify(req)) return res.sendStatus(401);
  const o = req.body;

  await pool.query(
    `
    INSERT INTO orders_ops
      (shopify_order_id, order_name, payment_type, order_total, financial_status)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (shopify_order_id) DO NOTHING
    `,
    [
      o.id,
      o.name,
      o.gateway === "cod" ? "COD" : "PREPAID",
      o.total_price,
      o.financial_status
    ]
  );
  res.sendStatus(200);
});

app.post("/webhooks/fulfillment_create", async (req, res) => {
  if (!verifyShopify(req)) return res.sendStatus(401);
  const f = req.body;
  const awb = f.tracking_numbers?.[0];
  if (!awb) return res.sendStatus(200);

  await pool.query(
    `
    INSERT INTO shipments (awb, shopify_order_id, platform)
    VALUES ($1,$2,$3)
    ON CONFLICT (awb) DO NOTHING
    `,
    [awb, f.order_id, "shopify"]
  );
  res.sendStatus(200);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

/* ===============================
   🚀 START
================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics Phase 2 running on", PORT)
);