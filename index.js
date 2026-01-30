import express from "express";
import crypto from "crypto";
import pg from "pg";

const app = express();

/* ===============================
   🔐 RAW BODY FOR HMAC
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
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmac)
  );
}

/* ===============================
   🧠 ORDER TYPE LOGIC
================================ */
function detectOrderType(order) {
  const tags = (order.tags || "").toLowerCase();

  if (
    order.financial_status === "partially_paid" &&
    tags.includes("gokwik_ppcod_upi")
  ) {
    return "PPCOD";
  }

  if (order.financial_status === "paid") {
    return "PREPAID";
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
    const orderType = detectOrderType(o);

    await pool.query(
      `
      INSERT INTO orders_ops (
        shopify_order_id,
        shopify_order_name,
        financial_status,
        fulfillment_status,
        order_type,
        tags,
        customer_phone,
        customer_email
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (shopify_order_id)
      DO UPDATE SET
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        order_type = EXCLUDED.order_type,
        tags = EXCLUDED.tags,
        updated_at = now()
      `,
      [
        o.id.toString(),
        o.name,
        o.financial_status,
        o.fulfillment_status,
        orderType,
        o.tags ? o.tags.split(",").map(t => t.trim()) : [],
        o.phone || null,
        o.email || null
      ]
    );

    console.log("✅ Order paid:", o.name, orderType);
    res.json({ ok: true });
  } catch (e) {
    console.error("orders-paid error:", e);
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
    const orderId = f.order_id?.toString();

    if (!orderId) return res.json({ ok: true });

    await pool.query(
      `
      UPDATE orders_ops
      SET fulfillment_status='fulfilled',
          fulfilled_at=now(),
          updated_at=now()
      WHERE shopify_order_id=$1
      `,
      [orderId]
    );

    console.log("📦 Fulfilled:", orderId);
    res.json({ ok: true });
  } catch (e) {
    console.error("fulfillment error:", e);
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
      SET fulfillment_status='cancelled',
          cancelled_at=now(),
          updated_at=now()
      WHERE shopify_order_id=$1
      `,
      [o.id.toString()]
    );

    console.log("❌ Cancelled:", o.name);
    res.json({ ok: true });
  } catch (e) {
    console.error("cancel error:", e);
    res.status(500).json({ error: "failed" });
  }
});

/* ===============================
   📊 OPS DASHBOARD
================================ */
app.get("/ops/orders", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT *
    FROM orders_ops
    ORDER BY created_at DESC
  `);

  res.json({
    prepaid_fast_ship: rows.filter(
      r => r.order_type === "PREPAID" && !r.fulfillment_status
    ),
    ppcod_to_confirm: rows.filter(
      r => r.order_type === "PPCOD" && r.ops_stage === "PENDING"
    ),
    cod_to_call: rows.filter(
      r => r.order_type === "COD" && r.ops_stage === "PENDING"
    ),
    cancelled: rows.filter(
      r => r.fulfillment_status === "cancelled"
    )
  });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);