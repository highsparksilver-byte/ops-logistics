import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT & CONFIG
================================ */
const app = express();
const rateLimiter = new Map();
axios.defaults.timeout = 8000;

setInterval(() => { rateLimiter.clear(); console.log("🧹 Rate limiter cleared"); }, 60 * 60 * 1000);

app.use(express.json({ 
  limit: "2mb", 
  verify: (req, res, buf) => { req.rawBody = buf.toString(); } 
}));

// ✅ FIX 2: Complete CORS & Preflight handling
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = v => v?.replace(/\r|\n|\t/g, "").trim();
const { 
  DATABASE_URL, SHOPIFY_WEBHOOK_SECRET, SHOP_NAME, SHOPIFY_ACCESS_TOKEN 
} = process.env;

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

/* ===============================
   🔐 SECURITY (FIX 1)
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret || !req.rawBody) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  return digest === req.headers["x-shopify-hmac-sha256"];
}

// ✅ FIX 1: Secure Admin Endpoints
function verifyAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.key;
  return key === clean(SHOPIFY_WEBHOOK_SECRET);
}

async function logEvent(type, source, payload) {
  try {
    await pool.query("INSERT INTO event_logs (event_type, source, payload) VALUES ($1, $2, $3)", 
    [type, source, JSON.stringify(payload)]);
  } catch (e) { console.error("Log Error", e); }
}

/* ===============================
   🔄 DOMAIN SYNC LOGIC
================================ */
async function syncShopifyOrder(o) {
  const isExchange = o.name.startsWith("EX-") || (o.tags && o.tags.includes("exchange"));
  const isReturn = o.name.includes("-R");
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || null;

  await pool.query(`
    INSERT INTO orders_ops (id, order_number, financial_status, fulfillment_status, total_price, customer_name, customer_phone, city, is_exchange, is_return, source, created_at) 
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET financial_status=EXCLUDED.financial_status, fulfillment_status=EXCLUDED.fulfillment_status
  `, [o.id, o.name, o.financial_status, o.fulfillment_status, o.total_price, `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim(), phone, o.shipping_address?.city, isExchange, isReturn, 'shopify', o.created_at]);
}

/* ===============================
   🔔 WEBHOOKS (INBOUND)
================================ */
app.post("/webhooks/orders_paid", async (req, res) => {
  res.sendStatus(200);
  if (verifyShopify(req)) {
    await logEvent("ORDER_PAID", "shopify", req.body);
    await syncShopifyOrder(req.body);
  }
});

app.post("/webhooks/returnprime", async (req, res) => {
  res.sendStatus(200);
  const event = req.body;
  await logEvent("RETURN_PRIME", "returnprime", event);
  
  const { return_id, order_id, order_number, status, tracking_number, items } = event;
  await pool.query(`
    INSERT INTO returns_ops (return_id, order_id, order_number, status, tracking_number, items, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (return_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()
  `, [return_id, order_id, order_number, status, tracking_number, JSON.stringify(items || [])]);
});

/* ===============================
   🛠️ PROTECTED OPS APIs
================================ */
app.get("/ops/orders", async (req, res) => {
  // ✅ ROUTE PROTECTION (FIX 1)
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  const { rows } = await pool.query(`
    SELECT o.*, s.awb, r.status as return_status
    FROM orders_ops o 
    LEFT JOIN shipments_ops s ON s.order_id = o.id
    LEFT JOIN returns_ops r ON r.order_id = o.id
    ORDER BY o.created_at DESC LIMIT 100
  `);
  res.json({ orders: rows });
});

app.get("/recon/ops", async (req, res) => {
  // ✅ ROUTE PROTECTION (FIX 1)
  if (!verifyAdmin(req)) return res.status(403).json({ error: "Unauthorized" });

  const { rows } = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE is_exchange = FALSE AND is_return = FALSE) as net_new_orders,
      COUNT(*) FILTER (WHERE is_return = TRUE) as total_returns,
      COUNT(*) FILTER (WHERE financial_status != 'paid' AND fulfillment_status = 'fulfilled') as cod_at_risk
    FROM orders_ops WHERE created_at > NOW() - INTERVAL '30 days'
  `);
  res.json({ summary: rows[0] });
});

app.get("/health", (_, res) => res.send("READY"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🚀 Secure Master V2 Live on", PORT));