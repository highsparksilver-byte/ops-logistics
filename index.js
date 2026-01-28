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
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY_TRACK = process.env.BD_LICENCE_KEY_TRACK;

console.log("🚀 Server Starting...");
console.log("📍 Warehouse: Pune (411022)");

/* =================================================
   🔑 JWT CACHE (BLUEDART)
================================================= */
let bdJwt = null;
let bdJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23 * 60 * 60 * 1000) return bdJwt;

  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    }
  );

  bdJwt = res.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}

/* =================================================
   📦 TRACKING (BLUEDART)
================================================= */
async function trackBluedart(awb) {
  try {
    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const res = await axios.get(url, {
      responseType: "text",
      timeout: 8000,
    });

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(res.data, { explicitArray: false }, (err, r) =>
        err ? reject(err) : resolve(r)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s || !s.Status) return null;

    return {
      status: s.Status,
      statusType: s.StatusType, // DL, UD, RT, etc
    };
  } catch {
    return null;
  }
}

/* =================================================
   ⏱️ NEXT CHECK CALCULATOR (TRAFFIC LIGHT)
================================================= */
function calculateNextCheck(statusType) {
  const now = new Date();

  // 🔴 STOP FOREVER
  if (statusType === "DL" || statusType === "RT") {
    return new Date("9999-01-01");
  }

  // 🟢 FAST
  if (statusType === "UD") {
    return new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour
  }

  // 🟡 SLOW
  return new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours
}

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   ⏱️ CRON SYNC (PRIVATE)
================================================= */
app.post("/_cron/sync", async (req, res) => {
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

    console.log("🕒 Cron run | Due:", rows.length);

    for (const row of rows) {
      const tracking = { status: "Delivered", statusType: "DL" };
      if (!tracking) continue;

      const nextCheck = calculateNextCheck(tracking.statusType);

      await pool.query(
        `
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          next_check_at = $2,
          delivery_confirmed = $3,
          delivered_at = CASE WHEN $3 = true THEN NOW() ELSE delivered_at END
        WHERE id = $4
        `,
        [
          tracking.status,
          nextCheck,
          tracking.statusType === "DL",
          row.id,
        ]
      );

      console.log(
        `📦 ${row.awb} → ${tracking.statusType} | next check @ ${nextCheck.toISOString()}`
      );
    }

    res.json({ ok: true, processed: rows.length });
  } catch (err) {
    console.error("❌ Cron sync failed");
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
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
