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
   🌍 CORS (SHOPIFY SAFE)
================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =================================================
   🔑 ENV HELPERS
================================================= */
const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

const LOGIN_ID = clean(process.env.LOGIN_ID);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

/* =================================================
   🩺 HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   📦 BLUE DART TRACKING
================================================= */
async function trackBluedart(awb) {
  try {
    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    console.log("📡 Calling Blue Dart for", awb);

    const res = await axios.get(url, {
      responseType: "text",
      timeout: 8000,
    });

console.log("📄 RAW BD XML:", res.data);

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(
        res.data,
        { explicitArray: false },
        (err, result) => (err ? reject(err) : resolve(result))
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s || !s.StatusType) {
      console.log("⚠️ Blue Dart response invalid for", awb);
      return null;
    }

    console.log("✅ Blue Dart status for", awb, "→", s.StatusType);

    return {
      status: s.Status,
      statusType: s.StatusType,
    };
  } catch (err) {
    console.log("❌ Blue Dart API failed for", awb);
    console.log(err.message);
    return null;
  }
}

/* =================================================
   ⏱️ CRON SYNC (PRIVATE)
================================================= */
app.post("/_cron/sync", async (req, res) => {
  let processed = 0;

  try {
    console.log("🕒 Cron sync started");

    const { rows } = await pool.query(`
      SELECT id, awb, last_known_status
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT 25
    `);

    console.log("📦 DB rows fetched:", rows.length);

    for (const row of rows) {
      console.log("➡️ Processing AWB:", row.awb);

      const tracking = await trackBluedart(row.awb);

      if (!tracking) {
        console.log("⏭️ Skipping AWB (no tracking):", row.awb);
        continue;
      }

      const isDelivered = tracking.statusType === "DL";

      let nextCheck;

      if (isDelivered) {
        nextCheck = "9999-01-01";
        console.log("🎉 Delivered:", row.awb);
      } else {
        nextCheck = "NOW() + INTERVAL '12 hours'";
        console.log("🚚 In transit:", row.awb);
      }

      await pool.query(
        `
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          next_check_at = ${nextCheck},
          delivery_confirmed = $2,
          delivered_at = CASE WHEN $2 = true THEN NOW() ELSE delivered_at END
        WHERE awb = $3
        `,
        [tracking.status, isDelivered, row.awb]
      );

      processed++;
      console.log("✅ Processed count incremented:", processed);
    }

    console.log("🏁 Cron sync finished | Processed:", processed);

    res.json({ ok: true, processed });
  } catch (err) {
    console.error("🔥 Cron sync crashed");
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🧠 KEEP-ALIVE (RENDER)
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
  console.log("🚀 Server running on port", PORT)
);
