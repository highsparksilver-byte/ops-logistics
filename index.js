import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT & GLOBAL CONFIG
================================ */
const app = express();
axios.defaults.timeout = 8000;

app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

/* ===============================
   🌱 ENV & DATABASE
================================ */
const {
  DATABASE_URL,
  SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_ACCESS_TOKEN,
  SHOP_NAME,
  LOGIN_ID,
  BD_LICENCE_KEY_TRACK,
  BD_LICENCE_KEY_EDD,
  CLIENT_ID,
  CLIENT_SECRET,
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
} = process.env;

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===============================
   🔐 SECURITY
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret || !req.rawBody) return false;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");
  return digest === req.headers["x-shopify-hmac-sha256"];
}

function verifyAdmin(req) {
  const key = req.headers["x-admin-key"] || req.query.key;
  return key === clean(SHOPIFY_WEBHOOK_SECRET);
}

/* ===============================
   🧾 AUDIT LOG (MANDATORY)
================================ */
async function logEvent(type, source, payload) {
  try {
    await pool.query(
      `INSERT INTO event_logs (event_type, source, payload)
       VALUES ($1,$2,$3)`,
      [type, source, JSON.stringify(payload)]
    );
  } catch (e) {
    console.error("Audit log error:", e.message);
  }
}

/* ===============================
   📦 SHIPROCKET AUTH
================================ */
let srJwt = null;
let srAt = 0;

async function getShiprocketJwt() {
  if (srJwt && Date.now() - srAt < 7 * 86400000) return srJwt;
  const r = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    {
      email: clean(SHIPROCKET_EMAIL),
      password: clean(SHIPROCKET_PASSWORD),
    }
  );
  srJwt = r.data.token;
  srAt = Date.now();
  return srJwt;
}

/* ===============================
   📦 TRACKING ENGINE
================================ */
const IGNORE_SCANS = ["BAGGED", "MANIFEST", "NETWORK"];

function resolveShipmentState(status = "") {
  const s = status.toUpperCase();
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("RTO") || s.includes("RETURN")) return "RTO";
  if (s.includes("FAILED") || s.includes("REFUSED") || s.includes("CANCEL"))
    return "NDR";
  if (
    s.includes("OUT FOR") ||
    s.includes("IN TRANSIT") ||
    s.includes("DISPATCHED") ||
    s.includes("SHIPPED")
  )
    return "IN_TRANSIT";
  return "PROCESSING";
}

async function trackBluedart(awb) {
  try {
    const r = await axios.get(
      "https://api.bluedart.com/servlet/RoutingServlet",
      {
        params: {
          handler: "tnt",
          action: "custawbquery",
          loginid: clean(LOGIN_ID),
          awb,
          numbers: awb,
          format: "xml",
          lickey: clean(BD_LICENCE_KEY_TRACK),
          scan: 1,
        },
        responseType: "text",
      }
    );

    if (!r.data || r.data.includes("<html")) return null;

    const p = await xml2js.parseStringPromise(r.data, {
      explicitArray: false,
    });

    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;

    const isFinal = s.Status?.toUpperCase().includes("DELIVERED");

    const scans = (
      Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : [s.Scans?.ScanDetail]
    ).filter((x) => {
      if (!x?.Scan) return false;
      if (isFinal) return true;
      return !IGNORE_SCANS.some((k) =>
        x.Scan.toUpperCase().includes(k)
      );
    });

    return {
      status: s.Status,
      delivered: isFinal,
      history: scans.map((x) => ({
        status: x.Scan,
        date: `${x.ScanDate} ${x.ScanTime}`,
        location: x.ScannedLocation,
      })),
    };
  } catch {
    return null;
  }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${t}` } }
    );
    const d = r.data?.tracking_data;
    if (!d) return null;

    return {
      status: d.current_status,
      delivered: d.current_status
        .toUpperCase()
        .includes("DELIVERED"),
      history: (d.shipment_track_activities || []).map((x) => ({
        status: x.activity,
        date: x.date,
        location: x.location,
      })),
    };
  } catch {
    return null;
  }
}

/* ===============================
   🔄 BACKGROUND SHIPMENT UPDATES
================================ */
async function updateStaleShipments() {
  try {
    const { rows } = await pool.query(`
      SELECT awb, courier_source
      FROM shipments_ops
      WHERE delivered = FALSE
      AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '30 minutes')
      LIMIT 25
    `);

    for (const r of rows) {
      const t =
        r.courier_source === "bluedart"
          ? await trackBluedart(r.awb)
          : await trackShiprocket(r.awb);

      if (!t) continue;

      await pool.query(
        `
        UPDATE shipments_ops
        SET delivered=$1,
            last_status=$2,
            last_state=$3,
            history=$4,
            last_checked_at=NOW()
        WHERE awb=$5
      `,
        [
          t.delivered,
          t.status,
          resolveShipmentState(t.status),
          JSON.stringify(t.history || []),
          r.awb,
        ]
      );
    }
  } catch (e) {
    console.error("Shipment sync error:", e.message);
  }
}

/* ===============================
   🛍️ SHOPIFY ORDER SYNC
================================ */
async function syncShopifyOrder(o) {
  const isExchange =
    o.name?.startsWith("EX-") || o.tags?.includes("exchange");
  const isReturn = o.name?.includes("-R");

  const phone =
    o.phone ||
    o.customer?.phone ||
    o.shipping_address?.phone ||
    null;

  await pool.query(
    `
    INSERT INTO orders_ops (
      id, order_number, financial_status, fulfillment_status,
      total_price, customer_name, customer_phone, city,
      is_exchange, is_return, source, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET
      financial_status=EXCLUDED.financial_status,
      fulfillment_status=EXCLUDED.fulfillment_status,
      customer_phone=EXCLUDED.customer_phone,
      city=EXCLUDED.city
  `,
    [
      String(o.id),
      o.name,
      o.financial_status,
      o.fulfillment_status,
      o.total_price,
      `${o.customer?.first_name || ""} ${
        o.customer?.last_name || ""
      }`.trim(),
      phone,
      o.shipping_address?.city || null,
      isExchange,
      isReturn,
      "shopify",
      o.created_at,
    ]
  );

  for (const f of o.fulfillments || []) {
    if (!f.tracking_number) continue;
    await pool.query(
      `
      INSERT INTO shipments_ops (awb, order_id, courier_source)
      VALUES ($1,$2,$3)
      ON CONFLICT (awb) DO NOTHING
    `,
      [
        f.tracking_number,
        String(o.id),
        f.tracking_company?.toLowerCase().includes("blue")
          ? "bluedart"
          : "shiprocket",
      ]
    );
  }
}

/* ===============================
   🔔 WEBHOOKS
================================ */
app.post("/webhooks/orders_paid", async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req)) return;
  await logEvent("ORDER_PAID", "shopify", req.body);
  await syncShopifyOrder(req.body);
});

app.post("/webhooks/returnprime", async (req, res) => {
  res.sendStatus(200);
  const e = req.body;
  await logEvent("RETURN_PRIME_EVENT", "returnprime", e);
  if (!e.id || !e.order_number) return;

  await pool.query(
    `
    INSERT INTO returns_ops (return_id, order_number, status, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (return_id)
    DO UPDATE SET status=EXCLUDED.status, updated_at=NOW()
  `,
    [String(e.id), e.order_number, e.status || "created"]
  );
});

/* ===============================
   📊 OPS APIs
================================ */
app.get("/ops/orders", async (req, res) => {
  if (!verifyAdmin(req))
    return res.status(403).json({ error: "Unauthorized" });

  const { rows } = await pool.query(`
    SELECT o.*, s.awb, s.last_state, r.status AS return_status
    FROM orders_ops o
    LEFT JOIN shipments_ops s ON s.order_id = o.id
    LEFT JOIN returns_ops r ON r.order_number = o.order_number
    ORDER BY o.created_at DESC
    LIMIT 100
  `);

  res.json({ orders: rows });
});

app.get("/recon/ops", async (req, res) => {
  if (!verifyAdmin(req))
    return res.status(403).json({ error: "Unauthorized" });

  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE is_exchange=FALSE AND is_return=FALSE) AS net_new_orders,
      COUNT(*) FILTER (WHERE is_return=TRUE) AS total_returns,
      COUNT(*) FILTER (WHERE financial_status!='paid' AND fulfillment_status='fulfilled') AS cod_at_risk
    FROM orders_ops
    WHERE created_at > NOW() - INTERVAL '30 days'
  `);

  res.json({ summary: rows[0] });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("READY"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 HighSpark Master Backend LIVE on", PORT)
);

/* ===============================
   ⏱️ BACKGROUND BOOTSTRAP
================================ */
updateStaleShipments();
setInterval(updateStaleShipments, 30 * 60 * 1000);