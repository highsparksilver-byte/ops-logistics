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
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY_TRACK = process.env.BD_LICENCE_KEY_TRACK;
const SR_EMAIL = process.env.SHIPROCKET_EMAIL;
const SR_PASSWORD = process.env.SHIPROCKET_PASSWORD;

console.log("🚀 Ops Logistics running");

/* ===============================
   🔐 SHIPROCKET TOKEN
================================ */
let srJwt = null;
let srJwtAt = 0;

async function getShiprocketJwt() {
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
   🧠 STATUS + SLA LOGIC
================================ */
function classifyStatus(raw = "") {
  const s = String(raw).toUpperCase();
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("OUT FOR DELIVERY")) return "OFD";
  if (s.includes("NDR") || s.includes("FAILED") || s.includes("ATTEMPT"))
    return "NDR";
  if (s.includes("IN TRANSIT") || s.includes("SHIPPED")) return "TRANSIT";
  return "NO_INFO";
}

function hoursBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 36e5;
}

function computeNextCheck(statusType, firstNdrAt) {
  const now = new Date();

  if (statusType === "DELIVERED") {
    return new Date("9999-01-01");
  }

  if (statusType === "OFD") {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }

  if (statusType === "NDR") {
    if (!firstNdrAt) {
      return new Date(now.getTime() + 6 * 60 * 60 * 1000);
    }
    const hrs = hoursBetween(now, firstNdrAt);
    if (hrs <= 14) {
      return new Date(now.getTime() + 6 * 60 * 60 * 1000);
    }
    return new Date(now.getTime() + 2 * 60 * 60 * 1000);
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

/* ===============================
   🚚 TRACKERS
================================ */
async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;
    const r = await axios.get(url, { responseType: "text" });
    const parsed = await xml2js.parseStringPromise(r.data, {
      explicitArray: false
    });
    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;
    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status || "",
      scans: s.Scans?.ScanDetail
        ? Array.isArray(s.Scans.ScanDetail)
          ? s.Scans.ScanDetail
          : [s.Scans.ScanDetail]
        : []
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
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const t = r.data.tracking_data;
    if (!t) return null;
    return {
      source: "shiprocket",
      actual_courier: t.courier_name || null,
      status: t.current_status || "",
      scans: t.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   💾 DB UPDATE (SAFE)
================================ */
async function persistTracking(awb, data) {
  const statusType = classifyStatus(data.status);
  const now = new Date();

  const { rows } = await pool.query(
    "SELECT first_ndr_at FROM shipments WHERE awb=$1",
    [awb]
  );

  const existingFirstNdr = rows[0]?.first_ndr_at || null;

  const firstNdrAt =
    statusType === "NDR" && !existingFirstNdr ? now : existingFirstNdr;

  const nextCheck = computeNextCheck(statusType, firstNdrAt);

  await pool.query(
    `
    UPDATE shipments SET
      last_known_status=$2,
      actual_courier=COALESCE($3, actual_courier),
      delivered_at=CASE WHEN $4='DELIVERED' THEN NOW() ELSE delivered_at END,
      first_ndr_at=$5,
      next_check_at=$6,
      updated_at=NOW()
    WHERE awb=$1
  `,
    [
      awb,
      data.status,
      data.actual_courier,
      statusType,
      firstNdrAt,
      nextCheck
    ]
  );
}

/* ===============================
   🌐 ROUTE
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);

  if (!data) return res.status(404).json({ error: "Tracking not found" });

  await persistTracking(awb, data);
  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));