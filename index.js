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

/* ===============================
   🔑 ENV
================================ */
const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

const LOGIN_ID = clean(process.env.LOGIN_ID);
const BD_TRACK_KEY = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* ===============================
   🔐 SHIPROCKET AUTH
================================ */
let srToken = null;
let srTokenAt = 0;

async function getShiprocketJwt() {
  if (srToken && Date.now() - srTokenAt < 8 * 24 * 60 * 60 * 1000) {
    return srToken;
  }
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srToken = r.data.token;
  srTokenAt = Date.now();
  return srToken;
}

/* ===============================
   🚚 TRACKING FETCHERS
================================ */
async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${BD_TRACK_KEY}&verno=1&scan=1`;
    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) => e ? rej(e) : res(o))
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status,
      statusType: s.StatusType,
      scans: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : s.Scans?.ScanDetail ? [s.Scans.ScanDetail] : []
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const token = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const td = r.data.tracking_data;
    if (!td) return null;

    const courierFromTrack =
      td.shipment_track?.[0]?.courier_name || null;

    return {
      source: "shiprocket",
      actual_courier: courierFromTrack,
      status: td.current_status,
      statusType: td.shipment_status,
      scans: td.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   💾 PERSIST TRACKING (UPSERT)
================================ */
async function persistTracking(awb, data) {
  const delivered = /DELIVERED/i.test(data.status || "");

  await pool.query(
    `
    INSERT INTO shipments (
      awb,
      tracking_source,
      actual_courier,
      last_known_status,
      delivered_at,
      next_check_at
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (awb)
    DO UPDATE SET
      tracking_source = EXCLUDED.tracking_source,
      last_known_status = EXCLUDED.last_known_status,
      delivered_at = COALESCE(shipments.delivered_at, EXCLUDED.delivered_at),
      next_check_at = EXCLUDED.next_check_at,
      actual_courier = COALESCE(shipments.actual_courier, EXCLUDED.actual_courier),
      updated_at = now()
    `,
    [
      awb,
      data.source,
      data.actual_courier,
      delivered ? "DELIVERED" : "IN TRANSIT",
      delivered ? new Date() : null,
      delivered ? new Date("9999-01-01") : new Date(Date.now() + 6 * 60 * 60 * 1000)
    ]
  );
}

/* ===============================
   🚚 TRACK ROUTE
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  const { rows } = await pool.query(
    "SELECT tracking_source FROM shipments WHERE awb=$1",
    [awb]
  );

  let data = null;

  if (rows.length && rows[0].tracking_source === "shiprocket") {
    data = await trackShiprocket(awb);
    if (!data) data = await trackBluedart(awb);
  } else {
    data = await trackBluedart(awb);
    if (!data) data = await trackShiprocket(awb);
  }

  if (!data) return res.status(404).json({ error: "Tracking details not found" });

  await persistTracking(awb, data);
  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));