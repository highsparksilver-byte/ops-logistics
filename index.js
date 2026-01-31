import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

/* ===============================
   🚀 APP
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
   🗄️ DB (OPTIONAL – SAFE)
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🔑 ENV (REQUIRED)
================================ */
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);
const BD_LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const BD_LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);
const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

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
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now() - srJwtAt < 8 * 24 * 60 * 60 * 1000) return srJwt;

  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   🧠 STATUS NORMALIZER (CRITICAL)
================================ */
function normalizeShiprocketStatus(currentStatus, deliveredDate) {
  if (deliveredDate) return "DELIVERED";

  const s = (currentStatus || "").toUpperCase();
  if (s.includes("OUT FOR DELIVERY")) return "OUT FOR DELIVERY";
  if (s.includes("NDR")) return "NDR";
  if (s.includes("RTO")) return "RTO";
  if (s.includes("DELIVERED")) return "DELIVERED"; // fallback only
  return "IN TRANSIT";
}

/* ===============================
   🚚 TRACKING – BLUEDART
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${BD_LICENCE_KEY_TRACK}&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });

    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) =>
        e ? rej(e) : res(o)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status?.toUpperCase().includes("DELIVERED")
        ? "DELIVERED"
        : "IN TRANSIT",
      delivered: s.Status?.toUpperCase().includes("DELIVERED"),
      raw: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : [s.Scans?.ScanDetail]
    };
  } catch {
    return null;
  }
}

/* ===============================
   🚚 TRACKING – SHIPROCKET
================================ */
async function trackShiprocket(awb) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    const status = normalizeShiprocketStatus(
      td.current_status,
      td.delivered_date
    );

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || null,
      status,
      delivered: status === "DELIVERED",
      raw: td.shipment_track || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   🚚 TRACK ROUTE
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (!data) return res.status(404).json({ error: "not_found" });

  res.json(data);
});

/* ===============================
   📦 EDD
================================ */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode))
    return res.json({ edd_display: null });

  try {
    const jwt = await getBluedartJwt();
    const r = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: `/Date(${Date.now()})/`,
        pPickupTime: "16:00",
        profile: {
          Api_type: "S",
          LicenceKey: BD_LICENCE_KEY_EDD,
          LoginID: LOGIN_ID
        }
      },
      { headers: { JWTToken: jwt } }
    );

    const raw = r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery;
    if (!raw) return res.json({ edd_display: null });

    res.json({ edd_display: raw });
  } catch {
    res.json({ edd_display: null });
  }
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Server running on", PORT)
);