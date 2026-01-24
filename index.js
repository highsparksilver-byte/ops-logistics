import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 CORS FIX (REQUIRED FOR SHOPIFY)
================================================
*/
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, JWTToken");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

/*
================================================
 Environment sanitiser (CRITICAL)
================================================
*/
function cleanEnv(value) {
  if (!value) return value;
  return value.replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "").trim();
}

/*
================================================
 Credentials from environment
================================================
*/
const CLIENT_ID = cleanEnv(process.env.CLIENT_ID);
const CLIENT_SECRET = cleanEnv(process.env.CLIENT_SECRET);
const LOGIN_ID = cleanEnv(process.env.LOGIN_ID);
const LICENCE_KEY = cleanEnv(process.env.LICENCE_KEY);

console.log("Blue Dart EDD starting");

/*
================================================
 JWT cache
================================================
*/
let cachedJwt = null;
let jwtFetchedAt = 0;

async function getJwt() {
  if (cachedJwt && Date.now() - jwtFetchedAt < 23 * 60 * 60 * 1000) {
    return cachedJwt;
  }

  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      }
    }
  );

  if (!res.data?.JWTToken) {
    throw new Error("JWTToken not returned by authentication API");
  }

  cachedJwt = res.data.JWTToken;
  jwtFetchedAt = Date.now();
  return cachedJwt;
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
 Health check
================================================
*/
app.get("/health", (_, res) => {
  res.send("OK");
});

/*
================================================
 EDD ENDPOINT (WORKING)
================================================
*/
app.post("/edd", async (req, res) => {
  try {
    const destinationPincode = req.body.pincode || "400099";
    const jwt = await getJwt();

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
        }
      }
    );

    res.json({
      edd:
        bdRes.data?.GetDomesticTransitTimeForPinCodeandProductResult
          ?.ExpectedDateDelivery
    });

  } catch (error) {
    res.status(500).json({
      error: "EDD unavailable",
      details: error.response?.data || error.message
    });
  }
});

/*
================================================
 TRACKING ENDPOINT (BLUEDART)
================================================
*/
app.post("/track", async (req, res) => {
  try {
    const { awb } = req.body;

    if (!awb) {
      return res.status(400).json({ error: "AWB number required" });
    }

    const jwt = await getJwt();

    const bdRes = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/tracking/v1/ShipmentStatus",
      {
        Request: { AWBNo: awb },
        Profile: {
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

    // TEMPORARY: return raw response so we see exact structure
    return res.json({
      bluedart_raw_response: bdRes.data
    });

  } catch (error) {
    return res.status(500).json({
      error: "Tracking unavailable",
      details: error.response?.data || error.message
    });
  }
});

/*
================================================
 Root
================================================
*/
app.get("/", (_, res) => {
  res.send("Blue Dart EDD server running");
});

/*
================================================
 Keep Render warm
================================================
*/
const SELF_URL = "https://bluedart-edd.onrender.com/health";

setInterval(() => {
  fetch(SELF_URL).catch(() => {});
}, 5 * 60 * 1000);

/*
================================================
 Start server
================================================
*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

