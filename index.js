/* ===============================
   🚚 TRACKING (CUSTOMER-SAFE)
================================ */
function normalizeStatus(v) {
  if (!v) return "IN TRANSIT";
  return v.toUpperCase().includes("DELIVERED")
    ? "DELIVERED"
    : "IN TRANSIT";
}

async function trackBluedart(awb) {
  try {
    const url =
      `https://api.bluedart.com/servlet/RoutingServlet` +
      `?handler=tnt&action=custawbquery` +
      `&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}` +
      `&format=xml&lickey=${BD_LICENCE_KEY_TRACK}` +
      `&scan=1`;

    const r = await axios.get(url, { responseType: "text", timeout: 8000 });
    const p = await xml2js.parseStringPromise(r.data, { explicitArray: false });
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: normalizeStatus(s.Status),
      delivered: normalizeStatus(s.Status) === "DELIVERED",
      raw: Array.isArray(s.Scans?.ScanDetail)
        ? s.Scans.ScanDetail
        : [s.Scans?.ScanDetail || null]
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
      { headers: { Authorization: `Bearer ${t}` }, timeout: 8000 }
    );

    const td = r.data?.tracking_data;
    if (!td) return null;

    return {
      source: "shiprocket",
      actual_courier: td.courier_name || null,
      status: normalizeStatus(td.current_status),
      delivered: normalizeStatus(td.current_status) === "DELIVERED",
      raw: td.shipment_track || []
    };
  } catch {
    return null;
  }
}

app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  // 🔴 IMPORTANT: NO DB CHECKS HERE
  let data = await trackBluedart(awb);
  if (!data) data = await trackShiprocket(awb);

  if (!data) return res.status(404).json({ error: "not_found" });

  res.json(data);
});