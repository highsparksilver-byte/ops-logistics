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
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const SR_EMAIL = clean(process.env.SHIPROCKET_EMAIL);
const SR_PASSWORD = clean(process.env.SHIPROCKET_PASSWORD);

console.log("🚀 Ops Logistics running");

/* ===============================
   🔐 JWT CACHE
================================ */
let srJwt = null, srJwtAt = 0;

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
   🚚 TRACKING HELPERS
================================ */
function mapShiprocketStatus(s = "") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";
  if (s.includes("OUT FOR")) return "OF";
  if (s.includes("PICK")) return "PU";
  if (s.includes("RTO")) return "RT";
  return "UD";
}

async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery` +
      `&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const parsed = await new Promise((res, rej) =>
      xml2js.parseString(r.data, { explicitArray: false }, (e, o) =>
        e ? rej(e) : res(o)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      courier: "Blue Dart",
      status: s.Status,
      statusType: s.StatusType,
      scans: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : s.Scans?.ScanDetail
        ? [s.Scans.ScanDetail]
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
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );

    const t = r.data?.tracking_data;
    if (!t) return null;

    return {
      source: "shiprocket",
      courier: t.courier_name || null,
      status: t.current_status,
      statusType: mapShiprocketStatus(t.current_status),
      scans: t.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   🚚 TRACK ROUTE (STEP 4)
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);
  if (!data) return res.status(404).json({ error: "Tracking details not found" });

  /* ===== STEP 4 DB WRITE (ONLY IF EXISTS) ===== */
  try {
    const { rows } = await pool.query(
      "SELECT id FROM shipments WHERE awb = $1",
      [awb]
    );

    if (rows.length > 0) {
      const delivered = data.statusType === "DL";

      await pool.query(
        `
        UPDATE shipments
        SET actual_courier = COALESCE($1, actual_courier),
            last_known_status = $2,
            last_checked_at = NOW(),
            delivery_confirmed = CASE WHEN $3 THEN true ELSE delivery_confirmed END,
            delivered_at = CASE WHEN $3 THEN NOW() ELSE delivered_at END,
            updated_at = NOW()
        WHERE awb = $4
        `,
        [data.courier, data.status, delivered, awb]
      );
    }
  } catch (e) {
    console.error("DB update failed", e.message);
  }

  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Server on", PORT));