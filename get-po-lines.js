require('dotenv').config();
const axios = require('axios');
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const base = process.env.SAP_BASE_URL;

async function show(docEntry) {
  const login = await axios.post(`${base}/Login`, {
    CompanyDB: process.env.SAP_COMPANY_DB,
    UserName: process.env.SAP_USERNAME,
    Password: process.env.SAP_PASSWORD,
  }, { headers: { 'Content-Type': 'application/json' }, httpsAgent: agent });
  const h = { 'Content-Type': 'application/json', 'B1S-SessionId': login.data.SessionId };
  const r = await axios.get(`${base}/ProductionOrders(${docEntry})?$select=DocumentNumber,U_PCode,ItemNo,ProductionOrderStatus,CompletedQuantity,ProductionOrderLines`, { headers: h, httpsAgent: agent });
  console.log('PO', r.data.DocumentNumber, r.data.U_PCode, 'status', r.data.ProductionOrderStatus, 'completed', r.data.CompletedQuantity);
  (r.data.ProductionOrderLines || []).forEach((l) => console.log(`  L${l.LineNumber} ${l.ItemNo} type=${l.ItemType} plan=${l.PlannedQuantity} iss=${l.IssuedQuantity} comp=${l.CompletedQuantity} wh=${l.Warehouse}`));
}

show(process.argv[2] || 141549).catch((e) => console.error(e.response?.data || e.message));
