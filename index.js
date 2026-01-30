import express from "express";
import crypto from "crypto";
import pg from "pg";

const app = express();

/* ===============================
   RAW BODY FOR SHOPIFY HMAC
================================ */
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

/* ===============================
   CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===============================
   ENV
================================ */
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

/* ===============================
   DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   SHOPIFY HMAC VERIFY
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

/* =========================================================
   WEBHOOK: ORDER PAID (ops only, no shipment creation)
========================================================= */
app.post("/webhooks/orders-paid", async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  const o = req.body;

  try {
    await pool.query(`
      INSERT INTO orders_ops (
        shopify_order_id,
        shopify_order_name,
        financial_status,
        fulfillment_status,
        order_type,
        tags,
        order_total,
        currency,
        gateway
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (shopify_order_id) DO UPDATE SET
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        order_type = EXCLUDED.order_type,
        tags = EXCLUDED.tags,
        order_total = EXCLUDED.order_total,
        currency = EXCLUDED.currency,
        gateway = EXCLUDED.gateway,
        updated_at = now()
    `, [
      o.id.toString(),
      o.name,
      o.financial_status,
      o.fulfillment_status,
      o.tags?.includes("Gokwik_ppcod_upi") ? "PPCOD" :
      o.financial_status === "paid" ? "PREPAID" : "COD",
      o.tags ? o.tags.split(",") : [],
      o.total_price,
      o.currency,
      o.gateway
    ]);

    console.log("💰 order paid:", o.name);
    res.json({ ok: true });
  } catch (e) {
    console.error("orders-paid error:", e);
    res.status(500).json({ error: "db_error" });
  }
});

/* =========================================================
   WEBHOOK: FULFILLMENT CREATED (CRITICAL LINK)
========================================================= */
app.post("/webhooks/fulfillment-created", async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  const f = req.body;
  const awb = f.tracking_number;

  if (!awb) return res.json({ ok: true });

  try {
    await pool.query(`
      UPDATE shipments
      SET
        shopify_order_id = $1,
        shopify_order_name = $2,
        order_total = (
          SELECT order_total FROM orders_ops
          WHERE shopify_order_id = $1
        )
      WHERE awb = $3
    `, [
      f.order_id.toString(),
      f.order_name,
      awb
    ]);

    console.log("📦 linked shipment:", awb);
    res.json({ ok: true });
  } catch (e) {
    console.error("fulfillment error:", e);
    res.status(500).json({ error: "db_error" });
  }
});

/* =========================================================
   WEBHOOK: ORDER CANCELLED
========================================================= */
app.post("/webhooks/orders-cancelled", async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  const o = req.body;

  try {
    await pool.query(`
      UPDATE orders_ops
      SET
        is_cancelled = true,
        cancelled_at = now(),
        order_type = 'CANCELLED',
        updated_at = now()
      WHERE shopify_order_id = $1
    `, [o.id.toString()]);

    console.log("❌ cancelled:", o.name);
    res.json({ ok: true });
  } catch (e) {
    console.error("cancel error:", e);
    res.status(500).json({ error: "db_error" });
  }
});

/* =========================================================
   RECON CLASSIFICATION
========================================================= */
function classifyRecon(status) {
  if (!status) return "probable";
  const s = status.toUpperCase();
  if (s.includes("DELIVERED")) return "realized";
  if (s.includes("OUT FOR DELIVERY")) return "probable";
  if (s.includes("NDR")) return "questionable";
  if (s.includes("RTO") || s.includes("RETURN")) return "dead";
  return "probable";
}

/* =========================================================
   RECON SUMMARY
========================================================= */
app.get("/recon/summary", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      recon_bucket,
      COUNT(*) count,
      SUM(COALESCE(order_total,0)) value
    FROM (
      SELECT
        awb,
        order_total,
        CASE
          WHEN last_known_status ILIKE '%DELIVERED%' THEN 'delivered'
          WHEN last_known_status ILIKE '%OUT FOR DELIVERY%' THEN 'out_for_delivery'
          WHEN last_known_status ILIKE '%NDR%' THEN 'ndr'
          WHEN last_known_status ILIKE '%RTO%' THEN 'rto'
          ELSE 'in_transit'
        END recon_bucket
      FROM shipments
    ) t
    GROUP BY recon_bucket
  `);

  const counts = {};
  const revenue = { realized:0, probable:0, questionable:0, dead:0 };

  rows.forEach(r => {
    counts[r.recon_bucket] = Number(r.count);
    if (r.recon_bucket === "delivered") revenue.realized += Number(r.value);
    if (r.recon_bucket === "out_for_delivery" || r.recon_bucket === "in_transit") revenue.probable += Number(r.value);
    if (r.recon_bucket === "ndr") revenue.questionable += Number(r.value);
    if (r.recon_bucket === "rto") revenue.dead += Number(r.value);
  });

  res.json({
    counts,
    revenue,
    acos: {
      worst_case: 0,
      probable_case: 0,
      best_case: 0
    }
  });
});

/* =========================================================
   RECON DASHBOARD
========================================================= */
app.get("/recon/dashboard", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      awb,
      last_known_status,
      shopify_order_name,
      order_type,
      order_total
    FROM shipments
    ORDER BY updated_at DESC
  `);

  res.json({ rows });
});

/* =========================================================
   CSV EXPORT
========================================================= */
app.get("/recon/export.csv", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      awb,
      shopify_order_name,
      order_type,
      last_known_status,
      order_total
    FROM shipments
  `);

  let csv = "AWB,Order,Type,Status,OrderValue\n";
  rows.forEach(r => {
    csv += `${r.awb},${r.shopify_order_name},${r.order_type},${r.last_known_status},${r.order_total}\n`;
  });

  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

/* ===============================
   HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);