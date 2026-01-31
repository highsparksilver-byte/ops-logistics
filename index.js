import express from "express";
import axios from "axios";
import xml2js from "xml2js";

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

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const BD_LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);
const BD_LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);

const SHIPROCKET_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SHIPROCKET_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

/* ===============================
   🕒 DATE HELPERS (IST + SUNDAY SAFE)
================================ */
function nowIST() {
  const d = new Date();
  return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
}

// ✅ Prevent Blue Dart crash on Sundays
function getNextWorkingPickupDate() {
  const d = nowIST();
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sunday → Monday
  return `/Date(${d.getTime()})/`;
}

/* ===============================
   🏙️ METRO BADGE (UI ONLY)
================================ */
const METROS = [
  "MUMBAI","DELHI","NEW DELHI","NOIDA","GURGAON","GURUGRAM",
  "BANGALORE","BENGALURU","PUNE","CHENNAI","HYDERABAD",
  "KOLKATA","AHMEDABAD"
];

function badgeFor(city) {
  if (!city) return "EXPRESS";
  return METROS.some(m => city.toUpperCase().includes(m))
    ? "METRO_EXPRESS"
    : "EXPRESS";
}

/* ===============================
   🔐 TOKEN CACHE
================================ */
let bdJwt = null, bdJwtAt = 0;
let srJwt = null, srJwtAt = 0;

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
   📅 EDD CORE (BUSINESS-CORRECT)
================================ */
/**
 * RULES:
 * - Fastest date NEVER changes
 * - Buffer added ONLY to end date (+1)
 * - No 6pm / 11am logic
 * - Metro is badge only
 */
function confidenceBand(fastestDate) {
  if (!fastestDate || isNaN(fastestDate.getTime())) return null;

  const start = new Date(fastestDate);
  const end = new Date(start);
  end.setDate(end.getDate() + 1); // buffer ONLY on end date

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
        pPudate: getNextWorkingPickupDate(),
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
   🚚 TRACKING (UI + OPS SAFE)
================================ */
function getStatusType(s = "") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";
  if (s.includes("RTO") || s.includes("RETURN")) return "RT";
  if (s.includes("UNDELIVERED") || s.includes("FAIL")) return "NDR";
  if (s.includes("OUT FOR")) return "OF";
  if (s.includes("PICK")) return "PU";
  return "UD";
}

function normalizeStatus(v) {
  const s = (v || "").toUpperCase();
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("RTO")) return "RTO / RETURNED";
  if (s.includes("OUT FOR")) return "OUT FOR DELIVERY";
  return "IN TRANSIT";
}

async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery` +
      `&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}` +
      `&format=xml&lickey=${BD_LICENCE_KEY_TRACK}&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await xml2js.parseStringPromise(r.data, { explicitArray: false });

    const s = parsed?.ShipmentData?.Shipment;
    if (!s || !s.Status) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status,
      statusType: getStatusType(s.Status),
      statusDate: s.StatusDate || null,
      statusTime: s.StatusTime || null,
      delivered: getStatusType(s.Status) === "DL",
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
      { headers: { Authorization: `Bearer ${t}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    const scan = td.shipment_track_activities?.[0] || {};
    const parts = (scan.date || "").split(" ");

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || "Shiprocket",
      status: normalizeStatus(td.current_status),
      statusType: getStatusType(td.current_status),
      statusDate: parts[0] || null,
      statusTime: parts[1] || null,
      delivered: getStatusType(td.current_status) === "DL",
      raw: td.shipment_track_activities || []
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