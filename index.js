/* =================================================
   📦 PHASE 8.4 — CUSTOMER TRACKING API
================================================= */
app.post("/track/customer", async (req, res) => {
  try {
    let { phone, email, order_id } = req.body;

    /* ==============================
       🧹 NORMALIZATION
    ============================== */

    // Normalize phone (India-first)
    if (phone) {
      phone = phone.replace(/\D/g, "");
      if (phone.length === 10) phone = `+91${phone}`;
      if (phone.startsWith("91") && phone.length === 12) phone = `+${phone}`;
    }

    // Normalize order ID
    if (order_id) {
      order_id = order_id.toUpperCase();
      if (!order_id.startsWith("#")) order_id = `#${order_id}`;
      if (!order_id.startsWith("#HS")) order_id = `#HS${order_id.replace("#", "")}`;
    }

    if (!phone && !email && !order_id) {
      return res.status(400).json({ error: "Phone, email, or order_id required" });
    }

    /* ==============================
       🔍 QUERY DB
    ============================== */
    const conditions = [];
    const values = [];

    if (phone) {
      values.push(phone);
      conditions.push(`customer_mobile = $${values.length}`);
    }

    if (email) {
      values.push(email);
      conditions.push(`customer_email = $${values.length}`);
    }

    if (order_id) {
      values.push(order_id);
      conditions.push(`shopify_order_name = $${values.length}`);
    }

    const { rows } = await pool.query(
      `
      SELECT *
      FROM shipments
      WHERE ${conditions.join(" OR ")}
      ORDER BY created_at DESC
      `,
      values
    );

    if (rows.length === 0) {
      return res.json({ error: "No orders found" });
    }

    /* ==============================
       🧠 SMART VISIBILITY LOGIC
    ============================== */
    const active = rows.filter(r => !r.delivery_confirmed);
    let result = [];

    if (active.length > 0) {
      result = active;
    } else {
      // show ONLY latest delivered
      result = [rows[0]];
    }

    res.json({
      mode: active.length > 0 ? "ACTIVE_ONLY" : "LATEST_DELIVERED",
      count: result.length,
      orders: result,
    });

  } catch (err) {
    console.error("❌ Customer tracking failed", err.message);
    res.status(500).json({ error: "Tracking failed" });
  }
});