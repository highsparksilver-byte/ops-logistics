import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

/* ===============================
   🚀 APP INIT
================================ */
const app = express();
app.use(express.json());

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
   🔑 ENV HELPERS
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
  SHIPROCKET_PASSWORD
} = process.env;

/* ===============================
   🗄️ DB (unused in Phase 1.5 but kept safe)
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🕒 DATE HELPERS (IST SAFE)
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
  const c = city.toUpperCase();
  return METROS.some(m => c.includes(m))
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
   📅 EDD CORE LOGIC (PATCHED)
================================ */
/**
 * RULES IMPLEMENTED:
 * - Fastest date NEVER changes
 * - Buffer applies ONLY to end date
 * - No +1 after 6pm logic
 * - Metro affects badge only
 */
function confidenceBand(fastestDate) {
  if (!fastestDate) return null;

  const start = new Date(fastestDate);
  const end = new Date(start);

  // widen ONLY the end
  end.setDate(end.getDate() + 1);

  const fmt = d =>
    `${String(d.getDate()).padStart(2,"0")}-${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;

  if (
    start.getDate() === end.getDate() &&
    start.getMonth() === end.getMonth()
  ) {
    return fmt(start);
  }

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
   🚚 TRACKING (FROZEN GOLD)
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
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

/* ===============================
   🚀 START
================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);