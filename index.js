import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 🔴 MANUAL JWT MODE (STABLE)
================================================
*/

// 🔑 PASTE JWT GENERATED FROM BLUEDART PORTAL (VALID ~24 HRS)
const JWT_TOKEN =
"PASTE_FRESH_JWT_HERE";

// 🔑 These MUST belong to SAME account/app
const LOGIN_ID = "PNQ90609";              // replace with yours
const LICENCE_KEY = "PASTE_LICENCE_KEY";  // replace with yours

/*
================================================
 Helper (legacy format REQUIRED)
================================================
*/
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
        pPinCodeFrom: "411022",     // origin
        pPinCodeTo: "400099",       // destination (can be dynamic later)
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(),   // legacy date format
        pPickupTime: "16:00",       // legacy time format
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

    res.json(response.data);

  } catch (error) {
    res.status(500).json({
      error: "FAILED",
      status: error.response?.status,
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
  res.send("Blue Dart EDD server running (manual JWT mode)");
});

/*
================================================
 Start Server
================================================
*/
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
