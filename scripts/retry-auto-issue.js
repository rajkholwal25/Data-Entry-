/**
 * Retry auto-issue from coating PO to slitting (e.g. 740 → 741).
 * Usage: node scripts/retry-auto-issue.js 740 [qty]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');

const base = process.env.SAP_BASE_URL;
const agent = new https.Agent({ rejectUnauthorized: false });
const BPL = Number(process.env.SAP_BPL_ID || 1);
const POST_DATE = process.env.SAP_OVERRIDE_POSTING_DATE || process.env.SAP_POSTING_DATE || '2025-01-01';

let session = null;
function h() {
    return { 'Content-Type': 'application/json', 'B1S-SessionId': session.sessionId, Cookie: session.cookie || '' };
}

async function login() {
    const res = await axios.post(`${base}/Login`, {
        CompanyDB: process.env.SAP_COMPANY_DB,
        UserName: process.env.SAP_USERNAME,
        Password: process.env.SAP_PASSWORD
    }, { httpsAgent: agent });
    session = { sessionId: res.data.SessionId, cookie: res.headers['set-cookie']?.join(';') };
}

async function get(path) {
    return (await axios.get(`${base}${path}`, { headers: h(), httpsAgent: agent })).data;
}

async function post(path, body) {
    return (await axios.post(`${base}${path}`, body, { headers: h(), httpsAgent: agent })).data;
}

async function runSql(sql) {
    const code = `R_${Date.now()}`;
    await post('/SQLQueries', { SqlCode: code, SqlName: code, SqlText: sql });
    const rows = (await get(`/SQLQueries('${code}')/List`)).value || [];
    axios.delete(`${base}/SQLQueries('${code}')`, { headers: h(), httpsAgent: agent }).catch(() => {});
    return rows;
}

async function main() {
    const sourceDoc = process.argv[2] || '740';
    const qtyArg = process.argv[3] ? Number(process.argv[3]) : null;
    await login();

    const srcRows = (await get(`/ProductionOrders?$filter=DocumentNumber eq ${sourceDoc}&$select=AbsoluteEntry,DocumentNumber,U_JobEnt,ItemNo,U_PCode&$top=5`)).value || [];
    const src = srcRows[0];
    if (!src) throw new Error(`PO ${sourceDoc} not found`);

    const fgItem = src.ItemNo;
    const jobEnt = src.U_JobEnt;
    console.log(`Source PO ${src.DocumentNumber} (${src.U_PCode}) FG=${fgItem} JobEnt=${jobEnt}`);

    const related = (await get(`/ProductionOrders?$filter=U_JobEnt eq '${jobEnt}'&$select=AbsoluteEntry,DocumentNumber,U_PCode,ProductionOrderLines&$top=30`)).value || [];
    let target = null;
    for (const po of related) {
        if (po.DocumentNumber === Number(sourceDoc)) continue;
        if (!String(po.U_PCode || '').toUpperCase().includes('SLT')) continue;
        for (const line of po.ProductionOrderLines || []) {
            if ((line.ItemNo || line.ItemCode) === fgItem) {
                const rem = (line.PlannedQuantity || 0) - (line.IssuedQuantity || 0);
                if (rem > 0) {
                    target = { po, line, remaining: rem };
                    break;
                }
            }
        }
        if (target) break;
    }
    if (!target) {
        console.log('No slitting PO needing this item with remaining qty.');
        return;
    }

    const batchRows = await runSql(
        `SELECT T0."DistNumber", T0."Quantity" FROM OBTN T0 INNER JOIN OBTQ T1 ON T0."ItemCode" = T1."ItemCode" AND T0."SysNumber" = T1."SysNumber" WHERE T0."ItemCode" = '${fgItem.replace(/'/g, "''")}' AND T1."WhsCode" = 'OHJW-U1' AND T1."Quantity" > 0 ORDER BY T0."DistNumber" DESC`
    );
    if (!batchRows.length) throw new Error(`No stock in OHJW-U1 for ${fgItem}`);
    const batch = batchRows[0].DistNumber || batchRows[0].DISTNUMBER;
    const stock = Number(batchRows[0].Quantity || batchRows[0].QUANTITY || 0);
    const issueQty = qtyArg || Math.min(target.remaining, stock);
    console.log(`Target PO ${target.po.DocumentNumber} line ${target.line.LineNumber} remaining=${target.remaining}`);
    console.log(`Batch ${batch} stock=${stock} → issuing ${issueQty}`);

    const payload = {
        DocDate: POST_DATE,
        BPLID: BPL,
        BPL_IDAssignedToInvoice: BPL,
        Comments: `Retry auto-issue from PO ${sourceDoc} to ${target.po.DocumentNumber}`,
        DocumentLines: [{
            BaseType: 202,
            BaseEntry: target.po.AbsoluteEntry,
            BaseLine: target.line.LineNumber,
            Quantity: issueQty,
            WarehouseCode: 'OHJW-U1',
            TransactionType: 'botrntIssue',
            BatchNumbers: [{ BatchNumber: batch, Quantity: issueQty }]
        }]
    };
    await post('/InventoryGenExits', payload);
    console.log(`✅ Issued ${issueQty} to PO ${target.po.DocumentNumber}`);
}

main().catch((e) => {
    console.error(e.response?.data?.error?.message?.value || e.message);
    process.exit(1);
});
