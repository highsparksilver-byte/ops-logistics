import express from "express";
import axios from "axios";
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
const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION,
  SHOPIFY_SCOPES,
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
  APP_URL
} = process.env;

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🔐 SHOPIFY AUTH START
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

  console.log("➡️ Shopify install:", installUrl);
  res.redirect(installUrl);
});

/* =================================================
   🔐 SHOPIFY CALLBACK
================================================= */
app.get("/auth/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!shop || !code || !hmac) return res.status(400).send("Missing params");

    const query = { ...req.query };
    delete query.hmac;
    delete query.signature;

    const message = new URLSearchParams(query).toString();

    const generatedHmac = crypto
      .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(message)
      .digest("hex");

    if (generatedHmac !== hmac) {
      console.error("❌ HMAC FAILED");
      return res.status(401).send("HMAC failed");
    }

    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      }
    );

    console.log("✅ Shopify token received");

    res.send("App installed successfully. You may close this tab.");
  } catch (err) {
    console.error("❌ OAuth error", err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

/* =================================================
   🕒 CRON — SHOPIFY ORDER SYNC (DEBUG ONLY)
================================================= */
app.post("/_cron/shopify/sync-orders", async (req, res) => {
  try {
    console.log("🔍 SHOPIFY DEBUG");
    console.log("SHOP:", SHOPIFY_SHOP);
    console.log("API VERSION:", SHOPIFY_API_VERSION);
    console.log("TOKEN PRESENT:", !!SHOPIFY_ACCESS_TOKEN);

    const url = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=1`;

    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN
      }
    });

    console.log("✅ Shopify API reachable");

    res.json({ ok: true, sample: response.data.orders?.length || 0 });

  } catch (err) {
    console.error("❌ Shopify sync failed");
    console.error(err.response?.status, err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🚀 START
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);