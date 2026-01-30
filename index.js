import express from "express";
import crypto from "crypto";
import pg from "pg";

const app = express();

/* ===============================
   🔐 RAW BODY (SHOPIFY HMAC)
================================ */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

/* ===============================
   🌍 CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===============================
   🔑 ENV
================================ */
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
if (!SHOPIFY_WEBHOOK_SECRET) {
  console.error("❌ SHOPIFY_WEBHOOK_SECRET missing");
}

/* ===============================
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🔐 HMAC VERIFY
================================ */
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}

/* ===============================
   🧠 ORDER TYPE LOGIC (8.1 + 8.2 + 8.3)
================================ */
function resolveOrderType(order) {
  const tags = (order.tags || "").toLowerCase();

  if (order.cancelled_at || order.financial_status === "voided") {
    return "CANCELLED";
  }

  if (order.financial_status === "paid") {
    return "PREPAID";
  }

  if (
    order.financial_status === "partially_paid" &&
    tags.includes("gokwik_ppcod_upi")
  ) {
    return "PPCOD";
  }

  return "COD";
}

/* ===============================
   📦 WEBHOOK: ORDER PAID
================================ */
app.post("/webhooks/orders-paid", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const o = req.body;
    const orderType = resolveOrderType(o);

    await pool.query(
      `
      INSERT INTO orders_ops (
        shopify_order_id,
        shopify_order_name,
        shop_domain,
        financial_status,
        fulfillment_status,
        order_type,
        tags,
        customer_email,
        created_at,
        updated_at,

        order_total_price,
        total_discounts,
        total_tax,
        total_shipping_price,
        total_refunded,
        currency,
        gateway
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),
        $9,$10,$11,$12,$13,$14,$15
      )
      ON CONFLICT (shopify_order_id)
      DO UPDATE SET
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        order_type = EXCLUDED.order_type,
        tags = EXCLUDED.tags,
        updated_at = NOW(),
        order_total_price = EXCLUDED.order_total_price,
        total_discounts = EXCLUDED.total_discounts,
        total_tax = EXCLUDED.total_tax,
        total_shipping_price = EXCLUDED.total_shipping_price,
        total_refunded = EXCLUDED.total_refunded,
        currency = EXCLUDED.currency,
        gateway = EXCLUDED.gateway
      `,
      [
        o.id,
        o.name,
        o.shop_domain || null,
        o.financial_status,
        o.fulfillment_status,
        orderType,
        o.tags ? o.tags.split(",") : [],
        o.email || null,

        o.total_price || 0,
        o.total_discounts || 0,
        o.total_tax || 0,
        o.total_shipping_price_set?.shop_money?.amount || 0,
        o.total_refunded || 0,
        o.currency || "INR",
        o.gateway || null
      ]
    );

    console.log("✅ orders-paid:", o.name, orderType);
    res.json({ ok: true });
  } catch (err) {
    console.error("orders-paid error:", err);
    res.status(500).json({ error: "failed" });
  }
});

/* ===============================
   📦 WEBHOOK: FULFILLMENT CREATED
================================ */
app.post("/webhooks/fulfillment-created", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const f = req.body;

    await pool.query(
      `
      UPDATE orders_ops
      SET fulfillment_status = 'fulfilled',
          fulfilled_at = NOW(),
          updated_at = NOW()
      WHERE shopify_order_id = $1
      `,
      [f.order_id]
    );

    console.log("📦 fulfillment:", f.order_id);
    res.json({ ok: true });
  } catch (err) {
    console.error("fulfillment error:", err);
    res.status(500).json({ error: "failed" });
  }
});

/* ===============================
   ❌ WEBHOOK: ORDER CANCELLED
================================ */
app.post("/webhooks/orders-cancelled", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const o = req.body;

    await pool.query(
      `
      UPDATE orders_ops
      SET
        financial_status = 'voided',
        fulfillment_status = 'cancelled',
        cancelled_at = NOW(),
        order_type = 'CANCELLED',
        updated_at = NOW()
      WHERE shopify_order_id = $1
      `,
      [o.id]
    );

    console.log("❌ cancelled:", o.name);
    res.json({ ok: true });
  } catch (err) {
    console.error("cancel error:", err);
    res.status(500).json({ error: "failed" });
  }
});

/* ===============================
   📊 OPS DASHBOARD (STRICT BUCKETS)
================================ */
app.get("/ops/orders", async (_, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM orders_ops ORDER BY created_at DESC`
  );

  const buckets = {
    prepaid_fast_ship: [],
    ppcod_to_confirm: [],
    cod_to_call: [],
    cancelled: []
  };

  for (const o of rows) {
    if (o.order_type === "CANCELLED") {
      buckets.cancelled.push(o);
    } else if (o.order_type === "PREPAID") {
      buckets.prepaid_fast_ship.push(o);
    } else if (o.order_type === "PPCOD") {
      buckets.ppcod_to_confirm.push(o);
    } else {
      buckets.cod_to_call.push(o);
    }
  }

  res.json(buckets);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);