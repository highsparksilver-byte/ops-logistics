import express from "express";
import axios from "axios";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

/* =================================================
   🗄️ DATABASE
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
   🔑 SHOPIFY CONFIG
================================================= */
const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION,
  SHOPIFY_SHOP
} = process.env;

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🔐 SHOPIFY ORDER SYNC (ALL ORDERS)
================================================= */
app.post("/_cron/shopify/sync-orders", async (req, res) => {
  try {
    console.log("🛒 Shopify full order sync started");

    const { rows } = await pool.query(
      `SELECT access_token FROM shopify_shops WHERE shop_domain = $1`,
      [SHOPIFY_SHOP]
    );

    if (!rows.length) {
      return res.status(400).json({ error: "No shop installed" });
    }

    const token = rows[0].access_token;

    const url = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/orders.json?limit=250&status=any`;

    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": token
      }
    });

    const orders = response.data.orders || [];
    console.log(`📦 Orders fetched: ${orders.length}`);

    for (const o of orders) {
      const customer = o.customer || {};

      await pool.query(
        `
        INSERT INTO shopify_orders (
          shop_domain,
          shopify_order_id,
          order_name,
          financial_status,
          fulfillment_status,
          cancelled_at,
          customer_email,
          customer_phone,
          created_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (shopify_order_id)
        DO UPDATE SET
          financial_status = EXCLUDED.financial_status,
          fulfillment_status = EXCLUDED.fulfillment_status,
          cancelled_at = EXCLUDED.cancelled_at,
          updated_at = EXCLUDED.updated_at
        `,
        [
          SHOPIFY_SHOP,
          o.id,
          o.name,
          o.financial_status,
          o.fulfillment_status,
          o.cancelled_at,
          customer.email || null,
          customer.phone || null,
          o.created_at,
          o.updated_at
        ]
      );
    }

    console.log("✅ Shopify order sync complete");
    res.json({ ok: true, orders_fetched: orders.length });

  } catch (err) {
    console.error("❌ Shopify sync failed");
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🚀 START SERVER
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);