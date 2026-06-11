/**
 * Verify PO 738 (Embossing) in SAP and via local API.
 * Run: node test-po-738.js
 */
require('dotenv').config();
const axios = require('axios');
const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });
const base = process.env.SAP_BASE_URL;
const API = 'http://localhost:5001';

async function sapLogin() {
  const login = await axios.post(
    `${base}/Login`,
    {
      CompanyDB: process.env.SAP_COMPANY_DB,
      UserName: process.env.SAP_USERNAME,
      Password: process.env.SAP_PASSWORD,
    },
    { headers: { 'Content-Type': 'application/json' }, httpsAgent: agent }
  );
  const headers = {
    'Content-Type': 'application/json',
    'B1S-SessionId': login.data.SessionId,
  };
  if (login.headers['set-cookie']) headers.Cookie = login.headers['set-cookie'].join('; ');
  return headers;
}

async function main() {
  const doc = '738';
  console.log('=== PO 738 Embossing Test ===\n');

  // 1) Local API health
  try {
    const health = await axios.get(`${API}/api/health`, { timeout: 5000 });
    console.log('Server health:', health.data);
  } catch (e) {
    console.error('Server not running on', API, '- start with: npm start');
    process.exit(1);
  }

  // 2) Load PO via app API (embossing machine)
  const poUrl = `${API}/api/production-order/${doc}?machine=embossing-1&process=Embossing&materialOnly=1&enrich=0`;
  console.log('\nFetching via app API:', poUrl);
  const poResp = await axios.get(poUrl, { timeout: 60000 });
  const po = poResp.data;
  console.log('\n--- App API PO Summary ---');
  console.log('Document:', po.documentNumber || po.po_num || doc);
  console.log('AbsoluteEntry:', po.absoluteEntry || po.absolute_entry);
  console.log('U_PCode:', po.uPCode || po.u_pcode);
  console.log('U_JobEnt:', po.uJobEnt || po.u_job_ent);
  console.log('Item:', po.itemNo || po.item_no);
  console.log('Description:', po.jobName || po.product_description);
  console.log('Planned Qty:', po.plannedQuantity || po.planned_qty);
  console.log('Completed Qty:', po.completedQuantity || po.completed_qty);
  console.log('Status:', po.productionOrderStatus || po.status);
  if (po.materialLines?.length) {
    console.log('\nMaterial lines:');
    po.materialLines.forEach((m) => {
      console.log(`  - ${m.itemNo || m.item_code}: planned=${m.plannedQty || m.planned_qty}, issued=${m.issuedQty || m.issued_qty}`);
    });
  }

  // 3) Direct SAP check
  const headers = await sapLogin();
  const sap = await axios.get(
    `${base}/ProductionOrders?$select=AbsoluteEntry,DocumentNumber,Series,U_PCode,U_JobEnt,ItemNo,ProductDescription,PlannedQuantity,CompletedQuantity,ProductionOrderStatus,ProductionOrderLines&$filter=DocumentNumber eq ${doc} and ProductionOrderStatus ne 'boposCancelled' and ProductionOrderStatus ne 'boposClosed'&$top=10`,
    { headers, httpsAgent: agent, timeout: 60000 }
  );
  const rows = sap.data.value || [];
  if (!rows.length) {
    console.error('\nSAP: PO 738 not found or closed/cancelled');
    process.exit(1);
  }
  const best = rows.sort((a, b) => (b.Series || 0) - (a.Series || 0))[0];
  console.log('\n--- SAP Direct ---');
  console.log('Series:', best.Series, '| Status:', best.ProductionOrderStatus);
  console.log('U_PCode:', best.U_PCode, '| U_JobEnt:', best.U_JobEnt);
  console.log('Lines:', (best.ProductionOrderLines || []).map((l) => ({
    Line: l.LineNumber,
    Item: l.ItemNo,
    Type: l.ItemType,
    Planned: l.PlannedQuantity,
    Issued: l.IssuedQuantity,
    Warehouse: l.Warehouse,
  })));

  const uPCode = String(best.U_PCode || '').toUpperCase();
  if (!uPCode.includes('EMB')) {
    console.warn('\n⚠️ Warning: U_PCode is not EMB — this PO may not be embossing');
  } else {
    console.log('\n✅ PO 738 is embossing (U_PCode contains EMB)');
  }

  // 4) BOM chain
  const jobEnt = best.U_JobEnt;
  if (jobEnt) {
    const chain = await axios.get(
      `${base}/ProductionOrders?$select=DocumentNumber,U_PCode,ProductionOrderStatus,PlannedQuantity&$filter=U_JobEnt eq '${jobEnt}' and ProductionOrderStatus ne 'boposClosed' and ProductionOrderStatus ne 'boposCancelled'&$orderby=DocumentNumber`,
      { headers, httpsAgent: agent, timeout: 60000 }
    );
    console.log(`\n--- BOM chain (U_JobEnt ${jobEnt}) ---`);
    (chain.data.value || []).forEach((p) => {
      console.log(`  PO ${p.DocumentNumber} | ${p.U_PCode} | ${p.ProductionOrderStatus} | ${p.PlannedQuantity} KGS`);
    });
  }

  console.log('\n--- Ready for UI test ---');
  console.log('Open: http://localhost:5001/data-entry.html?machine=embossing-1');
  console.log('Search PO: 738');
  console.log('Operator: Vipin / Vivek / Parveen');
}

main().catch((e) => {
  const msg = e.response?.data || e.message;
  console.error('ERROR:', typeof msg === 'object' ? JSON.stringify(msg, null, 2) : msg);
  process.exit(1);
});
