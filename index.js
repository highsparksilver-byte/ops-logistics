import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 🔴 HARD-CODED CREDENTIALS (TEST ONLY)
================================================
*/

// 🔑 Blue Dart App credentials (SAME app as portal)
const CLIENT_ID = "e8t8RyuHO1rNqZ6GCBsjRoqeokRoCefb";
const CLIENT_SECRET = "J8qusC0Ra0zpDmbH";

// 🔑 Account credentials (same app/account)
const LOGIN_ID = "PNQ90609";
const LICENCE_KEY = "oupkkkosmeqmuqqfsph8korrp8krmouj";

/*
================================================
 JWT handling (dynamic, cached)
================================================
*/

let cachedJwt = null;
let jwtExpiry = 0;

async function getJwtToken() {
  // reuse token if valid
  if (cachedJwt && Date.now() < jwtExpiry) {
    return cachedJwt;
  }

  console.log("🔐 Generating new JWT");

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
    throw new Error("JWTToken not returned by Blue Dart");
  }

  cachedJwt = res.data.JWTToken;
  jwtExpiry = Date.now() + 23 * 60 * 60 * 1000; // ~23 hours

  console.log("✅ JWT generated");
  return cachedJwt;
}

/*
================================================
 Helpers
================================================
*/

// Legacy date format REQUIRED by /transit/v1
function legacyDateNow() {
  return `/Date(${Date.now()})/`;
}

/*
================================================
 EDD API (LEGACY – PROVEN WORKING)
================================================
*/

app.post("/edd", async (req, res) => {
  try {
    const jwt = await getJwtToken();

    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: "400099",
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDateNow(),
        pPickupTime: "16:00",
        profile: {
          Api_type: "S",
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

    res.json(response.data);

  } catch (error) {
    console.error("❌ ERROR", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });

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
  res.send("Blue Dart EDD server running (hard-coded JWT generation)");
});

/*
================================================
 Start Server
================================================
*/

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
