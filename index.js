import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 🔴 MANUAL JWT MODE (STABLE)
================================================
*/

// 🔑 JWT generated manually from Blue Dart Portal (valid ~24 hrs)
const JWT_TOKEN =
"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdWJqZWN0LXN1YmplY3QiLCJhdWQiOlsiYXVkaWVuY2UxIiwiYXVkaWVuY2UyIl0sImlzcyI6InVybjovL2FwaWdlZS1lZGdlLUpXVC1wb2xpY3ktdGVzdCIsImV4cCI6MTc2ODQwOTYwNSwiaWF0IjoxNzY4MzIzMjA1LCJqdGkiOiI5MGExZjQ2ZS00NzMzLTQ1OTAtODFjOS04YWUxZGNiYWZhZWMifQ.NIQDd34M0YDSbm5anjaEg0PXfK5Tn32Md9gguGQ5enI";

// 🔐 Sensitive account info from environment
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY = process.env.LICENCE_KEY;

// Startup sanity check
console.log("🚀 Blue Dart EDD server starting");
console.log("Env check:", {
  LOGIN_ID: !!LOGIN_ID,
  LICENCE_KEY: !!LICENCE_KEY
});

if (!LOGIN_ID || !LICENCE_KEY) {
  console.error("❌ LOGIN_ID or LICENCE_KEY missing in environment");
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
    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",     // origin pincode
        pPinCodeTo: "400099",       // destination (can be dynamic later)
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(),   // legacy format
        pPickupTime: "16:00",       // legacy format
        profile: {
          Api_type: "S",
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
  res.send("Blue Dart EDD server running (manual JWT, env creds)");
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
