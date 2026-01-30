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
  ssl: { rejectUnauthorized: false }
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
   🔑 ENV
================================================= */
const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

const LOGIN_ID = clean(process.env.LOGIN_ID);
const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

/* =================================================
   📦 BLUE DART (BATCH)
================================================= */
async function trackBluedartBatch(awbs) {
  try {
    const numbers = awbs.join(",");

    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${numbers}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const res = await axios.get(url, {
      responseType: "text",
      timeout: 15000
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
        statusType: s.StatusType
      };
    }

    return map;
  } catch (e) {
    console.error("❌ Blue Dart batch failed:", e.message);
    return {};
  }
}

/* =================================================
   🧠 NEXT CHECK CALCULATOR
================================================= */
function calculateNextCheck(statusType) {
  const now = new Date();

  if (statusType === "DL" || statusType === "RT") {
    return new Date("9999-01-01");
  }

  if (statusType === "UD") {
    return new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
  }

  return new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours
}

/* =================================================
   ⏱️ CRON SYNC (BATCHED)
================================================= */
app.post("/_cron/sync", async (req, res) => {
  try {
    console.log("🕒 Cron sync started (batched)");

    const { rows } = await pool.query(`
      SELECT id, awb
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT 25
    `);

    console.log("📦 Due shipments:", rows.length);
    if (rows.length === 0) {
      return res.json({ ok: true, processed: 0 });
    }

    const awbs = rows.map(r => r.awb);
    const results = await trackBluedartBatch(awbs);

    let processed = 0;

    for (const row of rows) {
      const result = results[row.awb];
      if (!result) {
        console.log("⏭️ No tracking for", row.awb);
        continue;
      }

      const delivered = result.statusType === "DL";
      const nextCheck = calculateNextCheck(result.statusType);

      await pool.query(`
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          next_check_at = $2,
          delivery_confirmed = $3,
          delivered_at = CASE WHEN $3 = true THEN NOW() ELSE delivered_at END
        WHERE awb = $4
      `, [
        result.status,
        nextCheck,
        delivered,
        row.awb
      ]);

      processed++;
      console.log("✅", row.awb, "→", result.statusType);
    }

    console.log("🏁 Cron finished | Processed:", processed);
    res.json({ ok: true, processed });

  } catch (err) {
    console.error("🔥 Cron crashed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🧠 PHASE 7 — CUSTOMER TRACKING (SMART)
================================================= */
app.post("/track/customer", async (req, res) => {
  const { phone, email, order_id } = req.body;

  if (!phone && !email && !order_id) {
    return res.status(400).json({
      error: "Provide phone, email, or order_id"
    });
  }

  let where = [];
  let values = [];

  if (phone) {
    values.push(phone);
    where.push(`customer_mobile = $${values.length}`);
  }

  if (email) {
    values.push(email);
    where.push(`customer_email = $${values.length}`);
  }

  if (order_id) {
    values.push(order_id);
    where.push(`shopify_order_id = $${values.length}`);
  }

  const { rows } = await pool.query(`
    SELECT *
    FROM shipments
    WHERE ${where.join(" OR ")}
    ORDER BY created_at DESC
  `, values);

  if (rows.length === 0) {
    return res.status(404).json({ error: "No orders found" });
  }

  const active = rows.filter(r => r.delivery_confirmed === false);
  const delivered = rows.filter(r => r.delivery_confirmed === true);

  if (active.length > 0) {
    return res.json({
      mode: "ACTIVE_ONLY",
      count: active.length,
      orders: active
    });
  }

  return res.json({
    mode: "LATEST_DELIVERED",
    count: 1,
    orders: [delivered[0]]
  });
});

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🚀 START
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);