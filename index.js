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
   RECON SUMMARY (JOIN SAFE)
========================================================= */
app.get("/recon/summary", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      bucket,
      COUNT(*) AS count,
      SUM(COALESCE(o.order_total,0)) AS value
    FROM (
      SELECT
        s.awb,
        CASE
          WHEN s.last_known_status ILIKE '%DELIVERED%' THEN 'delivered'
          WHEN s.last_known_status ILIKE '%OUT FOR DELIVERY%' THEN 'out_for_delivery'
          WHEN s.last_known_status ILIKE '%NDR%' THEN 'ndr'
          WHEN s.last_known_status ILIKE '%RTO%' THEN 'rto'
          ELSE 'in_transit'
        END AS bucket,
        s.shopify_order_id
      FROM shipments s
    ) t
    LEFT JOIN orders_ops o
      ON o.shopify_order_id = t.shopify_order_id
    GROUP BY bucket
  `);

  const counts = {};
  const revenue = {
    realized: 0,
    probable: 0,
    questionable: 0,
    dead: 0
  };

  rows.forEach(r => {
    counts[r.bucket] = Number(r.count);

    if (r.bucket === "delivered") revenue.realized += Number(r.value);
    if (r.bucket === "out_for_delivery" || r.bucket === "in_transit")
      revenue.probable += Number(r.value);
    if (r.bucket === "ndr") revenue.questionable += Number(r.value);
    if (r.bucket === "rto") revenue.dead += Number(r.value);
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
   RECON DASHBOARD (JOIN SAFE)
========================================================= */
app.get("/recon/dashboard", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      s.awb,
      s.last_known_status,
      o.shopify_order_name,
      o.order_type,
      o.order_total
    FROM shipments s
    LEFT JOIN orders_ops o
      ON o.shopify_order_id = s.shopify_order_id
    ORDER BY s.updated_at DESC
  `);

  res.json({ rows });
});

/* =========================================================
   CSV EXPORT (JOIN SAFE)
========================================================= */
app.get("/recon/export.csv", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      s.awb,
      o.shopify_order_name,
      o.order_type,
      s.last_known_status,
      o.order_total
    FROM shipments s
    LEFT JOIN orders_ops o
      ON o.shopify_order_id = s.shopify_order_id
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