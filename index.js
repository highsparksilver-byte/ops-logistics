import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT
================================ */
const app = express();

// ✅ FIX: Capture Raw Body for HMAC Verification
app.use(express.json({ 
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

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
  CLIENT_ID,
  CLIENT_SECRET,
  LOGIN_ID,
  BD_LICENCE_KEY_TRACK,
  BD_LICENCE_KEY_EDD,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
  DATABASE_URL,
  SHOPIFY_WEBHOOK_SECRET
} = process.env; // Simplified for safety

/* ===============================
   🗄️ DATABASE
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
   🏙️ METRO BADGE
================================ */
const METROS = ["MUMBAI","DELHI","BANGALORE","PUNE","CHENNAI","HYDERABAD","KOLKATA","AHMEDABAD"];
const badgeFor = city =>
  city && METROS.some(m => city.toUpperCase().includes(m))
    ? "METRO_EXPRESS"
    : "EXPRESS";

/* ===============================
   🔐 TOKEN CACHE
================================ */
let bdJwt, bdJwtAt = 0;
let srJwt, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23*60*60*1000) return bdJwt;
  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } }
  );
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 7*24*60*60*1000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   📅 EDD
================================ */
function confidenceBand(fastestDate) {
  if (!fastestDate || isNaN(fastestDate)) return null;
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
  } catch { return null; }
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
        pPudate: getNextWorkingDate(),
        pPickupTime: "16:00",
        profile: { Api_type: "S", LicenceKey: clean(BD_LICENCE_KEY_EDD), LoginID: clean(LOGIN_ID) }
      },
      { headers: { JWTToken: jwt } }
    );
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch { return null; }
}

async function getShiprocketEDD(pin) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pin}&cod=1&weight=0.5`,
      { headers: { Authorization: `Bearer ${t}` } }
    );
    return r.data?.data?.available_courier_companies?.[0]?.etd || null;
  } catch { return null; }
}

app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode)) return res.json({ edd_display: null });

  const city = await getCity(pincode);
  let fastest = await getBluedartEDD(pincode) || await getShiprocketEDD(pincode);
  if (!fastest) return res.json({ edd_display: null });

  res.json({
    edd_display: confidenceBand(new Date(fastest)),
    city,
    badge: badgeFor(city)
  });
});

/* ===============================
   🚚 TRACKING (LEGACY + SMART LOOKUP)
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
    // Uses Google Script Logic (Legacy Servlet + verno=1)
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      params: {
        handler: "tnt",
        action: "custawbquery",
        loginid: clean(LOGIN_ID),
        awb: "awb",
        numbers: awb,
        format: "xml",
        lickey: clean(BD_LICENCE_KEY_TRACK),
        verno: 1,
        scan: 1
      },
      responseType: "text"
    });

    if (r.data.includes("<html")) return null;
    const p = await xml2js.parseStringPromise(r.data, { explicitArray:false });
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status,
      statusType: getStatusType(s.Status),
      statusDate: s.StatusDate,
      statusTime: s.StatusTime,
      delivered: getStatusType(s.Status)==="DL",
      raw: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : [s.Scans?.ScanDetail || null]
    };
  } catch { return null; }
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

    const scan = td.shipment_track_activities?.[0] || {};
    const [date,time] = (scan.date || "").split(" ");

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || "Shiprocket",
      status: td.current_status,
      statusType: getStatusType(td.current_status),
      statusDate: date || null,
      statusTime: time || null,
      delivered: getStatusType(td.current_status)==="DL",
      raw: td.shipment_track_activities || []
    };
  } catch { return null; }
}

app.get("/track", async (req,res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error:"awb_required" });

  // 1. Check DB for preferred courier
  let courier = null;
  try {
      const { rows } = await pool.query("SELECT courier_source FROM shipments_ops WHERE awb=$1", [awb]);
      courier = rows[0]?.courier_source;
  } catch (e) { console.error("DB Read Error", e.message); }

  let data = null;
  
  // 2. Route intelligently
  if (courier === "bluedart") {
    data = await trackBluedart(awb);
  } else if (courier === "shiprocket") {
    data = await trackShiprocket(awb);
  } else {
    // 3. Fallback: Try BD, then SR
    data = await trackBluedart(awb) || await trackShiprocket(awb);
  }

  if (!data) return res.status(404).json({ error:"not_found" });
  res.json(data);
});

/* ===============================
   🧾 PHASE 3B — FULFILLMENT WEBHOOK
================================ */
function verifyShopify(req) {
  const secret = clean(process.env.SHOPIFY_WEBHOOK_SECRET);
  if (!secret) return true;
  
  // ✅ FIX: Use req.rawBody for accurate HMAC
  if (!req.rawBody) return false;

  const hmac = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");
  return hmac === digest;
}

app.post("/webhooks/fulfillments_create", async (req,res) => {
  res.sendStatus(200);
  
  if (!verifyShopify(req)) {
      console.error("❌ Invalid Webhook HMAC");
      return;
  }

  const f = req.body;
  const awb = f.tracking_number;
  if (!awb) return;

  const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";

  try {
      await pool.query(
        `INSERT INTO shipments_ops (order_id, awb, courier_source)
         VALUES ($1,$2,$3)
         ON CONFLICT (awb) DO NOTHING`,
        [f.order_id, awb, courier]
      );
      console.log(`✅ Linked AWB ${awb} to ${courier}`);
  } catch (e) {
      console.error("DB Write Error:", e.message);
  }
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_,res)=>res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log("🚀 Ops Logistics running on",PORT));