import express from "express";
import crypto from "crypto";
import axios from "axios";
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
   🔑 ENV
================================================= */
const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION,
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
} = process.env;

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🛒 PHASE 8.2 — SYNC ALL ORDERS
================================================= */
app.post("/_cron/shopify/sync-orders", async (_, res) => {
  try {
    const url = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/orders.json?limit=250&status=any`;

    const r = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
    });

    const orders = r.data.orders;

    for (const o of orders) {
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
        ON CONFLICT (shopify_order_id) DO NOTHING
        `,
        [
          SHOPIFY_SHOP,
          o.id,
          o.name,
          o.financial_status,
          o.fulfillment_status,
          o.cancelled_at,
          o.email,
          o.phone,
          o.created_at,
          o.updated_at,
        ]
      );
    }

    res.json({ ok: true, orders_fetched: orders.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🚚 PHASE 8.3 — SYNC FULFILLMENTS → SHIPMENTS
================================================= */
app.post("/_cron/shopify/sync-fulfillments", async (_, res) => {
  try {
    console.log("🚚 Shopify fulfillment sync started");

    const url = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/orders.json?limit=100&status=any&fields=id,name,email,phone,fulfillments`;

    const r = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
    });

    let created = 0;

    for (const order of r.data.orders) {
      for (const f of order.fulfillments || []) {
        const awb = f.tracking_number;
        if (!awb) continue;

        const exists = await pool.query(
          `SELECT 1 FROM shipments WHERE awb = $1`,
          [awb]
        );

        if (exists.rowCount > 0) continue;

        await pool.query(
          `
          INSERT INTO shipments (
            shopify_order_id,
            shopify_order_name,
            fulfillment_id,
            awb,
            courier,
            customer_mobile,
            customer_email,
            next_check_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
          `,
          [
            order.id,
            order.name,
            f.id,
            awb,
            f.tracking_company || "bluedart",
            order.phone,
            order.email,
          ]
        );

        created++;
        console.log("📦 Shipment created:", awb);
      }
    }

    res.json({ ok: true, shipments_created: created });
  } catch (err) {
    console.error("❌ Fulfillment sync failed", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🚀 START
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Ops Logistics running on port ${PORT}`)
);