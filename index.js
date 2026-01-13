import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/*
  🔴 HARD-CODE EVERYTHING BELOW
  🔴 FOR TESTING ONLY
*/

// 1️⃣ Paste JWTToken that WORKED in Portal
const JWT_TOKEN =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdWJqZWN0LXN1YmplY3QiLCJhdWQiOlsiYXVkaWVuY2UxIiwiYXVkaWVuY2UyIl0sImlzcyI6InVybjovL2FwaWdlZS1lZGdlLUpXVC1wb2xpY3ktdGVzdCIsImV4cCI6MTc2ODQwOTYwNSwiaWF0IjoxNzY4MzIzMjA1LCJqdGkiOiI5MGExZjQ2ZS00NzMzLTQ1OTAtODFjOS04YWUxZGNiYWZhZWMifQ.NIQDd34M0YDSbm5anjaEg0PXfK5Tn32Md9gguGQ5enI";

// 2️⃣ Paste your actual Blue Dart credentials
const LOGIN_ID = "PNQ90609";
const LICENCE_KEY = "oupkkkosmeqmuqqfsph8korrp8krmouj";

console.log("🚨 HARD-CODED TEST MODE ENABLED");

// 🔍 TEST ENDPOINT
app.post("/edd", async (req, res) => {
  try {
    console.log("📦 Calling Blue Dart with hard-coded credentials");

    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit-time/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: "400099",
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: "20260116",
        pPickupTime: "1600",
        profile: {
          Api_type: "T",
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

    console.log("✅ Blue Dart responded");

    res.json(response.data);
  } catch (error) {
    console.error("❌ HARD TEST FAILED", {
      status: error.response?.status,
      data: error.response?.data
    });

    res.status(500).json({
      error: "FAILED",
      status: error.response?.status,
      details: error.response?.data || error.message
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Hard-coded Blue Dart test server running");
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
