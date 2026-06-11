/**
 * E2E: PO 738 (Embossing) finish → PO 739 (Metallisation) material issue + finish
 */
const axios = require('axios');
const API = 'http://localhost:5001';

async function getPO(po, machine, process) {
  const r = await axios.get(
    `${API}/api/production-order/${po}?machine=${machine}&process=${encodeURIComponent(process)}&materialOnly=1`,
    { timeout: 120000 }
  );
  return r.data.data;
}

async function jobComplete(jobData, activities) {
  return axios.post(`${API}/api/job-complete`, { jobData, activities }, { timeout: 300000 });
}

async function issueBatches(payload) {
  return axios.post(`${API}/api/issue-rmc-batches`, payload, { timeout: 120000 });
}

function times() {
  const end = new Date();
  const start = new Date(end.getTime() - 35 * 60000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function main() {
  console.log('=== STEP A: Finish PO 738 (Embossing) ===\n');
  const po738 = await getPO('738', 'embossing-1', 'Embossing');
  console.log('738:', {
    materialIssued: po738.materialIssuedQuantity,
    completed: po738.completedQuantity,
    planned: po738.plannedQuantity,
  });

  const qty738 = 50;
  const t = times();
  const jc738 = await jobComplete({
    po_num: '738',
    machine_name: 'embossing-1',
    operator_name: 'E2E Test',
    absolute_entry: po738.absoluteEntry,
    u_job_ent: po738.uJobEnt,
    planned_qty: po738.plannedQuantity,
    completed_qty: po738.completedQuantity || 0,
    issued_quantity: po738.materialIssuedQuantity || 0,
    quantity_processed: qty738,
    sheets_wasted: 0,
    job_start_time: t.start,
    job_end_time: t.end,
    u_pcode: po738.uPCode,
    item_no: po738.itemNo,
    remark: 'E2E chain test - embossing',
  }, [
    { activity_name: 'makeready', activity_time_minutes: 5 },
    { activity_name: 'running', activity_time_minutes: 30 },
  ]);

  console.log('738 complete:', {
    success: jc738.data?.success,
    batch: jc738.data?.batch_num,
    sap: jc738.data?.sapResult?.success ?? jc738.data?.sap?.success,
    autoIssue: jc738.data?.autoIssue,
    error: jc738.data?.error || jc738.data?.message,
  });

  console.log('\n=== STEP B: Load PO 739 (Metallisation) ===\n');
  const po739 = await getPO('739', 'metallisation-1', 'Metallisation');
  console.log('739 unissued:', po739.unissuedMaterialsNeedIssue);

  const mat = (po739.unissuedMaterialsNeedIssue || [])[0];
  if (!mat) {
    console.log('739: no material to issue — check if auto-issue from 738 worked');
    const after = await getPO('739', 'metallisation-1', 'Metallisation');
    console.log('739 materialIssued:', after.materialIssuedQuantity);
    if ((after.materialIssuedQuantity || 0) <= 0) {
      process.exit(1);
    }
  } else {
    const br = await axios.get(
      `${API}/api/rmc-batches/${encodeURIComponent(mat.itemNo)}?warehouse=${encodeURIComponent(mat.warehouse)}`
    );
    const batches = br.data.batches || [];
    console.log('Batches in', mat.warehouse, ':', batches.length, 'total', br.data.totalAvailable);
    if (!batches.length) {
      console.error('FAIL: No batches in FBD-EMB after 738 complete');
      process.exit(1);
    }
    const pick = batches[0];
    const issueQty = Math.min(30, mat.remainingQuantity, pick.available);
    const ir = await issueBatches({
      absoluteEntry: po739.absoluteEntry,
      documentNumber: '739',
      itemCode: mat.itemNo,
      lineNumber: mat.lineNumber,
      warehouse: mat.warehouse,
      batchAllocations: [{ batchNumber: pick.batchNumber, quantity: issueQty }],
      remarks: 'E2E chain test - MET material',
    });
    console.log('739 material issue:', ir.data);
  }

  console.log('\n=== STEP C: Finish PO 739 ===\n');
  const po739b = await getPO('739', 'metallisation-1', 'Metallisation');
  const t2 = times();
  const jc739 = await jobComplete({
    po_num: '739',
    machine_name: 'metallisation-1',
    operator_name: 'E2E Test',
    absolute_entry: po739b.absoluteEntry,
    u_job_ent: po739b.uJobEnt,
    planned_qty: po739b.plannedQuantity,
    completed_qty: po739b.completedQuantity || 0,
    issued_quantity: po739b.materialIssuedQuantity || 0,
    quantity_processed: 30,
    sheets_wasted: 0,
    job_start_time: t2.start,
    job_end_time: t2.end,
    u_pcode: po739b.uPCode,
    item_no: po739b.itemNo,
    remark: 'E2E chain test - metallisation',
  }, [
    { activity_name: 'makeready', activity_time_minutes: 5 },
    { activity_name: 'running', activity_time_minutes: 30 },
  ]);

  console.log('739 complete:', {
    success: jc739.data?.success,
    batch: jc739.data?.batch_num,
    sap: jc739.data?.sapResult?.success ?? jc739.data?.sap?.success,
    error: jc739.data?.error || jc739.data?.message,
  });

  const final739 = await getPO('739', 'metallisation-1', 'Metallisation');
  console.log('\nFINAL 739:', {
    materialIssued: final739.materialIssuedQuantity,
    completed: final739.completedQuantity,
  });
  console.log('\n✅ Chain test done');
}

main().catch((e) => {
  console.error('FATAL', JSON.stringify(e.response?.data || e.message, null, 2));
  process.exit(1);
});
