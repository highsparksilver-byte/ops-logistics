import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔴 PASTE A WORKING JWT TOKEN FROM PORTAL HERE
const HARDCODED_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdWJqZWN0LXN1YmplY3QiLCJhdWQiOlsiYXVkaWVuY2UxIiwiYXVkaWVuY2UyIl0sImlzcyI6InVybjovL2FwaWdlZS1lZGdlLUpXVC1wb2xpY3ktdGVzdCIsImV4cCI6MTc2ODQwOTYwNSwiaWF0IjoxNzY4MzIzMjA1LCJqdGkiOiI5MGExZjQ2ZS00NzMzLTQ1OTAtODFjOS04YWUxZGNiYWZhZWMifQ.NIQDd34M0YDSbm5anjaEg0PXfK5Tn32Md9gguGQ5enI";

// 🔴 Blue Dart account credentials (still required)
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY = process.env.LICENCE_KEY;

console.log("Starting Blue Dart HARD JWT test server");

// 🔍 TEST ENDPOINT
app.post("/edd", async (req, res) => {
  try {
    console.log("Calling Blue Dart with hardcoded JWT");

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
          JWTToken: HARDCODED_JWT,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("❌ HARD JWT TEST FAILED", {
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
  res.send("Hardcoded JWT test server running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
