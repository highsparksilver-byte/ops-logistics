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
   🌍 CORS
================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =================================================
   🔑 CONFIG
================================================= */
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY_TRACK = process.env.BD_LICENCE_KEY_TRACK;

console.log("🚀 Ops Logistics starting (Phase 5.2 – Batched)");

/* =================================================
   🧠 TRAFFIC LIGHT SCHEDULER
================================================= */
function calculateNextCheck(statusType) {
  const now = new Date();

  if (statusType === "DL" || statusType === "RT") {
    return new Date("9999-01-01T00:00:00Z");
  }

  if (statusType === "UD") {
    return new Date(now.getTime() + 1 * 60 * 60 * 1000);
  }

  if (statusType === "IT" || statusType === "PU") {
    return new Date(now.getTime() + 12 * 60 * 60 * 1000);
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

/* =================================================
   📦 BLUEDART — BATCH TRACKING
================================================= */
async function trackBluedartBatch(awbs) {
  if (!awbs.length) return {};

  const awbString = awbs.join(",");

  const url =
    "https://api.bluedart.com/servlet/RoutingServlet" +
    `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
    `&awb=awb&numbers=${awbString}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

  console.log(`📡 Blue Dart batch call (${awbs.length} AWBs)`);

  const res = await axios.get(url, {
    responseType: "text",
    timeout: 15000,
  });

  console.log(`📄 RAW BD XML (batch)`);

  const parsed = await new Promise((resolve, reject) =>
    xml2js.parseString(res.data, { explicitArray: false }, (err, r) =>
      err ? reject(err) : resolve(r)
    )
  );

  const shipments = parsed?.ShipmentData?.Shipment;
  if (!shipments) return {};

  const list = Array.isArray(shipments) ? shipments : [shipments];

  const result = {};
  for (const s of list) {
    result[s.$.WaybillNo] = {
      status: s.Status,
      statusType: s.StatusType,
    };
  }

  return result;
}

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   ⏱️ CRON SYNC (BATCHED)
================================================= */
app.post("/_cron/sync", async (_, res) => {
  console.log("🕒 Cron sync started (batched)");

  try {
    const { rows } = await pool.query(`
      SELECT id, awb
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT 25
    `);

    console.log(`📦 Due shipments: ${rows.length}`);

    if (!rows.length) {
      return res.json({ ok: true, processed: 0 });
    }

    const awbs = rows.map(r => r.awb);
    const trackingMap = await trackBluedartBatch(awbs);

    let processed = 0;

    for (const row of rows) {
      const tracking = trackingMap[row.awb];
      if (!tracking) {
        console.log(`⏭️ No tracking for ${row.awb}`);
        continue;
      }

      const { status, statusType } = tracking;
      const nextCheck = calculateNextCheck(statusType);

      console.log(`✅ ${row.awb} → ${statusType}`);

      await pool.query(
        `
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          delivery_confirmed = $2,
          delivered_at = CASE WHEN $2 = true THEN NOW() ELSE delivered_at END,
          next_check_at = $3,
          updated_at = NOW()
        WHERE id = $4
        `,
        [
          status,
          statusType === "DL" || statusType === "RT",
          nextCheck,
          row.id,
        ]
      );

      processed++;
    }

    console.log(`🏁 Cron finished | Processed: ${processed}`);
    res.json({ ok: true, processed });
  } catch (err) {
    console.error("🔥 Cron failed");
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🚀 START SERVER
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
