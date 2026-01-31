import express from "express";
import axios from "axios";
import xml2js from "xml2js";

/* ===============================
   🚀 APP INIT
================================ */
const app = express();
app.use(express.json());

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
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();

const LOGIN_ID = clean(process.env.LOGIN_ID);
const BD_LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

if (!LOGIN_ID || !BD_LICENCE_KEY_TRACK) {
  console.error("❌ Missing Blue Dart env vars");
  process.exit(1);
}

/* ===============================
   🧠 STATUS HELPERS (UI SAFE)
================================ */
function getStatusType(s = "") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";   // Green
  if (s.includes("RTO") || s.includes("RETURN")) return "RT"; // Red
  if (s.includes("UNDELIVERED") || s.includes("FAILURE")) return "NDR"; // Red
  if (s.includes("OUT FOR")) return "OF";     // Orange
  if (s.includes("PICK")) return "PU";        // Orange
  return "UD";                                // Default
}

/* ===============================
   🚚 BLUEDART TRACKING (XML ONLY)
================================ */
async function trackBluedart(awb) {
  const url =
    `https://api.bluedart.com/servlet/RoutingServlet` +
    `?handler=tnt&action=custawbquery` +
    `&loginid=${LOGIN_ID}` +
    `&awb=awb&numbers=${awb}` +
    `&format=xml` +
    `&lickey=${BD_LICENCE_KEY_TRACK}` +
    `&scan=1`;

  try {
    const r = await axios.get(url, {
      responseType: "text",
      timeout: 10000
    });

    // 🔍 DEBUG: log first part of response
    console.log("📦 Bluedart raw (first 300 chars):");
    console.log(r.data.slice(0, 300));

    const parsed = await xml2js.parseStringPromise(r.data, {
      explicitArray: false
    });

    const shipment = parsed?.ShipmentData?.Shipment;
    if (!shipment || !shipment.Status) return null;

    const scans =
      Array.isArray(shipment.Scans?.ScanDetail)
        ? shipment.Scans.ScanDetail
        : shipment.Scans?.ScanDetail
        ? [shipment.Scans.ScanDetail]
        : [];

    return {
      source: "bluedart",
      actual_courier: "Blue Dart",
      status: shipment.Status,
      statusType: getStatusType(shipment.Status),
      statusDate: shipment.StatusDate || null,
      statusTime: shipment.StatusTime || null,
      delivered: getStatusType(shipment.Status) === "DL",
      raw: scans
    };
  } catch (err) {
    console.error("❌ Bluedart API error:", err.message);
    return null;
  }
}

/* ===============================
   📍 TRACK ROUTE (BLUEDART ONLY)
================================ */
app.get("/track", async (req, res) => {
  const { awb } = req.query;
  if (!awb) return res.status(400).json({ error: "awb_required" });

  const data = await trackBluedart(awb);

  if (!data) {
    return res.status(502).json({
      error: "bluedart_failed",
      message: "Bluedart API returned no usable data"
    });
  }

  res.json(data);
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

/* ===============================
   🚀 START
================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Bluedart-only tracking running on", PORT)
);