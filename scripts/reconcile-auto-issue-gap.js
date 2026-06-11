/**
 * Reconcile auto-issue gap for a completed source PO (e.g. coating → slitting).
 * Issues: SAP source CompletedQuantity − next PO material IssuedQuantity
 * Usage: node scripts/reconcile-auto-issue-gap.js 740
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Minimal inline — mirrors server reconcile logic
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
    await login();

    const srcRows = (await get(`/ProductionOrders?$filter=DocumentNumber eq ${sourceDoc}&$select=AbsoluteEntry,DocumentNumber,U_JobEnt,ItemNo,CompletedQuantity&$top=5`)).value || [];
    const src = srcRows[0];
    if (!src) throw new Error(`PO ${sourceDoc} not found`);

    const fgItem = src.ItemNo;
    const jobEnt = src.U_JobEnt;
    const sourceCompleted = Math.floor(src.CompletedQuantity || 0);
    console.log(`Source PO ${src.DocumentNumber} FG=${fgItem} SAP completed=${sourceCompleted}`);

    const related = (await get(`/ProductionOrders?$filter=U_JobEnt eq '${jobEnt}'&$select=AbsoluteEntry,DocumentNumber,U_PCode,ProductionOrderLines&$top=30`)).value || [];
    let target = null;
    for (const po of related) {
        if (po.DocumentNumber === Number(sourceDoc)) continue;
        for (const line of po.ProductionOrderLines || []) {
            if ((line.ItemNo || line.ItemCode) === fgItem) {
                const rem = (line.PlannedQuantity || 0) - (line.IssuedQuantity || 0);
                target = { po, line, issued: line.IssuedQuantity || 0, remaining: rem };
                break;
            }
        }
        if (target) break;
    }
    if (!target) {
        console.log('No next PO with this item as material line.');
        return;
    }

    const gap = sourceCompleted - target.issued;
    console.log(`Next PO ${target.po.DocumentNumber} (${target.po.U_PCode}) issued=${target.issued} gap=${gap}`);
    if (gap <= 0) {
        console.log('Already in sync — nothing to issue.');
        return;
    }

    const wh = target.line.Warehouse || target.line.WarehouseCode || 'OHJW-U1';
    const qty = Math.min(gap, target.remaining > 0 ? target.remaining : gap);
    const k = fgItem.replace(/'/g, "''");
    const batchRows = await runSql(
        `SELECT T0."DistNumber" AS "BatchNumber", T1."Quantity" FROM OBTN T0 INNER JOIN OBTQ T1 ON T0."AbsEntry" = T1."MdAbsEntry" WHERE T1."ItemCode" = '${k}' AND T1."WhsCode" = '${wh.replace(/'/g, "''")}' AND T1."Quantity" > 0 ORDER BY T0."DistNumber" ASC`
    );

    const allocations = [];
    let remaining = qty;
    for (const row of batchRows) {
        if (remaining <= 0) break;
        const bn = row.BatchNumber || row.BATCHNUMBER;
        const stock = Number(row.Quantity || row.QUANTITY || 0);
        const take = Math.min(remaining, stock);
        if (take > 0) {
            allocations.push({ BatchNumber: bn, Quantity: take });
            remaining -= take;
        }
    }
    if (remaining > 0) {
        throw new Error(`Insufficient stock in ${wh}: need ${qty}, short ${remaining}`);
    }

    const payload = {
        DocDate: POST_DATE,
        BPLID: BPL,
        BPL_IDAssignedToInvoice: BPL,
        Comments: `Manual reconcile auto-issue from PO ${sourceDoc}`,
        DocumentLines: [{
            BaseType: 202,
            BaseEntry: target.po.AbsoluteEntry,
            BaseLine: target.line.LineNumber,
            Quantity: qty,
            WarehouseCode: wh,
            TransactionType: 'botrntIssue',
            BatchNumbers: allocations
        }]
    };
    await post('/InventoryGenExits', payload);
    console.log(`✅ Issued ${qty} to PO ${target.po.DocumentNumber} (${allocations.length} batches)`);
}

main().catch((e) => {
    console.error(e.response?.data?.error?.message?.value || e.message);
    process.exit(1);
});
