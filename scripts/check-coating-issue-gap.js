/**
 * Diagnose coating completed vs slitting issued gap.
 * Usage: node scripts/check-coating-issue-gap.js [cotPoNumber]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');
const { getBatchesByPO } = require('../db-config');

const base = process.env.SAP_BASE_URL;
const agent = new https.Agent({ rejectUnauthorized: false });

async function main() {
    const cotDoc = process.argv[2] || '740';
    const login = await axios.post(`${base}/Login`, {
        CompanyDB: process.env.SAP_COMPANY_DB,
        UserName: process.env.SAP_USERNAME,
        Password: process.env.SAP_PASSWORD
    }, { httpsAgent: agent });
    const h = { 'B1S-SessionId': login.data.SessionId, Cookie: login.headers['set-cookie']?.join(';') };
    const get = async (p) => (await axios.get(`${base}${p}`, { headers: h, httpsAgent: agent })).data;

    const cotRows = (await get(`/ProductionOrders?$filter=DocumentNumber eq ${cotDoc}&$select=DocumentNumber,U_PCode,U_JobEnt,ItemNo,CompletedQuantity,PlannedQuantity,ProductionOrderLines&$top=5`)).value || [];
    const cot = cotRows[0];
    if (!cot) {
        console.log(`PO ${cotDoc} not found`);
        return;
    }
    console.log(`\n=== Coating PO ${cot.DocumentNumber} ===`);
    console.log(`FG: ${cot.ItemNo} | SAP Completed: ${cot.CompletedQuantity} | Planned: ${cot.PlannedQuantity} | JobEnt: ${cot.U_JobEnt}`);

    let localSum = 0;
    try {
        const batches = await getBatchesByPO(String(cotDoc));
        console.log(`Local batches (${batches.length}):`);
        for (const b of batches) {
            const q = parseInt(b.quantity_processed, 10) || 0;
            localSum += q;
            console.log(`  ${b.batch_num} qty=${q} sap=${b.sap_posted} at=${b.created_at || b.job_end_time || '-'}`);
        }
        console.log(`Local total processed: ${localSum}`);
    } catch (e) {
        console.log('Local DB:', e.message);
    }

    const jobEnt = cot.U_JobEnt;
    const chain = (await get(`/ProductionOrders?$filter=U_JobEnt eq '${jobEnt}'&$select=DocumentNumber,U_PCode,ItemNo,CompletedQuantity,ProductionOrderLines&$top=30`)).value || [];
    console.log(`\n=== Chain JobEnt ${jobEnt} ===`);
    let sltIssued = 0;
    for (const p of chain) {
        console.log(`\nPO ${p.DocumentNumber} ${p.U_PCode} FG=${p.ItemNo} SAP Done=${p.CompletedQuantity}`);
        for (const l of p.ProductionOrderLines || []) {
            if ((l.PlannedQuantity || 0) <= 0) continue;
            const item = l.ItemNo || l.ItemCode;
            console.log(`  L${l.LineNumber} ${item} planned=${l.PlannedQuantity} issued=${l.IssuedQuantity} wh=${l.Warehouse || l.WarehouseCode}`);
            if (String(p.U_PCode || '').includes('SLT') && item === cot.ItemNo) {
                sltIssued = l.IssuedQuantity || 0;
            }
        }
    }

    const sapDone = cot.CompletedQuantity || 0;
    console.log(`\n=== Gap analysis ===`);
    console.log(`SAP coating completed: ${sapDone}`);
    console.log(`Local coating processed: ${localSum}`);
    console.log(`Slitting material issued (${cot.ItemNo}): ${sltIssued}`);
    console.log(`Gap SAP done - SLT issued: ${sapDone - sltIssued}`);
    console.log(`Gap local - SLT issued: ${localSum - sltIssued}`);
}

main().catch((e) => console.error(e.response?.data || e.message));
