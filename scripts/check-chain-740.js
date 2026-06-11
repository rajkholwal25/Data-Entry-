require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');
const base = process.env.SAP_BASE_URL;
const agent = new https.Agent({ rejectUnauthorized: false });

(async () => {
    const login = await axios.post(`${base}/Login`, {
        CompanyDB: process.env.SAP_COMPANY_DB,
        UserName: process.env.SAP_USERNAME,
        Password: process.env.SAP_PASSWORD
    }, { httpsAgent: agent });
    const h = { 'B1S-SessionId': login.data.SessionId, Cookie: login.headers['set-cookie']?.join(';') };
    const get = async (p) => (await axios.get(`${base}${p}`, { headers: h, httpsAgent: agent })).data;

    const po740 = await get("/ProductionOrders?$filter=DocumentNumber eq 740&$select=AbsoluteEntry,DocumentNumber,U_PCode,U_JobEnt,ItemNo,CompletedQuantity&$top=5");
    const row = po740.value?.[0];
    if (!row) { console.log('740 not found'); return; }
    console.log('740:', row.DocumentNumber, 'U_PCode', row.U_PCode, 'Item', row.ItemNo, 'Done', row.CompletedQuantity, 'JobEnt', row.U_JobEnt);

    const jobEnt = row.U_JobEnt;
    const chain = await get(`/ProductionOrders?$filter=U_JobEnt eq '${jobEnt}'&$select=DocumentNumber,U_PCode,ItemNo,ProductionOrderStatus,ProductionOrderLines&$top=30`);
    for (const p of chain.value || []) {
        console.log(`\nPO ${p.DocumentNumber} ${p.U_PCode} FG=${p.ItemNo} status=${p.ProductionOrderStatus}`);
        for (const l of p.ProductionOrderLines || []) {
            const t = l.ItemType;
            if (t === 'pit_Item' || t === 4 || String(t) === '4') {
                console.log(`  L${l.LineNumber} ${l.ItemNo} planned=${l.PlannedQuantity} issued=${l.IssuedQuantity} wh=${l.Warehouse || l.WarehouseCode}`);
            }
        }
    }
})().catch((e) => console.error(e.response?.data || e.message));
