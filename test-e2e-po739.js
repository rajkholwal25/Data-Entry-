/**
 * End-to-end API test for PO 739 (Metallisation) — start to finish.
 */
require('dotenv').config();
const axios = require('axios');

const API = 'http://localhost:5001';
const PO = '739';
const MACHINE = 'metallisation-1';
const PROCESS = 'Metallisation';

async function getPO() {
  const url = `${API}/api/production-order/${PO}?machine=${MACHINE}&process=${encodeURIComponent(PROCESS)}&materialOnly=1&enrich=0`;
  const r = await axios.get(url, { timeout: 120000 });
  return r.data?.data || r.data;
}

async function releasePO(absoluteEntry, documentNumber) {
  return axios.post(`${API}/api/release-production-order`, { absoluteEntry, documentNumber }, { timeout: 60000 });
}

async function issueBatches(payload) {
  return axios.post(`${API}/api/issue-rmc-batches`, payload, { timeout: 120000 });
}

async function jobComplete(jobData, activities) {
  return axios.post(`${API}/api/job-complete`, { jobData, activities }, { timeout: 180000 });
}

function log(step, data) {
  console.log(`\n=== ${step} ===`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function main() {
  console.log(`E2E TEST PO ${PO} (${PROCESS} / ${MACHINE})\n`);

  // Step 1: Load PO
  let po;
  try {
    po = await getPO();
    log('1. LOAD PO', {
      jobNumber: po.jobNumber,
      itemNo: po.itemNo,
      uPCode: po.uPCode,
      absoluteEntry: po.absoluteEntry,
      plannedQuantity: po.plannedQuantity,
      materialIssued: po.materialIssuedQuantity,
      completedQuantity: po.completedQuantity,
      status: po.productionOrderStatus,
      unissued: po.unissuedMaterialsNeedIssue,
    });
  } catch (e) {
    log('1. LOAD PO FAILED', e.response?.data || e.message);
    process.exit(1);
  }

  if (!po.absoluteEntry) {
    log('ABORT', 'No absoluteEntry');
    process.exit(1);
  }

  // Step 2: Release if needed
  try {
    const rel = await releasePO(po.absoluteEntry, PO);
    log('2. RELEASE PO', rel.data);
  } catch (e) {
    log('2. RELEASE PO', e.response?.data || e.message);
  }

  // Step 3: Material issue if needed
  const mats = po.unissuedMaterialsNeedIssue || [];
  const batchMats = mats.filter((m) => m.batchManaged && (m.remainingQuantity ?? m.plannedQuantity) > 0);
  if (batchMats.length === 0) {
    log('3. MATERIAL ISSUE', 'Nothing to issue (already issued or no batch-managed RM lines)');
  } else {
    for (const mat of batchMats) {
      const need = mat.remainingQuantity ?? mat.plannedQuantity;
      log('3. FETCH BATCHES', { item: mat.itemNo, warehouse: mat.warehouse, need });
      const batchUrl = `${API}/api/rmc-batches/${encodeURIComponent(mat.itemNo)}?warehouse=${encodeURIComponent(mat.warehouse || 'FBD-RM')}`;
      const br = await axios.get(batchUrl, { timeout: 60000 });
      const batches = br.data?.batches || [];
      if (!batches.length) {
        log('3. MATERIAL ISSUE FAILED', `No batches for ${mat.itemNo} in ${mat.warehouse || 'FBD-RM'}`);
        process.exit(1);
      }
      const pick = batches[0];
      const qty = Math.min(need, pick.available || need);
      const payload = {
        absoluteEntry: po.absoluteEntry,
        documentNumber: PO,
        itemCode: mat.itemNo,
        lineNumber: mat.lineNumber,
        warehouse: mat.warehouse || 'FBD-RM',
        batchAllocations: [{ batchNumber: pick.batchNumber, quantity: qty }],
        remarks: `E2E test issue PO ${PO}`,
      };
      try {
        const ir = await issueBatches(payload);
        log('3. MATERIAL ISSUE OK', { item: mat.itemNo, qty, batch: pick.batchNumber, result: ir.data });
      } catch (e) {
        log('3. MATERIAL ISSUE FAILED', e.response?.data || e.message);
        process.exit(1);
      }
    }
  }

  // Refresh PO after issue
  po = await getPO();
  log('4. PO AFTER ISSUE', {
    materialIssued: po.materialIssuedQuantity,
    unissued: po.unissuedMaterialsNeedIssue,
  });

  // Step 5: Job complete (small test qty)
  const testQty = Math.min(10, (po.plannedQuantity || 10) - (po.completedQuantity || 0));
  if (testQty <= 0) {
    log('5. JOB COMPLETE', 'Skipped — nothing remaining to complete');
    return;
  }

  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60000).toISOString();
  const end = now.toISOString();

  const jobData = {
    po_num: PO,
    machine_name: MACHINE,
    operator_name: 'E2E Test',
    absolute_entry: po.absoluteEntry,
    u_job_ent: po.uJobEnt,
    planned_qty: po.plannedQuantity,
    completed_qty: po.completedQuantity || 0,
    issued_quantity: po.materialIssuedQuantity || po.issuedQuantity || 0,
    material_issued_quantity: po.materialIssuedQuantity,
    quantity_processed: testQty,
    sheets_wasted: 0,
    job_start_time: start,
    job_end_time: end,
    u_pcode: po.uPCode,
    item_no: po.itemNo,
    remark: 'E2E automated test',
  };

  const activities = [
    { activity_name: 'makeready', activity_time_minutes: 5 },
    { activity_name: 'running', activity_time_minutes: 25 },
  ];

  try {
    const jc = await jobComplete(jobData, activities);
    log('5. JOB COMPLETE OK', {
      batch: jc.data?.batch_num,
      sap: jc.data?.sapResult || jc.data?.sap,
      resourceIssue: jc.data?.resourceIssueResult,
    });
  } catch (e) {
    log('5. JOB COMPLETE FAILED', e.response?.data || e.message);
    process.exit(1);
  }

  // Step 6: Verify PO state
  const finalPo = await getPO();
  log('6. FINAL PO STATE', {
    materialIssued: finalPo.materialIssuedQuantity,
    completedQuantity: finalPo.completedQuantity,
    unissued: finalPo.unissuedMaterialsNeedIssue,
  });

  console.log('\n✅ E2E test finished');
}

main().catch((e) => {
  console.error('FATAL', e.response?.data || e.message);
  process.exit(1);
});
