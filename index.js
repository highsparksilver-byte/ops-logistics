import express from "express";
import axios from "axios";
import xml2js from "xml2js";

const app = express();
app.use(express.json());

/* =================================================
   🌍 CORS (SHOPIFY SAFE)
================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

/* =================================================
   🔑 CREDENTIALS
================================================= */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics starting...");
console.log("📍 Warehouse: Pune (411022)");

/* =================================================
   📅 HOLIDAYS
================================================= */
const HOLIDAYS = [
  "2026-01-26",
  "2026-03-03",
  "2026-08-15",
  "2026-10-02",
  "2026-11-01",
];

/* =================================================
   🔑 JWT CACHE
================================================= */
let bdJwt = null;
let bdJwtAt = 0;
let srJwt = null;
let srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;

  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    }
  );

  bdJwt = res.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now() - srJwtAt < 8 * 24 * 60 * 60 * 1000) return srJwt;

  try {
    const res = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      { email: SR_EMAIL, password: SR_PASSWORD }
    );
    srJwt = res.data.token;
    srJwtAt = Date.now();
    return srJwt;
  } catch {
    return null;
  }
}

/* =================================================
   🇮🇳 DATE HELPERS
================================================= */
function getIndiaDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 5.5 * 60 * 60 * 1000);
}

function isNonWorkingDay(d) {
  const day = d.getDay();
  const ymd = d.toISOString().slice(0, 10);
  return day === 0 || HOLIDAYS.includes(ymd);
}

function calculatePickupDate() {
  const now = getIndiaDate();
  let d = new Date(now);

  if (now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() >= 45)) {
    d.setDate(d.getDate() + 1);
  }

  while (isNonWorkingDay(d)) {
    d.setDate(d.getDate() + 1);
  }

  return `/Date(${d.getTime()})/`;
}

/* =================================================
   📦 EDD HELPERS
================================================= */
function parseBlueDartDate(str) {
  if (!str) return null;
  const [dd, mon, yyyy] = str.split("-");
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  return new Date(Date.UTC(yyyy, months[mon.toLowerCase()], dd));
}

function calculateConfidenceBand(eddStr) {
  const min = parseBlueDartDate(eddStr);
  if (!min) return null;

  let max = new Date(min);
  max.setUTCDate(max.getUTCDate() + 1);

  while (isNonWorkingDay(max)) {
    max.setUTCDate(max.getUTCDate() + 1);
  }

  const fmt = (d) =>
    `${d.getUTCDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]}`;

  return min.getUTCMonth() === max.getUTCMonth()
    ? `${min.getUTCDate()}–${fmt(max)}`
    : `${fmt(min)} – ${fmt(max)}`;
}

/* =================================================
   🛡️ EDD RATE LIMIT (LIGHT)
================================================= */
const eddRateMap = new Map();

function allowEdd(ip) {
  const now = Date.now();
  const limit = 20;
  const windowMs = 60 * 60 * 1000;

  const e = eddRateMap.get(ip) || { count: 0, ts: now };

  if (now - e.ts > windowMs) {
    e.count = 0;
    e.ts = now;
  }

  e.count++;
  eddRateMap.set(ip, e);

  return e.count <= limit;
}

/* =================================================
   🧠 DAILY EDD CACHE
================================================= */
const eddCache = new Map();

/* =================================================
   🛣️ EDD ROUTE
================================================= */
app.post("/edd", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  if (!allowEdd(ip)) {
    return res.status(429).json({ error: "Too many requests" });
  }

  let { pincode } = req.body;
  pincode = String(pincode || "").trim();

  if (!/^[1-9][0-9]{5}$/.test(pincode)) {
    return res.status(400).json({ error: "Invalid pincode" });
  }

  const today = getIndiaDate().toISOString().slice(0, 10);
  const key = `${pincode}-${today}`;

  if (eddCache.has(key)) {
    return res.json({ ...eddCache.get(key), cached: true });
  }

  let edd = null;

  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: calculatePickupDate(),
        pPickupTime: "16:00",
        profile: { Api_type: "S", LicenceKey: LICENCE_KEY_EDD, LoginID: LOGIN_ID },
      },
      { headers: { JWTToken: jwt } }
    );

    edd =
      r.data?.GetDomesticTransitTimeForPinCodeandProductResult
        ?.ExpectedDateDelivery || null;
  } catch {}

  if (!edd) {
    try {
      const token = await getShiprocketJwt();
      if (token) {
        const sr = await axios.get(
          `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pincode}&cod=1&weight=0.5`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        const c = sr.data?.data?.available_courier_companies;
        if (c?.length) edd = c[0].etd;
      }
    } catch {}
  }

  const response = {
    edd: edd || null,
    edd_display: edd ? calculateConfidenceBand(edd) : null,
    badge: edd ? "STANDARD" : null,
  };

  if (edd) eddCache.set(key, response);
  res.json(response);
});

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);