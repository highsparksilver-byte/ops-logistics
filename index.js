import express from "express";
import axios from "axios";
import crypto from "crypto";
import xml2js from "xml2js";
import pg from "pg";

/* ======================================================
   APP
====================================================== */
const app = express();
app.use(express.json());

/* ======================================================
   ENV
====================================================== */
const {
  DATABASE_URL,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
  SHOPIFY_WEBHOOK_SECRET
} = process.env;

const BLUEDART_TRACK_URL = "https://bluedart-edd.onrender.com/bluedart-track";

/* ======================================================
   DB
====================================================== */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ======================================================
   SHIPROCKET TOKEN (EMAIL + PASSWORD FLOW)
====================================================== */
let shiprocketToken = null;
let shiprocketTokenExpiry = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() < shiprocketTokenExpiry) {
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
  shiprocketTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

  console.log("🔐 Shiprocket token refreshed");
  return shiprocketToken;
}

/* ======================================================
   BLUEDART TRACKING (XML – RESTORED)
====================================================== */
async function trackBluedart(awb) {
  const res = await axios.get(`${BLUEDART_TRACK_URL}?awb=${awb}`, {
    timeout: 15000
  });

  const parsed = await xml2js.parseStringPromise(res.data, {
    explicitArray: false,
    ignoreAttrs: true
  });

  const shipment = parsed?.ShipmentData?.Shipment;
  if (!shipment) throw new Error("bluedart_no_data");

  let scans = shipment?.Scans?.Scan || [];
  if (!Array.isArray(scans)) scans = [scans];

  const deliveredScan = scans.find(s =>
    s?.Scan?.toUpperCase().includes("DELIVERED")
  );

  const lastScan = deliveredScan || scans[0];

  return {
    source: "bluedart",
    actual_courier: "Blue Dart",
    status: lastScan?.Scan || null,
    delivered: Boolean(deliveredScan),
    raw: scans
  };
}

/* ======================================================
   SHIPROCKET TRACKING (JSON)
====================================================== */
async function trackShiprocket(awb) {
  const token = await getShiprocketToken();

  const res = await axios.get(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  const activities = res.data?.tracking_data?.shipment_track_activities || [];
  const latest = activities[0];

  return {
    source: "shiprocket",
    actual_courier:
      res.data?.tracking_data?.shipment_track?.courier_name || null,
    status: latest?.activity || null,
    delivered: latest?.sr_status_label === "DELIVERED",
    raw: activities
  };
}

/* ======================================================
   TRACK ROUTE (SHOPIFY-SAFE)
====================================================== */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  try {
    // 🔒 ONLY TRACK AWBs THAT EXIST IN SHOPIFY-LINKED SHIPMENTS
    const { rows } = await pool.query(
      `SELECT tracking_source FROM shipments WHERE awb = $1`,
      [awb]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    const source = rows[0].tracking_source;

    let result;
    if (source === "bluedart") {
      result = await trackBluedart(awb);
    } else if (source === "shiprocket") {
      result = await trackShiprocket(awb);
    } else {
      return res.status(400).json({ error: "unknown_tracking_source" });
    }

    res.json(result);
  } catch (err) {
    console.error("tracking error:", err.message);
    res.status(500).json({ error: "tracking_failed" });
  }
});

/* ======================================================
   CRON (SAFE – NO INSERTS)
====================================================== */
app.post("/_cron/track/run", async (_req, res) => {
  res.json({ ok: true, processed: 0 });
});

/* ======================================================
   HEALTH
====================================================== */
app.get("/health", (_, res) => res.send("OK"));

/* ======================================================
   START
====================================================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);