const { pool } = require('../db-config');

const po = process.argv[2];
if (!po) {
    console.error('Usage: node scripts/clear-trace-po.js <PO_NUMBER>');
    process.exit(1);
}

(async () => {
    try {
        const [r] = await pool.query('DELETE FROM material_issue_log WHERE po_num = ?', [String(po)]);
        console.log(`Deleted ${r.affectedRows} traceability row(s) for PO ${po}`);
    } catch (e) {
        console.error('Error:', e.message);
    }
    process.exit(0);
})();
