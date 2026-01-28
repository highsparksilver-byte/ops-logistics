import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import crypto from "crypto";
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

/* =================================================
   🔑 CREDENTIALS
================================================= */
const CLIENT_ID = clean(process.env.CLIENT_ID);
const CLIENT_SECRET = clean(process.env.CLIENT_SECRET);
const LOGIN_ID = clean(process.env.LOGIN_ID);

const LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_API_VERSION,
  APP_URL
} = process.env;

console.log("🚀 Ops Logistics starting…");

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🔐 PHASE 6.2 — SHOPIFY AUTH START
================================================= */
app.get("/auth/shopify", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop");

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/shopify/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  console.log("➡️ Shopify install:", shop);
  res.redirect(installUrl);
});

/* =================================================
   🔐 PHASE 6.3 — SHOPIFY CALLBACK + SAVE TOKEN
================================================= */
app.get("/auth/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!shop || !code || !hmac) {
      return res.status(400).send("Missing OAuth params");
    }

    /* ---- HMAC VERIFY ---- */
    const q = { ...req.query };
    delete q.hmac;
    delete q.signature;

    const msg = new URLSearchParams(q).toString();
    const hash = crypto
      .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(msg)
      .digest("hex");

    if (hash !== hmac) {
      console.error("❌ Shopify HMAC failed");
      return res.status(401).send("HMAC validation failed");
    }

    /* ---- TOKEN EXCHANGE ---- */
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      }
    );

    const accessToken = tokenRes.data.access_token;

    /* ---- SAVE TO NEON ---- */
    await pool.query(
      `
      INSERT INTO shopify_shops (shop_domain, access_token)
      VALUES ($1, $2)
      ON CONFLICT (shop_domain)
      DO UPDATE SET access_token = EXCLUDED.access_token
      `,
      [shop, accessToken]
    );

    console.log("✅ Shopify token saved for", shop);

    res.send(`
      <h2>✅ App Installed Successfully</h2>
      <p>Shop: ${shop}</p>
      <p>You can close this window.</p>
    `);

  } catch (err) {
    console.error("❌ OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

/* =================================================
   📦 BLUEDART TRACK (SINGLE)
================================================= */
async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml` +
      `&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const res = await axios.get(url, {
      responseType: "text",
      timeout: 10000
    });

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(res.data, { explicitArray: false }, (e, r) =>
        e ? reject(e) : resolve(r)
      )
    );

    const s = parsed?.ShipmentData?.Shipment;
    if (!s || !s.StatusType) return null;

    return {
      status: s.Status,
      statusType: s.StatusType
    };

  } catch {
    return null;
  }
}

/* =================================================
   ⏱️ CRON — SHIPMENT SYNC
================================================= */
app.post("/_cron/sync", async (req, res) => {
  try {
    console.log("🕒 Cron sync started");

    const { rows } = await pool.query(`
      SELECT id, awb
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      LIMIT 25
    `);

    let processed = 0;

    for (const r of rows) {
      const t = await trackBluedart(r.awb);
      if (!t) continue;

      if (t.statusType === "DL") {
        await pool.query(
          `
          UPDATE shipments
          SET delivery_confirmed = true,
              last_known_status = 'Delivered',
              delivered_at = NOW(),
              last_checked_at = NOW(),
              next_check_at = '9999-01-01'
          WHERE id = $1
          `,
          [r.id]
        );
      } else {
        await pool.query(
          `
          UPDATE shipments
          SET last_known_status = $1,
              last_checked_at = NOW(),
              next_check_at = NOW() + INTERVAL '6 hours'
          WHERE id = $2
          `,
          [t.status, r.id]
        );
      }

      processed++;
    }

    console.log("🏁 Cron done | Processed:", processed);
    res.json({ ok: true, processed });

  } catch (e) {
    console.error("❌ Cron failed:", e.message);
    res.status(500).json({ ok: false });
  }
});

/* =================================================
   🧠 KEEP ALIVE (RENDER)
================================================= */
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

/* =================================================
   🚀 START
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);