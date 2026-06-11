/**
 * TEST helper: cancel SAP receipt-from-production docs for a PO (resets CompletedQuantity).
 * Usage: node scripts/reset-po-sap-completion.js 738 739
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');

const SAP_BASE_URL = process.env.SAP_BASE_URL || 'https://192.168.3.6:50000/b1s/v1';
const sapHttpsAgent = new https.Agent({ rejectUnauthorized: process.env.SAP_SSL_VERIFY !== 'false' });

let session = null;

async function login() {
    const res = await axios.post(
        `${SAP_BASE_URL}/Login`,
        {
            CompanyDB: process.env.SAP_COMPANY_DB,
            UserName: process.env.SAP_USERNAME,
            Password: process.env.SAP_PASSWORD
        },
        { httpsAgent: sapHttpsAgent }
    );
    session = {
        sessionId: res.data.SessionId,
        cookie: res.headers['set-cookie']?.join('; ')
    };
}

function headers() {
    const h = { 'Content-Type': 'application/json', 'B1S-SessionId': session.sessionId };
    if (session.cookie) h.Cookie = session.cookie;
    return h;
}

async function sapGet(path) {
    const res = await axios.get(`${SAP_BASE_URL}${path}`, { headers: headers(), httpsAgent: sapHttpsAgent });
    return res.data;
}

async function sapPost(path, body) {
    const res = await axios.post(`${SAP_BASE_URL}${path}`, body || {}, { headers: headers(), httpsAgent: sapHttpsAgent });
    return res.data;
}

async function getAbsoluteEntry(docNumber) {
    const po = await sapGet(`/ProductionOrders?$select=AbsoluteEntry,DocumentNumber,CompletedQuantity&$filter=DocumentNumber eq ${docNumber}&$top=1`);
    const row = po?.value?.[0];
    if (!row) throw new Error(`PO ${docNumber} not found`);
    return row;
}

async function findCompletionReceipts(absoluteEntry, docNumber) {
    const entries = [];
    try {
        const filter = encodeURIComponent(`contains(Comments, '${docNumber}')`);
        const data = await sapGet(`/InventoryGenEntries?$select=DocEntry,DocNum,Comments,DocumentLines&$filter=${filter}&$orderby=DocEntry desc&$top=30`);
        for (const doc of data?.value || []) {
            const linked = (doc.DocumentLines || []).some((l) =>
                l.BaseEntry === absoluteEntry && l.BaseType === 202
            );
            if (linked) entries.push(doc);
        }
    } catch (e) {
        console.warn('Comments filter failed:', e.response?.data?.error?.message?.value || e.message);
    }
    return entries;
}

async function cancelReceipt(docEntry) {
    try {
        await sapPost(`/InventoryGenEntries(${docEntry})/Cancel`);
        return { docEntry, success: true };
    } catch (e) {
        const msg = e.response?.data?.error?.message?.value || e.message;
        return { docEntry, success: false, error: msg };
    }
}

async function resetPO(docNumber) {
    console.log(`\n=== PO ${docNumber} ===`);
    const po = await getAbsoluteEntry(docNumber);
    console.log(`AbsoluteEntry: ${po.AbsoluteEntry}, CompletedQuantity before: ${po.CompletedQuantity}`);

    const receipts = await findCompletionReceipts(po.AbsoluteEntry, docNumber);
    console.log(`Found ${receipts.length} receipt(s):`, receipts.map((r) => r.DocEntry).join(', ') || 'none');

    for (const r of receipts) {
        const result = await cancelReceipt(r.DocEntry);
        console.log(result.success ? `  Cancelled DocEntry ${r.DocEntry}` : `  Failed DocEntry ${r.DocEntry}: ${result.error}`);
    }

    const after = await getAbsoluteEntry(docNumber);
    console.log(`CompletedQuantity after: ${after.CompletedQuantity}`);
}

(async () => {
    const pos = process.argv.slice(2);
    if (!pos.length) {
        console.error('Usage: node scripts/reset-po-sap-completion.js <poNum> [...]');
        process.exit(1);
    }
    await login();
    for (const po of pos) {
        await resetPO(po);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
