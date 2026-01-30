import express from "express";
import axios from "axios";
import xml2js from "xml2js";

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

const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

/* ===============================
   🔑 ENV
================================ */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* ===============================
   📅 CONSTANTS
================================ */
const HOLIDAYS = [
  "2026-01-26",
  "2026-03-03",
  "2026-08-15",
  "2026-10-02",
  "2026-11-01",
];

const METROS = [
  "MUMBAI","DELHI","NEW DELHI","NOIDA","GURGAON","GURUGRAM",
  "BANGALORE","BENGALURU","PUNE","CHENNAI","HYDERABAD",
  "KOLKATA","AHMEDABAD"
];

/* ===============================
   🔐 JWT CACHE
================================ */
let bdJwt = null, bdJwtAt = 0;
let srJwt = null, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;
  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers: { Accept: "application/json", ClientID: CLIENT_ID, clientSecret: CLIENT_SECRET } }
  );
  bdJwt = res.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now() - srJwtAt < 8 * 24 * 60 * 60 * 1000) return srJwt;
  const res = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = res.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   🕒 DATE HELPERS (SAFE)
================================ */
function getISTNow() {
  const now = new Date();
  return new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
}

function isHoliday(d) {
  if (!d || isNaN(d)) return false;
  const iso = d.toISOString().slice(0, 10);
  return d.getUTCDay() === 0 || HOLIDAYS.includes(iso);
}

function parseBlueDartDate(str) {
  if (!str) return null;
  const [dd, mon, yyyy] = str.split("-");
  const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  if (!months[mon]) return null;
  return new Date(Date.UTC(Number(yyyy), months[mon], Number(dd)));
}

function confidenceBand(minDate) {
  if (!minDate || isNaN(minDate)) return null;

  const start = new Date(minDate.getTime());
  const end = new Date(minDate.getTime());

  end.setUTCDate(end.getUTCDate() + 1);
  while (isHoliday(end)) end.setUTCDate(end.getUTCDate() + 1);

  const fmt = (d) => `${d.getUTCDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]}`;

  return start.getUTCMonth() === end.getUTCMonth()
    ? `${start.getUTCDate()}–${fmt(end)}`
    : `${fmt(start)} – ${fmt(end)}`;
}

/* ===============================
   🏙️ CITY
================================ */
async function getCity(pincode) {
  try {
    const r = await axios.get(`https://api.postalpincode.in/pincode/${pincode}`, { timeout: 3000 });
    return r.data?.[0]?.PostOffice?.[0]?.District || null;
  } catch {
    return null;
  }
}

/* ===============================
   🚀 BADGE LOGIC
================================ */
function getBadge(minDate, city) {
  if (!minDate) return "STANDARD";

  const diffDays = Math.round(
    (new Date(minDate.getTime() + 5.5 * 3600000) - getISTNow()) / 86400000
  );

  const isMetro = METROS.some(m => (city || "").toUpperCase().includes(m));

  if (isMetro && diffDays <= 2) return "METRO_EXPRESS";
  if (diffDays <= 3) return "EXPRESS";
  return "STANDARD";
}

/* ===============================
   📦 EDD FETCH
================================ */
async function getBluedartEDD(pincode) {
  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: `/Date(${getISTNow().getTime()})/`,
        pPickupTime: "16:00",
        profile: { Api_type: "S", LicenceKey: LICENCE_KEY_EDD, LoginID: LOGIN_ID }
      },
      { headers: { JWTToken: jwt } }
    );
    return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch {
    return null;
  }
}

async function getShiprocketEDD(pincode) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pincode}&cod=1&weight=0.5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const list = r.data?.data?.available_courier_companies || [];
    return list[0]?.etd || null;
  } catch {
    return null;
  }
}

/* ===============================
   🧠 CACHE
================================ */
const eddCache = new Map();

/* ===============================
   🛣️ ROUTE
================================ */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode)) {
    return res.json({ edd_display: null });
  }

  const today = getISTNow().toISOString().slice(0, 10);
  const key = `${pincode}-${today}`;

  if (eddCache.has(key)) return res.json(eddCache.get(key));

  const city = await getCity(pincode);

  let raw = await getBluedartEDD(pincode);
  let minDate = parseBlueDartDate(raw);

  if (!minDate) {
    const sr = await getShiprocketEDD(pincode);
    if (sr) minDate = new Date(sr);
  }

  if (!minDate || isNaN(minDate)) {
    return res.json({ edd_display: null });
  }

  const response = {
    edd_display: confidenceBand(minDate),
    city,
    badge: getBadge(minDate, city)
  };

  eddCache.set(key, response);
  res.json(response);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));