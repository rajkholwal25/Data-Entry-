/**
 * Reset PO issue data for re-testing material issue flow.
 * - Cancels SAP goods issues (InventoryGenExits) linked to the PO
 * - Clears local material_issue_log + production_records
 *
 * Usage: node scripts/reset-po-issue-data.js 749
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');
const { pool, deleteRecordsByPO } = require('../db-config');

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

async function getPO(docNumber) {
    const list = await sapGet(`/ProductionOrders?$filter=DocumentNumber eq ${docNumber}&$top=1`);
    const row = list?.value?.[0];
    if (!row) throw new Error(`PO ${docNumber} not found in SAP`);
    return sapGet(`/ProductionOrders(${row.AbsoluteEntry})?$select=AbsoluteEntry,DocumentNumber,U_PCode,ItemNo,CompletedQuantity,ProductionOrderLines`);
}

async function findLinkedGoodsIssues(absoluteEntry, docNumber) {
    const enc = (s) => encodeURIComponent(s);
    let docs = [];
    try {
        const data = await sapGet(
            `/InventoryGenExits?$select=DocEntry,DocNum,Comments,DocumentLines&$filter=${enc(`contains(Comments,'${docNumber}')`)}&$orderby=DocEntry desc&$top=30`
        );
        docs = data?.value || [];
    } catch (e) {
        console.warn('Comment filter failed:', e.response?.data?.error?.message?.value || e.message);
    }

    let linked = docs.filter((d) =>
        (d.DocumentLines || []).some((l) => Number(l.BaseEntry) === Number(absoluteEntry))
    );

    if (linked.length === 0) {
        try {
            const data = await sapGet(
                `/InventoryGenExits?$select=DocEntry,DocumentLines&$orderby=DocEntry desc&$top=400`
            );
            linked = (data?.value || []).filter((d) =>
                (d.DocumentLines || []).some((l) => Number(l.BaseEntry) === Number(absoluteEntry))
            );
        } catch (e) {
            console.warn('Recent scan failed:', e.response?.data?.error?.message?.value || e.message);
        }
    }

    return linked;
}

async function cancelGoodsIssue(docEntry) {
    try {
        await sapPost(`/InventoryGenExits(${docEntry})/Cancel`);
        return { docEntry, success: true };
    } catch (e) {
        return { docEntry, success: false, error: e.response?.data?.error?.message?.value || e.message };
    }
}

async function clearLocal(poNum) {
    const [mil] = await pool.query('DELETE FROM material_issue_log WHERE po_num = ?', [poNum]);
    const local = await deleteRecordsByPO(poNum);
    return {
        materialIssueRows: mil.affectedRows || 0,
        productionRows: local.deleted || 0,
        batches: local.batches || []
    };
}

async function resetPO(docNumber) {
    const poNum = String(docNumber).trim();
    console.log(`\n=== Reset issue data for PO ${poNum} ===`);

    const po = await getPO(poNum);
    console.log(`SAP PO ${po.DocumentNumber} | AE ${po.AbsoluteEntry} | U_PCode ${po.U_PCode} | Done ${po.CompletedQuantity}`);
    for (const l of po.ProductionOrderLines || []) {
        if ((l.PlannedQuantity || 0) <= 0 && (l.IssuedQuantity || 0) <= 0) continue;
        console.log(`  L${l.LineNumber} ${l.ItemNo} planned=${l.PlannedQuantity} issued=${l.IssuedQuantity} wh=${l.Warehouse}`);
    }

    const issues = await findLinkedGoodsIssues(po.AbsoluteEntry, poNum);
    console.log(`Found ${issues.length} goods issue(s): ${issues.map((d) => d.DocEntry).join(', ') || 'none'}`);

    for (const doc of issues) {
        const result = await cancelGoodsIssue(doc.DocEntry);
        if (result.success) {
            console.log(`  ✅ Cancelled goods issue DocEntry ${doc.DocEntry}`);
        } else {
            console.log(`  ❌ Failed to cancel DocEntry ${doc.DocEntry}: ${result.error}`);
        }
    }

    const afterPO = await getPO(poNum);
    console.log('After SAP cancel — lines:');
    for (const l of afterPO.ProductionOrderLines || []) {
        if ((l.PlannedQuantity || 0) <= 0 && (l.IssuedQuantity || 0) <= 0) continue;
        console.log(`  L${l.LineNumber} ${l.ItemNo} planned=${l.PlannedQuantity} issued=${l.IssuedQuantity}`);
    }

    const local = await clearLocal(poNum);
    console.log(`Local cleared: material_issue_log=${local.materialIssueRows}, production_records=${local.productionRows}`);
    if (local.batches.length) console.log(`  batches removed: ${local.batches.join(', ')}`);

    console.log(`\n✅ PO ${poNum} ready — reload in app and issue again.`);
}

(async () => {
    const pos = process.argv.slice(2);
    if (!pos.length) {
        console.error('Usage: node scripts/reset-po-issue-data.js <poNum> [...]');
        process.exit(1);
    }
    await login();
    for (const po of pos) {
        await resetPO(po);
    }
    await pool.end();
})().catch(async (e) => {
    console.error(e.response?.data || e.message || e);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
});
