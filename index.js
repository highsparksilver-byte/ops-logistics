import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

const app = express();
app.use(express.json());

/* ===============================
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
const HOLIDAYS = ["2026-01-26","2026-03-03","2026-08-15","2026-10-02","2026-11-01"];
const METROS = ["MUMBAI","DELHI","NEW DELHI","BANGALORE","BENGALURU","PUNE","CHENNAI","HYDERABAD","KOLKATA","AHMEDABAD"];

/* ===============================
   🔐 TOKEN CACHE
================================ */
let bdJwt=null, bdJwtAt=0;
let srJwt=null, srJwtAt=0;

async function getBluedartJwt() {
  if (bdJwt && Date.now()-bdJwtAt < 23*60*60*1000) return bdJwt;
  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers:{ Accept:"application/json", ClientID:CLIENT_ID, clientSecret:CLIENT_SECRET } }
  );
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now()-srJwtAt < 7*24*60*60*1000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  console.log("🔐 Shiprocket token refreshed");
  return srJwt;
}

/* ===============================
   🕒 DATE HELPERS
================================ */
function getISTNow() {
  const n = new Date();
  return new Date(n.getTime() + (330 + n.getTimezoneOffset()) * 60000);
}
function isHoliday(d) {
  return d.getUTCDay() === 0 || HOLIDAYS.includes(d.toISOString().slice(0,10));
}
function getNextWorkingDate() {
  let d = getISTNow();
  while (isHoliday(d)) d.setDate(d.getDate()+1);
  return d;
}

/* ===============================
   📦 EDD ROUTE (RESTORED)
================================ */
async function getCity(pin) {
  try {
    const r = await axios.get(`https://api.postalpincode.in/pincode/${pin}`);
    return r.data?.[0]?.PostOffice?.[0]?.District || null;
  } catch { return null; }
}

app.post("/edd", async (req,res)=>{
  const { pincode } = req.body;
  if (!/^[0-9]{6}$/.test(pincode)) return res.json({ edd_display:null });

  const city = await getCity(pincode);
  let minDate = getNextWorkingDate();
  minDate.setDate(minDate.getDate() + 2);

  const badge = METROS.some(m => city?.toUpperCase().includes(m))
    ? "METRO_EXPRESS"
    : "STANDARD";

  res.json({
    edd_display: `${minDate.getDate()}–${minDate.getDate()+1} Feb`,
    city,
    badge
  });
});

/* ===============================
   🚚 TRACKING HELPERS
================================ */
async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;
    const r = await axios.get(url,{responseType:"text"});
    const parsed = await new Promise((res,rej)=>
      xml2js.parseString(r.data,{explicitArray:false},(e,o)=>e?rej(e):res(o))
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s || !s.Status) return null;

    const delivered = s.Status.toUpperCase().includes("DELIVERED");

    return {
      source:"bluedart",
      actual_courier:"Blue Dart",
      status: delivered ? "DELIVERED" : "IN TRANSIT",
      delivered,
      raw: Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail]
    };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    if (!t) return null;

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers:{Authorization:`Bearer ${t}`} }
    );

    const td = r.data.tracking_data;
    if (!td) return null;

    const delivered =
      td.current_status?.toUpperCase() === "DELIVERED" ||
      td.delivered_date;

    return {
      source:"shiprocket",
      actual_courier:td.courier_name,
      status: delivered ? "DELIVERED" : "IN TRANSIT",
      delivered,
      raw: td.shipment_track || []
    };
  } catch { return null; }
}

/* ===============================
   🚚 TRACK ROUTE (GUARDED)
================================ */
app.get("/track", async (req,res)=>{
  const { awb } = req.query;
  if (!awb) return res.status(400).json({error:"awb_required"});

  const { rows } = await pool.query(
    "SELECT 1 FROM shipments WHERE awb=$1",
    [awb]
  );
  if (rows.length === 0) return res.status(404).json({error:"not_found"});

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (!data) return res.status(404).json({error:"not_found"});

  await pool.query(
    `
    UPDATE shipments SET
      tracking_source=$2,
      actual_courier=$3,
      last_known_status=$4,
      delivered_at=CASE WHEN $5 THEN now() ELSE delivered_at END,
      next_check_at=CASE WHEN $5 THEN '9999-01-01' ELSE now()+interval '6 hours' END,
      updated_at=now()
    WHERE awb=$1
    `,
    [awb, data.source, data.actual_courier, data.status, data.delivered]
  );

  res.json(data);
});

/* ===============================
   ⏱ CRON
================================ */
app.post("/_cron/track/run", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT awb FROM shipments
    WHERE delivered_at IS NULL
      AND next_check_at <= now()
    LIMIT 25
  `);

  let processed = 0;
  for (const r of rows) {
    let data = await trackBluedart(r.awb);
    if (!data) data = await trackShiprocket(r.awb);
    if (!data) continue;

    await pool.query(
      `
      UPDATE shipments SET
        tracking_source=$2,
        actual_courier=$3,
        last_known_status=$4,
        delivered_at=CASE WHEN $5 THEN now() ELSE delivered_at END,
        next_check_at=CASE WHEN $5 THEN '9999-01-01' ELSE now()+interval '6 hours' END,
        updated_at=now()
      WHERE awb=$1
      `,
      [r.awb, data.source, data.actual_courier, data.status, data.delivered]
    );
    processed++;
  }

  res.json({ ok:true, processed });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health",(_,res)=>res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT,()=>console.log("🚀 Server on",PORT));