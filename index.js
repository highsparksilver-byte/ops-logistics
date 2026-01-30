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
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🚚 SHIPROCKET AUTH (CORRECT)
================================ */
let shiprocketToken = null;
let shiprocketTokenExpiry = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() < shiprocketTokenExpiry) {
    return shiprocketToken;
  }

  const res = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    {
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD
    }
  );

  shiprocketToken = res.data.token;
  shiprocketTokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // ~23h

  console.log("🔐 Shiprocket token refreshed");
  return shiprocketToken;
}

/* ===============================
   📦 BLUEDART TRACK (PROXY)
================================ */
async function trackBluedart(awb) {
  try {
    const res = await axios.get(
      `https://bluedart-edd.onrender.com/_internal/bluedart?awb=${awb}`,
      { timeout: 10000 }
    );
    return res.data || null;
  } catch {
    return null;
  }
}

/* ===============================
   📦 SHIPROCKET TRACK
================================ */
async function trackShiprocket(awb) {
  try {
    const token = await getShiprocketToken();

    const res = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 10000
      }
    );

    if (!res.data || !res.data.tracking_data) return null;

    return {
      source: "shiprocket",
      actual_courier: res.data.tracking_data.courier_name || null,
      status:
        res.data.tracking_data.shipment_track?.[0]?.current_status || "",
      scans: res.data.tracking_data.shipment_track_activities || []
    };
  } catch (err) {
    console.warn("Shiprocket track failed:", err.response?.data || err.message);
    return null;
  }
}

/* ===============================
   📦 TRACK ENDPOINT (RESTORED)
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);

  if (!data) {
    return res.status(404).json({ error: "not_found" });
  }

  // Persist minimal tracking (same as before)
  await pool.query(
    `
    INSERT INTO shipments (awb, last_known_status, tracking_source)
    VALUES ($1, $2, $3)
    ON CONFLICT (awb)
    DO UPDATE SET
      last_known_status = EXCLUDED.last_known_status,
      tracking_source = EXCLUDED.tracking_source,
      updated_at = NOW()
    `,
    [awb, data.status || null, data.source]
  );

  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);