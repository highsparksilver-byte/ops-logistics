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
   🔑 CREDENTIALS & CONSTANTS
================================================= */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

// ⚠️ SEPARATE KEYS AS PER YOUR REQUEST
const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Server Starting...");
console.log("📍 Warehouse: Pune (411022)");

const HOLIDAYS = [
  "2026-01-26", "2026-03-03", "2026-08-15", "2026-10-02", "2026-11-01"
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
  const res = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", {
    headers: { Accept: "application/json", ClientID: CLIENT_ID, clientSecret: CLIENT_SECRET },
  });
  bdJwt = res.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now() - srJwtAt < 8 * 24 * 60 * 60 * 1000) return srJwt;
  try {
    const res = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { email: SR_EMAIL, password: SR_PASSWORD });
    srJwt = res.data.token;
    srJwtAt = Date.now();
    return srJwt;
  } catch (e) { return null; }
}

/* =================================================
   📅 DATE HELPER FUNCTIONS
================================================= */
function getIndiaDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 3600000 * 5.5);
}

function isNonWorkingDay(dateObj) {
  const day = dateObj.getDay(); 
  const isoDate = dateObj.toISOString().slice(0, 10);
  return day === 0 || HOLIDAYS.includes(isoDate);
}

function calculatePickupDate() {
  const now = getIndiaDate();
  const cutoffHour = 11;
  const cutoffMinute = 45;

  let pickupDate = new Date(now);

  if (now.getHours() > cutoffHour || (now.getHours() === cutoffHour && now.getMinutes() >= cutoffMinute)) {
    pickupDate.setDate(pickupDate.getDate() + 1);
  }

  while (isNonWorkingDay(pickupDate)) {
    pickupDate.setDate(pickupDate.getDate() + 1);
  }

  return `/Date(${pickupDate.getTime()})/`;
}

function parseBlueDartDate(dateStr) {
  if (!dateStr) return null;
  const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const parts = dateStr.split("-");
  if (parts.length !== 3) return null;
  return new Date(Date.UTC(parts[2], months[parts[1]], parts[0]));
}

function calculateConfidenceBand(eddStr) {
  const minDate = parseBlueDartDate(eddStr);
  if (!minDate) return null;

  let maxDate = new Date(minDate);
  maxDate.setUTCDate(maxDate.getUTCDate() + 1);

  const isBadDayUTC = (d) => {
     const day = d.getUTCDay();
     const ymd = d.toISOString().slice(0, 10);
     return day === 0 || HOLIDAYS.includes(ymd);
  };

  while (isBadDayUTC(maxDate)) {
    maxDate.setUTCDate(maxDate.getUTCDate() + 1);
  }

  const format = (d) => {
    const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${d.getUTCDate()} ${m[d.getUTCMonth()]}`;
  };

  if (minDate.getUTCMonth() === maxDate.getUTCMonth()) {
    return `${minDate.getUTCDate()}–${format(maxDate)}`;
  } else {
    return `${format(minDate)} – ${format(maxDate)}`;
  }
}

/* =================================================
   🏙️ CITY LOOKUP (FREE API)
================================================= */
async function getCity(pincode) {
  try {
    const res = await axios.get(`https://api.postalpincode.in/pincode/${pincode}`, { timeout: 3000 });
    if (res.data && res.data[0].Status === "Success") {
      return res.data[0].PostOffice[0].District || res.data[0].PostOffice[0].Name; 
    }
  } catch (e) { return null; }
  return null;
}

/* =================================================
   ⚡ EXPRESS BADGE LOGIC (ROBUST VERSION)
================================================= */
function getExpressBadge(eddStr, city) {
  if (!eddStr) return "STANDARD";

  const minUTC = parseBlueDartDate(eddStr);
  if (!minUTC) return "STANDARD";

  // Shift to IST
  const minIST = new Date(minUTC.getTime() + 5.5 * 60 * 60 * 1000);
  const todayIST = getIndiaDate();

  // Normalize to pure dates
  const normalize = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const minDay = normalize(minIST);
  const todayDay = normalize(todayIST);

  const diffDays = Math.max(0, Math.round((minDay - todayDay) / (1000 * 60 * 60 * 24)));

  const c = (city || "").toUpperCase();
  const METROS = [
    "MUMBAI", "DELHI", "NEW DELHI", "NOIDA", "GURGAON", "GURUGRAM",
    "BANGALORE", "BENGALURU", "PUNE", "CHENNAI", "HYDERABAD", 
    "KOLKATA", "AHMEDABAD"
  ];

  const isMetro = METROS.some(m => c.includes(m));

  if (isMetro && diffDays <= 2) return "METRO_EXPRESS";
  if (diffDays <= 3) return "EXPRESS";

  return "STANDARD";
}

/* =================================================
   📦 API WRAPPERS
================================================= */
function formatToBlueDartStyle(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

async function getBluedartEdd(pincode) {
  try {
    const jwt = await getBluedartJwt();
    const bdRes = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: calculatePickupDate(),
        pPickupTime: "16:00",
        // ⚠️ USES EDD KEY
        profile: { Api_type: "S", LicenceKey: LICENCE_KEY_EDD, LoginID: LOGIN_ID },
      },
      { headers: { JWTToken: jwt, "Content-Type": "application/json" } }
    );
    return bdRes.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery || null;
  } catch (e) { return null; }
}

async function getShiprocketEdd(pincode) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;
    const url = `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${pincode}&cod=1&weight=0.5`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    const couriers = res.data?.data?.available_courier_companies;
    if (!couriers || couriers.length === 0) return null;
    let bestDate = null;
    for (const c of couriers) {
        if (c.etd && (!bestDate || c.etd < bestDate)) bestDate = c.etd;
    }
    return formatToBlueDartStyle(bestDate);
  } catch (e) { return null; }
}

const eddCache = new Map();
function eddCacheKey(to) {
  const now = getIndiaDate();
  const today = now.toISOString().slice(0, 10);
  const cycle = (now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() >= 45)) ? "PM" : "AM";
  return `${to}-${today}-${cycle}`;
}
setInterval(() => { eddCache.clear(); }, 24 * 60 * 60 * 1000);

/* =================================================
   🛣️ ROUTES
================================================= */
app.post("/edd", async (req, res) => {
  const { pincode } = req.body;
  if (!pincode) return res.status(400).json({ error: "Pincode required" });

  const key = eddCacheKey(pincode);
  if (eddCache.has(key)) return res.json(eddCache.get(key));

  const [city, bdEdd] = await Promise.all([
    getCity(pincode),
    getBluedartEdd(pincode)
  ]);
  
  let edd = bdEdd;
  if (!edd) edd = await getShiprocketEdd(pincode);

  const badge = getExpressBadge(edd, city);

  const response = { 
    edd: edd || null,
    edd_display: edd ? calculateConfidenceBand(edd) : null,
    city: city || null,
    badge: badge, 
    cached: false 
  };

  if (edd) eddCache.set(key, { ...response, cached: true });
  res.json(response);
});

/* =================================================
   📦 TRACKING LOGIC
================================================= */
async function trackBluedart(awb) {
  try {
    // ⚠️ USES TRACKING KEY
    const url = "https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=" + LOGIN_ID + "&awb=awb&numbers=" + awb + "&format=xml&lickey=" + LICENCE_KEY_TRACK + "&verno=1&scan=1";
    
    const res = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await new Promise((resolve, reject) => xml2js.parseString(res.data, { explicitArray: false }, (err, r) => err ? reject(err) : resolve(r)));
    const s = parsed?.ShipmentData?.Shipment;
    if (!s || !s.Status) return null;
    return {
      source: "bluedart", courier: "Blue Dart Express", status: s.Status, statusType: s.StatusType,
      expectedDelivery: s.ExpectedDeliveryDate || null, statusDate: s.StatusDate || null,
      statusTime: s.StatusTime || null, scans: s.Scans?.ScanDetail ? (Array.isArray(s.Scans.ScanDetail) ? s.Scans.ScanDetail : [s.Scans.ScanDetail]) : []
    };
  } catch (e) { return null; }
}

function mapShiprocketStatus(status) {
    const s = status?.toUpperCase() || "";
    if (s === "DELIVERED") return "DL";
    if (s.includes("OUT FOR")) return "OF";
    if (s.includes("RTO")) return "RT";
    if (s.includes("CANCEL")) return "CN";
    if (s.includes("PICKED") || s.includes("PICKUP")) return "PU";
    if (s.includes("TRANSIT") || s.includes("SHIPPED")) return "IT";
    return "UD";
}

async function trackShiprocket(awb) {
  try {
    const token = await getShiprocketJwt();
    if (!token) return null;
    const res = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
    const t = res.data.tracking_data;
    if (!t) return null;
    return {
      source: "shiprocket", courier: t.courier_name || "Shiprocket", status: t.current_status,
      statusType: mapShiprocketStatus(t.current_status), expectedDelivery: t.estimated_delivery_date || null,
      statusDate: t.shipment_track?.[0]?.date || null, statusTime: t.shipment_track?.[0]?.time || null,
      scans: t.shipment_track || []
    };
  } catch (e) { return null; }
}

app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });
  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (data) return res.json(data);
  res.status(404).json({ error: "Tracking details not found" });
});

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));
const SELF_URL = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/health` : null;
if (SELF_URL) setInterval(() => { axios.get(SELF_URL).catch(() => {}); }, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server running on port", PORT));
