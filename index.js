import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

/* ===============================
   🚀 APP + DB
================================ */
const app = express();
app.use(express.json());

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

const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

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
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  console.log("🔐 Shiprocket token refreshed");
  return srJwt;
}

/* ===============================
   🧠 STATUS NORMALIZER (FIXED)
================================ */
function normalizeShiprocket(td) {
  if (!td) return "IN TRANSIT";

  if (
    td.delivered_date ||
    (td.current_status || "").toUpperCase().includes("DELIVERED") ||
    (td.shipment_status_label || "").toUpperCase() === "DELIVERED"
  ) {
    return "DELIVERED";
  }

  return "IN TRANSIT";
}

/* ===============================
   🚚 TRACKING
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    const delivered = (s.Status || "").toUpperCase().includes("DELIVERED");

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: delivered ? "DELIVERED" : "IN TRANSIT",
      delivered,
      raw: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : [s.Scans?.ScanDetail]
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

    const status = normalizeShiprocket(td);

    return {
      source: "shiprocket",
      actual_courier: td.courier_name,
      status,
      delivered: status === "DELIVERED",
      raw: td.shipment_track || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   💾 SAFE PERSIST (NO UNKNOWN ORDERS)
================================ */
async function persistTracking(awb, data) {
  const exists = await pool.query(
    `SELECT 1 FROM shipments WHERE awb=$1`,
    [awb]
  );

  if (exists.rowCount === 0) return; // ignore unknown AWB safely

  await pool.query(
    `
    UPDATE shipments SET
      tracking_source=$2,
      actual_courier=$3,
      last_known_status=$4,
      delivered_at=CASE WHEN $5 THEN now() ELSE delivered_at END,
      updated_at=now()
    WHERE awb=$1
    `,
    [awb, data.source, data.actual_courier, data.status, data.delivered]
  );
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

  await persistTracking(awb, data);
  res.json(data);
});

/* ===============================
   ⏱️ CRON RUNNER
================================ */
app.post("/_cron/track/run", async (_, res) => {
  const r = await pool.query(
    `SELECT awb FROM shipments WHERE delivered_at IS NULL LIMIT 50`
  );

  let processed = 0;
  for (const row of r.rows) {
    let d = await trackBluedart(row.awb);
    if (!d) d = await trackShiprocket(row.awb);
    if (d) {
      await persistTracking(row.awb, d);
      processed++;
    }
  }

  res.json({ ok: true, processed });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));