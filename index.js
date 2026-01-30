import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

const app = express();
app.use(express.json());

/* ===============================
   DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   UTILS
================================ */
function istNow() {
  const d = new Date();
  return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
}

function isQuietHours(d = istNow()) {
  const h = d.getHours();
  return h >= 0 && h < 7;
}

function nextMorning7am(from = istNow()) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d;
}

/* ===============================
   STATUS HELPERS
================================ */
function isDelivered(s = "") {
  return s.toUpperCase().includes("DELIVERED");
}

function isOFD(s = "") {
  return s.toUpperCase().includes("OUT FOR DELIVERY");
}

function isNDR(s = "") {
  return (
    s.toUpperCase().includes("NDR") ||
    s.toUpperCase().includes("UNDELIVERED") ||
    s.toUpperCase().includes("FAILED")
  );
}

function isRTO(s = "") {
  return s.toUpperCase().includes("RTO");
}

/* ===============================
   SLA ENGINE (FINAL v3)
================================ */
function computeNextCheck({
  status,
  firstNdrAt,
  lastCheckedAt
}) {
  const now = istNow();

  if (isDelivered(status) || isRTO(status)) {
    return new Date("9999-01-01");
  }

  if (isQuietHours(now)) {
    return new Date(now.setHours(7, 0, 0, 0));
  }

  // -------- OUT FOR DELIVERY --------
  if (isOFD(status)) {
    const next = new Date(now);
    next.setHours(next.getHours() + 1);
    return next;
  }

  // -------- NDR LOGIC --------
  if (isNDR(status)) {
    const first = firstNdrAt ? new Date(firstNdrAt) : now;
    const hoursSinceFirst =
      (now - first) / (1000 * 60 * 60);

    // Same day
    if (hoursSinceFirst < 2) return new Date(now.setHours(now.getHours() + 2));
    if (hoursSinceFirst < 6) return new Date(now.setHours(now.getHours() + 6));
    if (hoursSinceFirst < 14) return new Date(now.setHours(now.getHours() + 14));

    // End of day → quiet hours
    if (now.getHours() >= 22) {
      return nextMorning7am(now);
    }

    // Day 0 tail
    if (hoursSinceFirst < 24) {
      return new Date(now.setHours(now.getHours() + 2));
    }

    // Day 1+
    return new Date(now.setHours(now.getHours() + 3));
  }

  // -------- IN TRANSIT --------
  const next = new Date(now);
  next.setHours(next.getHours() + 12);
  return next;
}

/* ===============================
   TRACKERS
================================ */
async function trackBluedart(awb) {
  try {
    const url = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custawbquery&awb=awb&numbers=${awb}&format=xml`;
    const r = await axios.get(url, { timeout: 8000 });
    const parsed = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = parsed?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: s.Status || "",
      scans: s.Scans?.ScanDetail || []
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const token = process.env.SHIPROCKET_TOKEN;
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const td = r.data.tracking_data;
    return {
      source: "shiprocket",
      actual_courier: td.courier_name || null,
      status: td.current_status || "",
      scans: td.shipment_track_activities || []
    };
  } catch {
    return null;
  }
}

/* ===============================
   PERSIST (SAFE UPSERT)
================================ */
async function persistTracking(awb, data) {
  const now = istNow();

  const existing = await pool.query(
    "SELECT first_ndr_at FROM shipments WHERE awb=$1",
    [awb]
  );

  let firstNdrAt = existing.rows[0]?.first_ndr_at || null;

  // Reset NDR memory if OFD
  if (isOFD(data.status)) {
    firstNdrAt = null;
  }

  // Set first NDR
  if (isNDR(data.status) && !firstNdrAt) {
    firstNdrAt = now;
  }

  const nextCheck = computeNextCheck({
    status: data.status,
    firstNdrAt,
    lastCheckedAt: now
  });

  await pool.query(
    `
    INSERT INTO shipments (
      awb, tracking_source, actual_courier,
      last_known_status, last_checked_at,
      next_check_at, delivered_at, first_ndr_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,
      CASE WHEN $4 ILIKE '%DELIVERED%' THEN NOW() ELSE NULL END,
      $7
    )
    ON CONFLICT (awb) DO UPDATE SET
      tracking_source = EXCLUDED.tracking_source,
      actual_courier = EXCLUDED.actual_courier,
      last_known_status = EXCLUDED.last_known_status,
      last_checked_at = EXCLUDED.last_checked_at,
      next_check_at = EXCLUDED.next_check_at,
      delivered_at = EXCLUDED.delivered_at,
      first_ndr_at = EXCLUDED.first_ndr_at
    `,
    [
      awb,
      data.source,
      data.actual_courier,
      data.status,
      now,
      nextCheck,
      firstNdrAt
    ]
  );
}

/* ===============================
   TRACK ENDPOINT
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
   CRON
================================ */
app.post("/_cron/track/run", async (_, res) => {
  const { rows } = await pool.query(
    "SELECT awb FROM shipments WHERE next_check_at <= NOW() LIMIT 50"
  );

  let processed = 0;

  for (const r of rows) {
    let d = await trackBluedart(r.awb);
    if (!d) d = await trackShiprocket(r.awb);
    if (d) {
      await persistTracking(r.awb, d);
      processed++;
    }
  }

  res.json({ ok: true, processed });
});

/* ===============================
   HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);