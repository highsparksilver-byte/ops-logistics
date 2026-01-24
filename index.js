import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
================================================
 🌍 CORS FIX (REQUIRED FOR SHOPIFY)
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
 🔐 Environment sanitiser (CRITICAL)
================================================
*/
function cleanEnv(value) {
  if (!value) return value;
  return value
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .replace(/\t/g, "")
    .trim();
}

/*
================================================
 🔑 Credentials from environment
================================================
*/
const CLIENT_ID = cleanEnv(process.env.CLIENT_ID);
const CLIENT_SECRET = cleanEnv(process.env.CLIENT_SECRET);
const LOGIN_ID = cleanEnv(process.env.LOGIN_ID);
const LICENCE_KEY = cleanEnv(process.env.LICENCE_KEY);

console.log("🚀 Blue Dart EDD starting");
console.log("CLIENT_ID present:", !!CLIENT_ID);
console.log("CLIENT_SECRET present:", !!CLIENT_SECRET);
console.log("LOGIN_ID present:", !!LOGIN_ID);
console.log("LICENCE_KEY present:", !!LICENCE_KEY);

/*
================================================
 🔑 JWT cache (ClientID + Secret)
================================================
*/
let cachedJwt = null;
let jwtFetchedAt = 0;

async function getJwt() {
  if (cachedJwt && Date.now() - jwtFetchedAt < 23 * 60 * 60 * 1000) {
    return cachedJwt;
  }

  console.log("🔐 Generating new JWT");

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
 HEALTH CHECK (USED FOR KEEP-ALIVE)
================================================
*/
app.get("/health", (req, res) => {
  res.send("OK");
});

/*
================================================
 🚚 EDD ENDPOINT (UNCHANGED & WORKING)
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
 Root
================================================
*/
app.get("/", (_, res) => {
  res.send("Blue Dart EDD server running");
});

/*
================================================
 🔁 KEEP RENDER WARM (SAFE, NO SIDE EFFECTS)
================================================
*/
const SELF_URL = "https://bluedart-edd.onrender.com/health";

setInterval(() => {
  fetch(SELF_URL)
    .then(() => console.log("🔁 Keep-alive ping sent"))
    .catch(() => console.log("⚠️ Keep-alive ping failed"));
}, 5 * 60 * 1000); // every 5 minutes

/*
================================================
 🚀 Start server
================================================
*/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
