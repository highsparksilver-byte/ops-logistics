import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔐 Environment variables (set in Render)
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY = process.env.LICENCE_KEY;

// Startup check (visible in Render logs)
if (!CLIENT_ID || !CLIENT_SECRET || !LOGIN_ID || !LICENCE_KEY) {
  console.error("❌ Missing environment variables");
} else {
  console.log("✅ Environment variables loaded");
}

// ─────────────────────────────────────────────
// JWT handling (dynamic + cached)
// ─────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getJwtToken() {
  // Reuse token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  console.log("🔐 Generating new JWT token");

  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        Accept: "application/json"
      }
    }
  );

  if (!res.data?.JWTToken) {
    throw new Error("JWTToken not returned by auth API");
  }

  cachedToken = res.data.JWTToken;
  // JWT typically valid ~24h; refresh a bit early
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

  console.log("✅ JWT token cached");
  return cachedToken;
}

// Helper: legacy date format required by /transit/v1
function legacyDateNow() {
  return `/Date(${Date.now()})/`;
}

// ─────────────────────────────────────────────
// EDD endpoint (what Shopify will call)
// ─────────────────────────────────────────────
app.post("/edd", async (req, res) => {
  try {
    const { pincode } = req.body;

    if (!pincode) {
      return res.status(400).json({ error: "Pincode required" });
    }

    const jwt = await getJwtToken();

    const bdRes = await axios.post(
      // 🔴 LEGACY endpoint (this is the one enabled for your app)
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",      // default origin
        pPinCodeTo: pincode,         // customer pincode
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(),    // 🔴 legacy date format
        pPickupTime: "16:00",        // 🔴 legacy time format
        profile: {
          Api_type: "S",             // 🔴 legacy API type
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          JWTToken: jwt,             // 🔴 required header
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const result =
      bdRes.data?.GetDomesticTransitTimeForPinCodeandProductResult;

    const edd = result?.ExpectedDateDelivery;

    res.json({ edd });
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
  res.send("Blue Dart EDD server running");
});

// Render dynamic port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server started on port", PORT);
});
