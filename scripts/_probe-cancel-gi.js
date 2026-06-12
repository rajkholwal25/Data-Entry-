require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');
const base = process.env.SAP_BASE_URL || 'https://192.168.3.6:50000/b1s/v1';
const agent = new https.Agent({ rejectUnauthorized: process.env.SAP_SSL_VERIFY !== 'false' });

(async () => {
    const login = await axios.post(`${base}/Login`, {
        CompanyDB: process.env.SAP_COMPANY_DB,
        UserName: process.env.SAP_USERNAME,
        Password: process.env.SAP_PASSWORD
    }, { httpsAgent: agent });
    const h = {
        'Content-Type': 'application/json',
        'B1S-SessionId': login.data.SessionId,
        Cookie: login.headers['set-cookie']?.join('; ')
    };

    const doc = await axios.get(`${base}/InventoryGenExits(138391)`, { headers: h, httpsAgent: agent });
    const d = doc.data;
    console.log('Doc status:', d.DocumentStatus, 'CancelStatus:', d.CancelStatus, 'DocNum:', d.DocNum);
    console.log('Comments:', d.Comments);
    console.log('Lines:', JSON.stringify((d.DocumentLines || []).slice(0, 2), null, 2));

    const attempts = [
        ['/InventoryGenExits(138391)/Cancel', {}],
        ['/InventoryGenExitsService_Cancel', { Document: { DocEntry: 138391 } }],
        ['/InventoryGenExitsService_Cancel', { DocEntry: 138391 }]
    ];
    for (const [path, body] of attempts) {
        try {
            await axios.post(`${base}${path}`, body, { headers: h, httpsAgent: agent });
            console.log('OK', path);
        } catch (e) {
            console.log('FAIL', path, e.response?.data?.error?.message?.value || e.message);
        }
    }

    const po = await axios.get(`${base}/ProductionOrders?$filter=DocumentNumber eq 749&$top=1`, { headers: h, httpsAgent: agent });
    const ae = po.data.value[0].AbsoluteEntry;
    const full = await axios.get(`${base}/ProductionOrders(${ae})?$select=ProductionOrderLines`, { headers: h, httpsAgent: agent });
    for (const l of full.data.ProductionOrderLines || []) {
        if (l.PlannedQuantity > 0 || l.IssuedQuantity > 0) {
            console.log('PO line', l.LineNumber, l.ItemNo, 'issued', l.IssuedQuantity);
        }
    }
})().catch((e) => console.error(JSON.stringify(e.response?.data || e.message)));
