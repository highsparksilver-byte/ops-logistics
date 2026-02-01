import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

/* ===============================
   🚀 APP INIT
================================ */
const app = express();

app.use(express.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===============================
   🔑 ENV & CONFIG
================================ */
const clean = v => v?.replace(/\r|\n|\t/g, "").trim();
const {
  CLIENT_ID, CLIENT_SECRET, LOGIN_ID,
  BD_LICENCE_KEY_TRACK, BD_LICENCE_KEY_EDD,
  SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD,
  DATABASE_URL, SHOPIFY_WEBHOOK_SECRET
} = process.env;

const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🔐 SECURITY & TOKENS
================================ */
function verifyShopify(req) {
  const secret = clean(SHOPIFY_WEBHOOK_SECRET);
  if (!secret) { console.error("⚠️ No Secret"); return true; }
  if (!req.rawBody) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  return digest === req.headers["x-shopify-hmac-sha256"];
}

let bdJwt, bdJwtAt = 0;
let srJwt, srJwtAt = 0;

async function getBluedartJwt() {
  if (bdJwt && Date.now() - bdJwtAt < 23*60*60*1000) return bdJwt;
  const r = await axios.get("https://apigateway.bluedart.com/in/transportation/token/v1/login", { 
    headers: { ClientID: clean(CLIENT_ID), clientSecret: clean(CLIENT_SECRET) } 
  });
  bdJwt = r.data.JWTToken;
  bdJwtAt = Date.now();
  return bdJwt;
}
async function getShiprocketJwt() {
  if (srJwt && Date.now() - srJwtAt < 7*24*60*60*1000) return srJwt;
  const r = await axios.post("https://apiv2.shiprocket.in/v1/external/auth/login", { 
    email: clean(SHIPROCKET_EMAIL), password: clean(SHIPROCKET_PASSWORD) 
  });
  srJwt = r.data.token;
  srJwtAt = Date.now();
  return srJwt;
}

/* ===============================
   📦 TRACKING HELPERS
================================ */
function getStatusType(s="") {
  s = s.toUpperCase();
  if (s.includes("DELIVERED")) return "DL";
  if (s.includes("RTO") || s.includes("RETURN")) return "RT";
  if (s.includes("OUT FOR")) return "OF";
  return "UD";
}

async function trackBluedart(awb) {
  try {
    const r = await axios.get("https://api.bluedart.com/servlet/RoutingServlet", {
      params: { handler: "tnt", action: "custawbquery", loginid: clean(LOGIN_ID), awb: "awb", numbers: awb, format: "xml", lickey: clean(BD_LICENCE_KEY_TRACK), verno: 1, scan: 1 },
      responseType: "text"
    });
    if (r.data.includes("<html")) return null;
    const p = await xml2js.parseStringPromise(r.data, { explicitArray:false });
    const s = p?.ShipmentData?.Shipment;
    if (!s) return null;
    
    const rawScans = Array.isArray(s.Scans?.ScanDetail) ? s.Scans.ScanDetail : [s.Scans?.ScanDetail || null];
    const history = rawScans.filter(Boolean).map(scan => ({
        status: scan.Scan,
        date: `${scan.ScanDate} ${scan.ScanTime}`,
        location: scan.ScannedLocation,
        completed: true
    }));

    return {
      source: "bluedart", status: s.Status, statusType: getStatusType(s.Status),
      delivered: getStatusType(s.Status)==="DL",
      edd: s.ExpectedDateDelivery || null,
      history: history
    };
  } catch { return null; }
}

async function trackShiprocket(awb) {
  try {
    const t = await getShiprocketJwt();
    const r = await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${t}` } });
    const td = r.data?.tracking_data;
    if (!td) return null;

    const rawScans = td.shipment_track_activities || [];
    const history = rawScans.map(scan => ({
        status: scan.activity,
        date: scan.date,
        location: scan.location,
        completed: true
    }));

    return {
      source: "shiprocket", status: td.current_status, statusType: getStatusType(td.current_status),
      delivered: getStatusType(td.current_status)==="DL",
      edd: td.etd || null,
      history: history
    };
  } catch { return null; }
}

/* ===============================
   🔍 CUSTOMER LOOKUP (PHONE ONLY - SECURE)
================================ */
app.post("/track/customer", async (req, res) => {
  const { phone } = req.body;
  
  // Strict sanitization: Allow only numbers
  const cleanInput = phone?.replace(/[^0-9]/g, "").trim(); 
  
  // Security Check: Must be at least 10 digits to be a valid phone query
  if (!cleanInput || cleanInput.length < 10) {
    return res.status(400).json({ error: "Please enter a valid 10-digit phone number" });
  }

  try {
    const { rows } = await pool.query(`
      SELECT o.order_number, o.financial_status, o.fulfillment_status, o.payment_gateway_names,
             s.awb, s.courier_source, o.created_at
      FROM orders_ops o
      LEFT JOIN shipments_ops s ON s.order_id = o.id
      WHERE o.customer_phone LIKE $1 
      ORDER BY o.created_at DESC
      LIMIT 5
    `, [`%${cleanInput.slice(-10)}`]); // Matches last 10 digits only

    if (rows.length === 0) return res.json({ orders: [] });

    const ordersWithTracking = await Promise.all(rows.map(async (row) => {
      let tracking = null;
      let history = [{ status: "Ordered", date: new Date(row.created_at).toDateString(), completed: true }];

      if (row.awb) {
         history.push({ status: "Dispatched", date: "Processing", completed: true });
         if (row.courier_source === "bluedart") tracking = await trackBluedart(row.awb);
         else if (row.courier_source === "shiprocket") tracking = await trackShiprocket(row.awb);
         
         if (tracking && tracking.history) history = [...history, ...tracking.history];
      }

      return {
        shopify_order_name: row.order_number,
        awb: row.awb || null,
        courier: row.courier_source || null,
        fulfillment_status: row.fulfillment_status,
        delivered: tracking?.delivered || false,
        edd: tracking?.edd || null,
        last_known_status: tracking?.status || "Order Placed",
        tracking_history: history
      };
    }));

    res.json({ orders: ordersWithTracking });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server Error" });
  }
});

/* ===============================
   🧾 WEBHOOKS
================================ */
app.post("/webhooks/orders_paid", async (req,res) => {
  console.log("🔔 Webhook: orders_paid");
  res.sendStatus(200);
  if (!verifyShopify(req)) return;

  const o = req.body;
  const email = o.email || o.customer?.email || o.contact_email;
  const phone = o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || "";
  const trueDate = o.created_at || new Date().toISOString();

  try {
    await pool.query(`
      INSERT INTO orders_ops (
        id, order_number, financial_status, fulfillment_status, 
        total_price, payment_gateway_names, customer_email, customer_phone, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        financial_status = EXCLUDED.financial_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        payment_gateway_names = EXCLUDED.payment_gateway_names,
        customer_email = EXCLUDED.customer_email,
        customer_phone = EXCLUDED.customer_phone,
        created_at = EXCLUDED.created_at
    `, [o.id, o.name, o.financial_status, o.fulfillment_status, o.total_price, JSON.stringify(o.payment_gateway_names || []), email, phone, trueDate]);
    console.log(`✅ Saved Order ${o.name}`);
  } catch (e) { console.error("🔥 DB Error:", e.message); }
});

app.post("/webhooks/fulfillments_create", async (req,res) => {
  console.log("🔔 Webhook: fulfillments_create");
  res.sendStatus(200);
  if (!verifyShopify(req)) return;
  const f = req.body;
  const awb = f.tracking_number;
  if (!awb) return;
  const courier = f.tracking_company?.toLowerCase().includes("blue") ? "bluedart" : "shiprocket";
  try {
    await pool.query(`INSERT INTO shipments_ops (order_id, awb, courier_source) VALUES ($1,$2,$3) ON CONFLICT (awb) DO NOTHING`,[f.order_id, f.tracking_number, courier]);
    console.log(`✅ Linked AWB ${awb}`);
  } catch (e) { console.error("🔥 DB Error:", e.message); }
});

// EDD & Health Routes
async function getCity(p){try{const r=await axios.get(`https://api.postalpincode.in/pincode/${p}`);return r.data?.[0]?.PostOffice?.[0]?.District||null}catch{return null}}
async function getBluedartEDD(p){try{const j=await getBluedartJwt();const r=await axios.post("https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",{pPinCodeFrom:"411022",pPinCodeTo:p,pProductCode:"A",pSubProductCode:"P",pPudate:new Date(new Date().getTime()+(330+new Date().getTimezoneOffset())*60000).toISOString(),pPickupTime:"16:00",profile:{Api_type:"S",LicenceKey:clean(BD_LICENCE_KEY_EDD),LoginID:clean(LOGIN_ID)}},{headers:{JWTToken:j}});return r.data?.GetDomesticTransitTimeForPinCodeandProductResult?.ExpectedDateDelivery||null}catch{return null}}
async function getShiprocketEDD(p){try{const t=await getShiprocketJwt();const r=await axios.get(`https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=411022&delivery_postcode=${p}&cod=1&weight=0.5`,{headers:{Authorization:`Bearer ${t}`}});return r.data?.data?.available_courier_companies?.[0]?.etd||null}catch{return null}}
app.post("/edd",async(req,res)=>{const{pincode}=req.body;if(!/^[0-9]{6}$/.test(pincode))return res.json({edd_display:null});const c=await getCity(pincode),f=await getBluedartEDD(pincode)||await getShiprocketEDD(pincode);if(!f)return res.json({edd_display:null});res.json({edd_display:new Date(f).toLocaleDateString('en-GB',{day:'numeric',month:'short'}),city:c,badge:c&&["MUMBAI","DELHI","BANGALORE","PUNE"].some(m=>c.toUpperCase().includes(m))?"METRO_EXPRESS":"EXPRESS"})});
app.get("/health", (_,res)=>res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log("🚀 Ops Logistics running on",PORT));