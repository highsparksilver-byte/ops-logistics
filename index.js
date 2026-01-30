import express from "express";
import axios from "axios";
import pg from "pg";

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
   🔑 ENV
================================ */
const {
  DATABASE_URL,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
  BLUEDART_TRACK_URL
} = process.env;

/* ===============================
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🚚 SHIPROCKET AUTH
================================ */
let shiprocketToken = null;
let shiprocketTokenAt = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() - shiprocketTokenAt < 20 * 60 * 1000) {
    return shiprocketToken;
  }

  const res = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    {
      email: SHIPROCKET_EMAIL,
      password: SHIPROCKET_PASSWORD
    }
  );

  shiprocketToken = res.data.token;
  shiprocketTokenAt = Date.now();
  console.log("🔐 Shiprocket token refreshed");
  return shiprocketToken;
}

/* ===============================
   🚚 TRACK — BLUEDART
================================ */
async function trackBluedart(awb) {
  const res = await axios.get(`${BLUEDART_TRACK_URL}?awb=${awb}`);
  const scans = res.data?.Scans || [];

  const last =
    scans.find(s => s.Scan?.toUpperCase().includes("DELIVERED")) ||
    scans[0] ||
    {};

  return {
    source: "bluedart",
    actual_courier: "Blue Dart",
    status: last.Scan || null,
    delivered: last.Scan?.toUpperCase().includes("DELIVERED"),
    raw: scans
  };
}

/* ===============================
   🚚 TRACK — SHIPROCKET
================================ */
async function trackShiprocket(awb) {
  const token = await getShiprocketToken();

  const res = await axios.get(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  const td = res.data.tracking_data;
  const scans = td?.shipment_track_activities || [];
  const info = td?.shipment_track?.[0] || {};

  return {
    source: "shiprocket",
    actual_courier: info.courier_name || null,
    status: info.current_status || null,
    delivered: info.current_status === "Delivered",
    raw: scans
  };
}

/* ===============================
   🧠 PERSIST (UPDATE ONLY)
================================ */
async function persistTracking(awb, data) {
  const { rows } = await pool.query(
    `SELECT id FROM shipments WHERE awb = $1`,
    [awb]
  );

  if (rows.length === 0) {
    console.warn("⚠️ UNKNOWN AWB TRACK ATTEMPT:", awb);
    return false;
  }

  await pool.query(
    `
    UPDATE shipments
    SET
      tracking_source = $2,
      actual_courier = $3,
      last_known_status = $4,
      delivered_at = CASE
        WHEN $5 = true THEN NOW()
        ELSE delivered_at
      END,
      next_check_at = CASE
        WHEN $5 = true THEN '9999-01-01'
        ELSE NOW() + INTERVAL '12 hours'
      END,
      updated_at = NOW()
    WHERE awb = $1
    `,
    [
      awb,
      data.source,
      data.actual_courier,
      data.status,
      data.delivered
    ]
  );

  return true;
}

/* ===============================
   📦 PUBLIC TRACK API
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  const { rows } = await pool.query(
    `SELECT tracking_source FROM shipments WHERE awb = $1`,
    [awb]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: "not_found" });
  }

  const source = rows[0].tracking_source;
  let data;

  try {
    data =
      source === "shiprocket"
        ? await trackShiprocket(awb)
        : await trackBluedart(awb);
  } catch (e) {
    console.error("❌ Tracking failed:", e.response?.data || e.message);
    return res.status(500).json({ error: "tracking_failed" });
  }

  await persistTracking(awb, data);
  res.json(data);
});

/* ===============================
   ⏰ CRON — SAFE MODE
================================ */
app.post("/_cron/track/run", async (_, res) => {
  const { rows } = await pool.query(
    `
    SELECT awb, tracking_source
    FROM shipments
    WHERE next_check_at <= NOW()
      AND delivered_at IS NULL
    LIMIT 50
    `
  );

  let processed = 0;

  for (const r of rows) {
    try {
      const data =
        r.tracking_source === "shiprocket"
          ? await trackShiprocket(r.awb)
          : await trackBluedart(r.awb);

      await persistTracking(r.awb, data);
      processed++;
    } catch (e) {
      console.error("cron error:", r.awb);
    }
  }

  res.json({ ok: true, processed });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);