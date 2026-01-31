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
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🔑 ENV (CLEAN)
================================ */
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_EDD = clean(process.env.BD_LICENCE_KEY_EDD);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

/* ===============================
   🔐 JWT CACHE
================================ */
let bdJwt = null, bdJwtAt = 0;
let srJwt = null, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;

  const r = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    { headers: { Accept: "application/json", ClientID: CLIENT_ID, clientSecret: CLIENT_SECRET } }
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
   🚚 TRACK HELPERS
================================ */
function normalizeStatus(raw = "") {
  const s = raw.toUpperCase();
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("RTO")) return "RTO";
  if (s.includes("NDR")) return "NDR";
  if (s.includes("OUT FOR DELIVERY")) return "OUT FOR DELIVERY";
  return "IN TRANSIT";
}

async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery` +
      `&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });

    const parsed = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = parsed?.ShipmentData?.Shipment;
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
    const token = await getShiprocketJwt();
    if (!token) return null;

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    return {
      source: "shiprocket",
      actual_courier: td.courier_name,
      status: normalizeStatus(td.current_status),
      delivered: normalizeStatus(td.current_status) === "DELIVERED",
      raw: td.shipment_track || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   💾 SAFE PERSIST (ONLY SHOPIFY AWBs)
================================ */
async function persistTrackingIfKnown(awb, data) {
  const r = await pool.query(
    `SELECT shopify_order_id FROM shipments WHERE awb=$1`,
    [awb]
  );

  if (r.rowCount === 0) {
    console.log("⚠️ Unknown AWB, not persisted:", awb);
    return;
  }

  const deliveredAt = data.delivered ? new Date() : null;

  await pool.query(
    `
    UPDATE shipments SET
      tracking_source=$2,
      actual_courier=$3,
      last_known_status=$4,
      delivered_at=COALESCE(delivered_at, $5),
      next_check_at=CASE
        WHEN $5 IS NOT NULL THEN '9999-01-01'
        ELSE now() + interval '6 hours'
      END,
      updated_at=now()
    WHERE awb=$1
    `,
    [
      awb,
      data.source,
      data.actual_courier,
      data.status,
      deliveredAt
    ]
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

  if (!data) {
    return res.status(404).json({ error: "not_found" });
  }

  // Persist ONLY if Shopify-linked
  await persistTrackingIfKnown(awb, data);

  res.json(data);
});

/* ===============================
   ⏱️ CRON TRACK
================================ */
app.post("/_cron/track/run", async (_, res) => {
  const r = await pool.query(
    `SELECT awb FROM shipments WHERE delivered_at IS NULL AND next_check_at <= now()`
  );

  let processed = 0;

  for (const row of r.rows) {
    let data = await trackBluedart(row.awb);
    if (!data) data = await trackShiprocket(row.awb);
    if (!data) continue;

    await persistTrackingIfKnown(row.awb, data);
    processed++;
  }

  res.json({ ok: true, processed });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Ops Logistics running on", PORT));