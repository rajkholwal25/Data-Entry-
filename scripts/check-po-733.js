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

    for (const doc of [732, 733]) {
        const rows = (await get(`/ProductionOrders?$filter=DocumentNumber eq ${doc}&$top=3`)).value || [];
        const po = rows[0];
        if (!po) { console.log('PO', doc, 'not found'); continue; }
        console.log(`\nPO ${po.DocumentNumber} ${po.U_PCode} FG=${po.ItemNo}`);
        for (const l of po.ProductionOrderLines || []) {
            if ((l.PlannedQuantity || 0) <= 0) continue;
            const item = await get(`/Items('${encodeURIComponent(l.ItemNo)}')?$select=ItemCode,ManageBatchNumbers,InventoryUOM`).catch(() => ({}));
            console.log(` L${l.LineNumber} ${l.ItemNo} planned=${l.PlannedQuantity} issued=${l.IssuedQuantity} wh=${l.Warehouse} batch=${item.ManageBatchNumbers || '?'}`);
        }
    }
})().catch((e) => console.error(e.response?.data || e.message));
