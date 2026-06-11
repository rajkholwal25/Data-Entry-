require('dotenv').config();
const axios = require('axios');
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const base = process.env.SAP_BASE_URL;

async function main() {
  const login = await axios.post(`${base}/Login`, {
    CompanyDB: process.env.SAP_COMPANY_DB,
    UserName: process.env.SAP_USERNAME,
    Password: process.env.SAP_PASSWORD,
  }, { headers: { 'Content-Type': 'application/json' }, httpsAgent: agent });
  const h = { 'Content-Type': 'application/json', 'B1S-SessionId': login.data.SessionId };

  const r = await axios.get(
    `${base}/ProductionOrders(141550)?$select=AbsoluteEntry,DocumentNumber,U_PCode,ItemNo,ProductionOrderStatus,PlannedQuantity,ProductionOrderLines`,
    { headers: h, httpsAgent: agent }
  );
  console.log('Status:', r.data.ProductionOrderStatus, '| Header:', r.data.ItemNo);
  (r.data.ProductionOrderLines || []).forEach((l) => {
    console.log({
      line: l.LineNumber,
      item: l.ItemNo,
      type: l.ItemType,
      planned: l.PlannedQuantity,
      issued: l.IssuedQuantity,
      completed: l.CompletedQuantity,
      warehouse: l.Warehouse,
    });
  });
}

main().catch((e) => console.error(e.response?.data || e.message));
