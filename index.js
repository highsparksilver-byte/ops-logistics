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
let bdJwt = null, bdJwtAt = 0;
let srJwt = null, srJwtAt = 0;

async function getShiprocketJwt() {
  if (!SR_EMAIL || !SR_PASSWORD) return null;
  if (srJwt && Date.now() - srJwtAt < 7 * 24 * 60 * 60 * 1000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    { email: SR_EMAIL, password: SR_PASSWORD }
  );
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   🕒 TIME HELPERS
================================ */
function istNow() {
  const n = new Date();
  return new Date(n.getTime() + (330 + n.getTimezoneOffset()) * 60000);
}

function nextDay8am() {
  const d = istNow();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

/* ===============================
   🚚 TRACKERS
================================ */
async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;
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
      delivered: s.StatusType === "DL",
      ndr_reason: null,
      scans: Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : []
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    if (!t) return null;

    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${t}` }, timeout: 8000 }
    );

    const td = r.data.tracking_data;
    const last = td.shipment_track?.[0];

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || null,
      status: last?.["sr-status-label"] || td.current_status,
      delivered: td.current_status === "Delivered",
      ndr_reason: last?.activity || null,
      scans: td.shipment_track || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   🧠 OPS LOGIC (STEP 9.3)
================================ */
function computeNextCheck(status) {
  const s = (status || "").toUpperCase();

  if (s.includes("DELIVERED")) return new Date("9999-01-01");
  if (s.includes("OUT FOR")) return new Date(Date.now() + 60 * 60 * 1000);
  if (s.includes("NDR") || s.includes("FAILED")) return nextDay8am();
  if (s.includes("INVALID") || s.includes("INCORRECT")) return new Date(Date.now() + 24 * 60 * 60 * 1000);

  return new Date(Date.now() + 6 * 60 * 60 * 1000);
}

function detectOpsFlag(row, newStatus) {
  const now = istNow();
  const created = row.created_at ? new Date(row.created_at) : now;
  const hours = (now - created) / 36e5;

  let flags = [];

  const slaDays = row.tracking_source === "shiprocket" ? 5 : 4;
  if (!newStatus.toUpperCase().includes("DELIVERED") && hours > slaDays * 24) {
    flags.push("SLA_BREACH");
  }

  if (row.last_known_status === newStatus && row.last_checked_at) {
    const h = (now - new Date(row.last_checked_at)) / 36e5;
    if (h > 48) flags.push("STUCK_IN_TRANSIT");
  }

  if (flags.length >= 2) return "ESCALATE";
  return flags[0] || null;
}

/* ===============================
   💾 UPDATE ONLY (SAFE)
================================ */
async function persistTracking(awb, data) {
  const { rows } = await pool.query(
    "SELECT * FROM shipments WHERE awb = $1",
    [awb]
  );
  if (!rows.length) return;

  const row = rows[0];
  const opsFlag = detectOpsFlag(row, data.status);
  const nextCheck = computeNextCheck(data.status);

  await pool.query(`
    UPDATE shipments SET
      last_known_status = $1,
      actual_courier = COALESCE($2, actual_courier),
      delivered_at = CASE WHEN $3 THEN NOW() ELSE delivered_at END,
      next_check_at = $4,
      ops_flag = $5,
      ndr_reason = $6,
      last_checked_at = NOW(),
      updated_at = NOW()
    WHERE awb = $7
  `, [
    data.status,
    data.actual_courier,
    data.delivered,
    nextCheck,
    opsFlag,
    data.ndr_reason,
    awb
  ]);
}

/* ===============================
   🌐 ROUTES
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "AWB required" });

  const data = await trackBluedart(awb) || await trackShiprocket(awb);
  if (!data) return res.status(404).json({ error: "Tracking not found" });

  await persistTracking(awb, data);
  res.json(data);
});

app.post("/_cron/track/run", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT awb FROM shipments
    WHERE next_check_at <= NOW()
    LIMIT 30
  `);

  let processed = 0;
  for (const r of rows) {
    const d = await trackBluedart(r.awb) || await trackShiprocket(r.awb);
    if (d) {
      await persistTracking(r.awb, d);
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