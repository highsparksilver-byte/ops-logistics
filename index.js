import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔐 Environment variables (Render)
const STATIC_JWT = process.env.BLUEDART_JWT;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY = process.env.LICENCE_KEY;

// Startup check
console.log("🚀 Starting Blue Dart EDD server (STATIC JWT MODE)");
console.log("Env check:", {
  BLUEDART_JWT: !!STATIC_JWT,
  LOGIN_ID: !!LOGIN_ID,
  LICENCE_KEY: !!LICENCE_KEY
});

if (!STATIC_JWT || !LOGIN_ID || !LICENCE_KEY) {
  console.error("❌ Missing required environment variables");
}

// Helper: legacy date format required by legacy Transit API
function legacyDateNow() {
  return `/Date(${Date.now()})/`;
}

// ─────────────────────────────────────────────
// EDD endpoint (Shopify will call this)
// ─────────────────────────────────────────────
app.post("/edd", async (req, res) => {
  try {
    const { pincode } = req.body;

    if (!pincode) {
      return res.status(400).json({ error: "Pincode required" });
    }

    console.log("📦 EDD request for pincode:", pincode);

    const bdRes = await axios.post(
      // ✅ LEGACY endpoint (this is enabled for your app)
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",   // default origin
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(), // legacy date format
        pPickupTime: "16:00",     // legacy time format
        profile: {
          Api_type: "S",          // legacy API type
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          JWTToken: STATIC_JWT,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const result =
      bdRes.data?.GetDomesticTransitTimeForPinCodeandProductResult;

    res.json({
      edd: result?.ExpectedDateDelivery
    });
  } catch (error) {
    console.error("❌ EDD ERROR", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });

    res.status(500).json({
      error: "EDD unavailable"
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Blue Dart EDD server running (static JWT)");
});

// Render dynamic port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server started on port", PORT);
});
