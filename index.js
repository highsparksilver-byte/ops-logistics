import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";

const { Pool } = pg;

/* =================================================
   🗄️ DATABASE (NEON)
================================================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =================================================
   🚀 APP INIT
================================================= */
const app = express();
app.use(express.json());

/* =================================================
   🌍 CORS (SAFE)
================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

/* =================================================
   🔑 ENV VARS
================================================= */
const LOGIN_ID = clean(process.env.LOGIN_ID);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

console.log("🚀 Ops Logistics – Phase 4 Booting...");
console.log("📍 Courier: Blue Dart");

/* =================================================
   📦 BLUE DART – BATCH TRACKING (25 AWBs / CALL)
================================================= */
async function trackBluedartBatch(awbs) {
  if (!awbs.length) return {};

  const awbString = awbs.join(",");

  try {
    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awbString}` +
      `&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const res = await axios.get(url, {
      responseType: "text",
      timeout: 8000,
    });

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(res.data, { explicitArray: false }, (err, r) =>
        err ? reject(err) : resolve(r)
      )
    );

    const shipments = parsed?.ShipmentData?.Shipment;
    if (!shipments) return {};

    const list = Array.isArray(shipments) ? shipments : [shipments];
    const map = {};

    for (const s of list) {
      map[s.$.WaybillNo] = {
        status: s.Status,
        statusType: s.StatusType, // DL / UD / RT / IT
      };
    }

    return map;
  } catch (err) {
    console.error("❌ Blue Dart batch failed:", err.message);
    return {};
  }
}

/* =================================================
   ❤️ HEALTH CHECK
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   ⏱️ CRON SYNC — PHASE 4 CORE
================================================= */
app.post("/_cron/sync", async (req, res) => {
  try {
    // 1️⃣ Pull ONLY what needs checking (DB-driven)
    const { rows } = await pool.query(`
      SELECT id, awb
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT 25
    `);

    if (!rows.length) {
      return res.json({ ok: true, processed: 0 });
    }

    const awbs = rows.map(r => r.awb);

    // 2️⃣ ONE API CALL FOR 25 ORDERS
    const tracking = await trackBluedartBatch(awbs);

    let processed = 0;

    // 3️⃣ Update DB + Reschedule
    for (const row of rows) {
      const t = tracking[row.awb];
      if (!t) continue;

      // 🔴 STOP — Delivered / RTO
      if (t.statusType === "DL" || t.statusType === "RT") {
        await pool.query(`
          UPDATE shipments
          SET
            last_known_status = $1,
            delivery_confirmed = true,
            delivered_at = NOW(),
            last_checked_at = NOW(),
            next_check_at = '9999-01-01'
          WHERE id = $2
        `, [t.status, row.id]);
      }

      // 🟢 FAST — Out for Delivery / Undelivered
      else if (t.statusType === "UD") {
        await pool.query(`
          UPDATE shipments
          SET
            last_known_status = $1,
            last_checked_at = NOW(),
            next_check_at = NOW() + INTERVAL '1 hour'
          WHERE id = $2
        `, [t.status, row.id]);
      }

      // 🟡 SLOW — In Transit
      else {
        await pool.query(`
          UPDATE shipments
          SET
            last_known_status = $1,
            last_checked_at = NOW(),
            next_check_at = NOW() + INTERVAL '12 hours'
          WHERE id = $2
        `, [t.status, row.id]);
      }

      processed++;
    }

    console.log(`🕒 Cron run | Processed: ${processed}`);

    res.json({ ok: true, processed });
  } catch (err) {
    console.error("❌ Cron crash:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🔁 RENDER KEEP-ALIVE (FREE TIER SAFE)
================================================= */
const SELF_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/health`
  : null;

if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

/* =================================================
   🚀 START SERVER
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);