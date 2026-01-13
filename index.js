const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// 🔐 SAFE: secrets come from Render, not code
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENSE_KEY = process.env.LICENSE_KEY;

let cachedToken = null;
let tokenExpiry = null;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const res = await axios.post(
    "https://apigateway-sandbox.bluedart.com/in/transportation/auth/v1/login",
    { clientId: CLIENT_ID },
    { headers: { clientSecret: CLIENT_SECRET } }
  );

  cachedToken = res.data.jwtToken;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

app.post("/edd", async (req, res) => {
  try {
    const toPincode = req.body.pincode || "411022";
    const token = await getToken();

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    const response = await axios.post(
      "https://apigateway-sandbox.bluedart.com/in/transportation/transittime/v1/getdomestictransittime",
      {
        ppinCode: "411022",
        pPinCodeTo: toPincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: today,
        pPickupTime: "1400"
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          LoginID: LOGIN_ID,
          LicenseKey: LICENSE_KEY
        }
      }
    );

    const edd =
      response.data?.DomesticTranistTimeReference?.ExpectedDateDelivery;

    res.json({ edd });
  } catch (e) {
    res.status(500).json({ error: "EDD unavailable" });
  }
});

app.listen(3000, () => console.log("Server running"));
