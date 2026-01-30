import express from "express";
import axios from "axios";
import xml2js from "xml2js";

const app = express();
app.use(express.json());

/* =========================
   CORS
========================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =========================
   ENV
========================= */
const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* =========================
   CONSTANTS
========================= */
const ORIGIN_PIN = "411022";
const HOLIDAYS = [
  "2026-01-26",
  "2026-03-03",
  "2026-08-15",
  "2026-10-02",
  "2026-11-01",
];

/* =========================
   JWT CACHE
========================= */
let bdJwt, bdJwtAt = 0;
let srJwt, srJwtAt = 0;

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
  if (srJwt && Date.now() - srJwtAt < 7 * 24 * 60 * 60 * 1000) return srJwt;

  const res = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );

  srJwt = res.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* =========================
   DATE HELPERS (SAFE)
========================= */
function isValidDate(d) {
  return d instanceof Date && !isNaN(d);
}

function parseBlueDartDate(str) {
  if (!str || typeof str !== "string") return null;

  const parts = str.split("-");
  if (parts.length !== 3) return null;

  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };

  const day = Number(parts[0]);
  const month = months[parts[1]];
  const year = Number(parts[2]);

  if (!day || month === undefined || !year) return null;

  const d = new Date(Date.UTC(year, month, day));
  return isValidDate(d) ? d : null;
}

function isHoliday(d) {
  if (!isValidDate(d)) return false;
  const iso = d.toISOString().slice(0, 10);
  return d.getUTCDay() === 0 || HOLIDAYS.includes(iso);
}

function confidenceBand(minDate) {
  if (!isValidDate(minDate)) return null;

  let max = new Date(minDate);
  max.setUTCDate(max.getUTCDate() + 1);

  while (isHoliday(max)) {
    max.setUTCDate(max.getUTCDate() + 1);
  }

  const fmt = (d) =>
    `${d.getUTCDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]}`;

  return minDate.getUTCMonth() === max.getUTCMonth()
    ? `${minDate.getUTCDate()}–${fmt(max)}`
    : `${fmt(minDate)} – ${fmt(max)}`;
}

/* =========================
   EDD CACHE
========================= */
const eddCache = new Map();
const cacheKey = (pin) =>
  `${pin}-${new Date().toISOString().slice(0, 10)}`;

/* =========================
   EDD SOURCES
========================= */
async function getBluedartEDD(pin) {
  try {
    const jwt = await getBluedartJwt();
    const res = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: ORIGIN_PIN,
        pPinCodeTo: pin,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: `/Date(${Date.now()})/`,
        pPickupTime: "16:00",
        profile: { Api_type: "S", LicenceKey: LICENCE_KEY_EDD, LoginID: LOGIN_ID },
      },
      { headers: { JWTToken: jwt } }
    );

    return res.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch {
    return null;
  }
}

async function getShiprocketEDD(pin) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;

    const res = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=${ORIGIN_PIN}&delivery_postcode=${pin}&weight=0.5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const etd = res.data?.data?.available_courier_companies?.[0]?.etd;
    return etd || null;
  } catch {
    return null;
  }
}

/* =========================
   EDD ROUTE
========================= */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^\d{6}$/.test(pincode)) {
    return res.json({ edd_display: null });
  }

  const key = cacheKey(pincode);
  if (eddCache.has(key)) return res.json(eddCache.get(key));

  let rawEDD = await getBluedartEDD(pincode);
  let minDate = parseBlueDartDate(rawEDD);

  if (!minDate) {
    rawEDD = await getShiprocketEDD(pincode);
    minDate = isValidDate(new Date(rawEDD)) ? new Date(rawEDD) : null;
  }

  if (!minDate) {
    return res.json({
      edd_display: null,
      message: "Delivery timeline will be confirmed after order placement",
    });
  }

  const response = {
    edd_display: confidenceBand(minDate),
    cached: false,
  };

  eddCache.set(key, { ...response, cached: true });
  res.json(response);
});

/* =========================
   HEALTH
========================= */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));