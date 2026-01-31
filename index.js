import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

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
const LOGIN_ID = clean(process.env.LOGIN_ID);
const BD_TRACK_KEY = clean(process.env.BD_LICENCE_KEY_TRACK);
const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

/* ===============================
   🔐 SHIPROCKET TOKEN
================================ */
let srJwt = null, srJwtAt = 0;

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
   🚚 BLUE DART TRACKING
================================ */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${BD_TRACK_KEY}&scan=1`;

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

/* ===============================
   🚚 SHIPROCKET TRACKING (STRICT)
================================ */
async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${t}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    // 🚨 HARD VALIDATION
    if (
      !td.shipment_id ||
      td.shipment_id === 0 ||
      !td.courier_name ||
      !td.awb_code ||
      td.awb_code !== awb
    ) {
      return null;
    }

    const delivered =
      !!td.delivered_date ||
      (td.current_status || "").toUpperCase().includes("DELIVERED");

    return {
      source: "shiprocket",
      actual_courier: td.courier_name,
      status: delivered ? "DELIVERED" : "IN TRANSIT",
      delivered,
      raw: td.shipment_track || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   💾 SAFE PERSIST (ONLY KNOWN AWB)
================================ */
async function persistTracking(awb, data) {
  const r = await pool.query(`SELECT 1 FROM shipments WHERE awb=$1`, [awb]);
  if (r.rowCount === 0) return;

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
   ⏱️ CRON
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