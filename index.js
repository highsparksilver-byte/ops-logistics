import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔐 Environment variables (Render)
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY = process.env.LICENCE_KEY;

// Startup check
console.log("🚀 Starting Blue Dart EDD server");
console.log("Env check:", {
  CLIENT_ID: !!CLIENT_ID,
  CLIENT_SECRET: !!CLIENT_SECRET,
  LOGIN_ID: !!LOGIN_ID,
  LICENCE_KEY: !!LICENCE_KEY
});

// ─────────────────────────────────────────────
// JWT handling (dynamic + cached)
// ─────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getJwtToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    console.log("🔁 Using cached JWT");
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
    throw new Error("JWTToken missing in auth response");
  }

  cachedToken = res.data.JWTToken;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours

  console.log("✅ JWT generated and cached");
  return cachedToken;
}

// Legacy date format required by /transit/v1
function legacyDateNow() {
  return `/Date(${Date.now()})/`;
}

// ─────────────────────────────────────────────
// EDD endpoint (what Shopify will call)
// ─────────────────────────────────────────────
app.post("/edd", async (req, res) => {
  try {
    console.log("📦 /edd called with body:", req.body);

    const { pincode } = req.body;

    if (!pincode) {
      return res.status(400).json({ error: "Pincode required" });
    }

    const jwt = await getJwtToken();

    console.log("🚚 Calling Blue Dart legacy transit API");

    const bdRes = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: pincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(), // 🔴 legacy format
        pPickupTime: "16:00",     // 🔴 legacy format
        profile: {
          Api_type: "S",          // 🔴 legacy API type
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          JWTToken: jwt,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const result =
      bdRes.data?.GetDomesticTransitTimeForPinCodeandProductResult;

    console.log("✅ Blue Dart raw response:", result);

    res.json({
      edd: result?.ExpectedDateDelivery,
      raw: result
    });
  } catch (error) {
    console.error("❌ EDD ERROR FULL", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });

    res.status(500).json({
      error: "EDD unavailable",
      details: error.response?.data || error.message
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Blue Dart EDD server running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server started on port", PORT);
});
