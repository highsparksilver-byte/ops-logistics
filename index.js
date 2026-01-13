import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 🔴 MANUAL JWT MODE (STABLE & WORKING)
================================================
*/

// 🔑 Paste FRESH JWT from Blue Dart Portal (valid ~24 hrs)
const JWT_TOKEN =
"PASTE_FRESH_JWT_FROM_PORTAL_HERE";

// 🔐 Read from environment AND TRIM (CRITICAL)
const LOGIN_ID = process.env.LOGIN_ID?.trim();
const LICENCE_KEY = process.env.LICENCE_KEY?.trim();

// Startup sanity logs
console.log("🚀 Blue Dart EDD server starting");
console.log("Env check:", {
  LOGIN_ID: !!LOGIN_ID,
  LICENCE_KEY: !!LICENCE_KEY,
  JWT_LENGTH: JWT_TOKEN.length
});

if (!LOGIN_ID || !LICENCE_KEY) {
  console.error("❌ LOGIN_ID or LICENCE_KEY missing or empty");
}

/*
================================================
 Helpers
================================================
*/

// Legacy date format REQUIRED by legacy Transit API
function legacyDateNow() {
  return `/Date(${Date.now()})/`;
}

/*
================================================
 EDD ENDPOINT (PROVEN WORKING)
================================================
*/
app.post("/edd", async (req, res) => {
  try {
    const { pincode } = req.body;

    // default if not sent (safe for now)
    const destinationPincode = pincode || "400099";

    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",           // origin
        pPinCodeTo: destinationPincode,  // destination
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(),         // legacy format
        pPickupTime: "16:00",             // legacy format
        profile: {
          Api_type: "S",                  // legacy API type
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          JWTToken: JWT_TOKEN,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    const result =
      response.data?.GetDomesticTransitTimeForPinCodeandProductResult;

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
      error: "EDD unavailable",
      details: error.response?.data || error.message
    });
  }
});

/*
================================================
 Health Check
================================================
*/
app.get("/", (req, res) => {
  res.send("Blue Dart EDD server running (manual JWT + env trim)");
});

/*
================================================
 Start Server
================================================
*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
