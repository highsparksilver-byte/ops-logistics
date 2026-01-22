import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   CONFIG
========================= */
const CLIENT_ID = process.env.BLUEDART_CLIENT_ID;
const CLIENT_SECRET = process.env.BLUEDART_CLIENT_SECRET;
const LOGIN_ID = process.env.BLUEDART_LOGIN_ID;
const LICENCE_KEY = process.env.BLUEDART_LICENCE_KEY;

const DEFAULT_FROM_PINCODE = "411022";

/* =========================
   JWT GENERATION
========================= */
async function generateJWT() {
  const response = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      }
    }
  );

  return response.data.JWTToken;
}

/* =========================
   EDD ENDPOINT
========================= */
app.post("/edd", async (req, res) => {
  try {
    // ✅ SUPPORT BOTH FORMATS
    const toPincode =
      req.body.pincode || req.body.to_pincode || null;

    const fromPincode =
      req.body.from_pincode || DEFAULT_FROM_PINCODE;

    if (!toPincode) {
      return res.status(400).json({ error: "Missing pincode" });
    }

    const jwtToken = await generateJWT();

    const payload = {
      pPinCodeFrom: fromPincode,
      pPinCodeTo: toPincode,
      pProductCode: "A",
      pSubProductCode: "P",
      pPudate: `/Date(${Date.now()})/`,
      pPickupTime: "16:00",
      profile: {
        Api_type: "S",
        LicenceKey: LICENCE_KEY,
        LoginID: LOGIN_ID
      }
    };

    const bdResponse = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          JWTToken: jwtToken
        }
      }
    );

    const result =
      bdResponse.data?.GetDomesticTransitTimeForPinCodeandProductResult;

    if (!result || result.IsError) {
      return res.status(500).json({ error: "EDD unavailable" });
    }

    // ✅ SAME RESPONSE FORMAT AS BEFORE
    return res.json({
      edd: result.ExpectedDateDelivery
    });
  } catch (err) {
    console.error("EDD ERROR:", err.response?.data || err.message);
    return res.status(500).json({ error: "EDD unavailable" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
