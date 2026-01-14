import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 🧪 CLIENT-ID ONLY JWT EXPERIMENT
================================================
*/

// 🔑 ClientID ONLY (no clientSecret anywhere)
const CLIENT_ID = "e8t8RyuHO1rNqZ6GCBsjRoqeokRoCefb";

// 🔑 Hard-coded account credentials (same app)
const LOGIN_ID = "PNQ90609";
const LICENCE_KEY = "oupkkkosmeqmuqqfsph8korrp8krmouj";

// Cache JWT if one is returned
let cachedJwt = null;
let jwtFetchedAt = 0;

/*
================================================
 Attempt JWT generation with ONLY ClientID
================================================
*/
async function getJwtClientIdOnly() {
  // reuse token for 1 hour if received
  if (cachedJwt && Date.now() - jwtFetchedAt < 60 * 60 * 1000) {
    return cachedJwt;
  }

  console.log("🔐 Trying JWT generation with ClientID ONLY");

  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID
      },
      validateStatus: () => true // capture all responses
    }
  );

  console.log("🔎 Auth HTTP status:", res.status);
  console.log("🔎 Auth response body:", res.data);

  if (res.data && res.data.JWTToken) {
    cachedJwt = res.data.JWTToken;
    jwtFetchedAt = Date.now();
    console.log("✅ JWT received via ClientID-only");
    console.log("JWT length:", cachedJwt.length);
    return cachedJwt;
  }

  throw new Error("JWT NOT returned from ClientID-only auth");
}

/*
================================================
 Helpers
================================================
*/
function legacyDateNow() {
  return `/Date(${Date.now()})/`;
}

/*
================================================
 EDD ENDPOINT (uses ClientID-only JWT)
================================================
*/
app.post("/edd", async (req, res) => {
  try {
    const destinationPincode = req.body.pincode || "400099";

    const jwt = await getJwtClientIdOnly();

    const bdRes = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: destinationPincode,
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
        },
        validateStatus: () => true
      }
    );

    res.json({
      experiment: "client-id-only",
      transitHttpStatus: bdRes.status,
      transitResponse: bdRes.data
    });

  } catch (error) {
    res.status(500).json({
      experiment: "client-id-only",
      error: error.message
    });
  }
});

/*
================================================
 Health Check
================================================
*/
app.get("/", (_, res) => {
  res.send("Blue Dart ClientID-only JWT experiment running");
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
