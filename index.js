import express from "express";
import axios from "axios";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(express.json());

/* =================================================
   🗄️ DATABASE
================================================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =================================================
   🔐 SHOPIFY HELPERS
================================================= */
async function getShopToken() {
  const { rows } = await pool.query(`
    SELECT shop_domain, access_token
    FROM shopify_shops
    ORDER BY installed_at DESC
    LIMIT 1
  `);

  if (rows.length === 0) {
    throw new Error("No shop installed");
  }

  return rows[0];
}

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🛒 PHASE 8.3.1 — SYNC FULFILLMENTS
================================================= */
app.post("/_cron/shopify/sync-fulfillments", async (req, res) => {
  try {
    console.log("📦 Shopify fulfillment sync started");

    const { shop_domain, access_token } = await getShopToken();

    const headers = {
      "X-Shopify-Access-Token": access_token,
      "Content-Type": "application/json",
    };

    const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";

    // 1️⃣ Fetch recent orders (limit to avoid abuse)
    const ordersRes = await axios.get(
      `https://${shop_domain}/admin/api/${apiVersion}/orders.json?status=any&limit=50`,
      { headers }
    );

    let fulfillmentCount = 0;

    for (const order of ordersRes.data.orders) {
      if (!order.fulfillments || order.fulfillments.length === 0) continue;

      for (const f of order.fulfillments) {
        if (!f.tracking_number) continue;

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
            delivery_confirmed,
            created_at,
            updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW(),NOW())
          ON CONFLICT (awb) DO NOTHING
        `,
          [
            order.id,
            order.name,
            f.id,
            f.tracking_number,
            f.tracking_company || "unknown",
            order.phone,
            order.email,
          ]
        );

        fulfillmentCount++;
      }
    }

    console.log(`✅ Fulfillments synced: ${fulfillmentCount}`);

    res.json({
      ok: true,
      fulfillments_synced: fulfillmentCount,
    });
  } catch (err) {
    console.error("❌ Fulfillment sync failed");
    console.error(err.message);
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