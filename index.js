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
   🔑 ENV VARIABLES
================================================= */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 EDD + Tracking Server Starting...");
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
  const iso = d.toISOString().slice(0, 10);
  return day === 0 || HOLIDAYS.includes(iso);
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
  const map = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const p = str.split("-");
  if (p.length !== 3) return null;
  return new Date(Date.UTC(Number(p[2]), map[p[1].toLowerCase()], Number(p[0])));
}

function calculateConfidenceBand(eddStr) {
  const min = parseBlueDartDate(eddStr);
  if (!min) return null;

  let max = new Date(min);
  max.setUTCDate(max.getUTCDate() + 1);

  while (isNonWorkingDay(max)) {
    max.setUTCDate(max.getUTCDate() + 1);
  }

  const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const f = d => `${d.getUTCDate()} ${m[d.getUTCMonth()]}`;

  return min.getUTCMonth() === max.getUTCMonth()
    ? `${min.getUTCDate()}–${f(max)}`
    : `${f(min)} – ${f(max)}`;
}

/* =================================================
   🏙️ CITY LOOKUP
================================================= */
async function getCity(pincode) {
  try {
    const res = await axios.get(
      `https://api.postalpincode.in/pincode/${pincode}`,
      { timeout: 3000 }
    );
    if (res.data?.[0]?.Status === "Success") {
      return res.data[0].PostOffice[0].District;
    }
  } catch {}
  return null;
}

/* =================================================
   ⚡ EXPRESS BADGE
================================================= */
function getExpressBadge(eddStr, city) {
  if (!eddStr) return "STANDARD";

  const min = parseBlueDartDate(eddStr);
  if (!min) return "STANDARD";

  const today = getIndiaDate();
  const diff =
    Math.round((min - today) / (1000 * 60 * 60 * 24));

  const metros = [
    "MUMBAI","DELHI","BANGALORE","BENGALURU",
    "PUNE","CHENNAI","HYDERABAD","KOLKATA"
  ];

  const isMetro = metros.some(m => (city || "").toUpperCase().includes(m));

  if (isMetro && diff <= 2) return "METRO_EXPRESS";
  if (diff <= 3) return "EXPRESS";
  return "STANDARD";
}

/* =================================================
   📦 EDD API (BLUEDART + SHIPROCKET)
================================================= */
async function getBluedartEdd(pincode) {
  try {
    const jwt = await getBluedartJwt();

    const res = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: calculatePickupDate(),
        pPickupTime: "16:00",
        profile: {
          Api_type: "S",
          LicenceKey: LICENCE_KEY_EDD,
          LoginID: LOGIN_ID,
        },
      },
      { headers: { JWTToken: jwt } }
    );

    return (
      res.data?.GetDomesticTransitTimeForPinCodeandProductResult
        ?.ExpectedDateDelivery || null
    );
  } catch {
    return null;
  }
}

async function getShiprocketEdd(pincode) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;

    const res = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pincode}&cod=1&weight=0.5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const c = res.data?.data?.available_courier_companies || [];
    return c[0]?.etd ? c[0].etd.split(" ")[0] : null;
  } catch {
    return null;
  }
}

/* =================================================
   🧠 DAILY PINCODE CACHE (KEY PART)
================================================= */
const eddCache = new Map();

function eddCacheKey(pincode) {
  return `${pincode}-${getIndiaDate().toISOString().slice(0, 10)}`;
}

// clear once per day (safety)
setInterval(() => eddCache.clear(), 24 * 60 * 60 * 1000);

/* =================================================
   🚚 EDD ROUTE (WIDGET)
================================================= */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!pincode) return res.status(400).json({ error: "Pincode required" });

  const key = eddCacheKey(pincode);
  if (eddCache.has(key)) {
    return res.json({ ...eddCache.get(key), cached: true });
  }

  const [city, bd] = await Promise.all([
    getCity(pincode),
    getBluedartEdd(pincode),
  ]);

  const edd = bd || (await getShiprocketEdd(pincode));
  const response = {
    edd: edd || null,
    edd_display: edd ? calculateConfidenceBand(edd) : null,
    city,
    badge: getExpressBadge(edd, city),
    cached: false,
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
  console.log("🚀 EDD Widget live on port", PORT)
);