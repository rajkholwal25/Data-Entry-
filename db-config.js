// Database Configuration - PostgreSQL (converted from MySQL)
// ---------------------------------------------------------------------------
// This app was originally written for MySQL (mysql2). It now targets
// PostgreSQL via the `pg` driver. To keep the large amount of existing query
// code working with minimal churn, `pool.query()` is wrapped so it behaves
// like mysql2:
//   - `?` placeholders are converted to `$1, $2, ...`
//   - the result is returned as a `[rows, fields]` tuple
//   - `rows.affectedRows` and `rows.insertId` are exposed (INSERTs must use
//     `RETURNING <pk> AS "insertId"` for insertId to be populated)
// ---------------------------------------------------------------------------
const { Pool } = require('pg');
const path = require('path');

// Load .env from the same directory as this file
const envPath = path.join(__dirname, '.env');
console.log('📁 Loading .env from:', envPath);
require('dotenv').config({ path: envPath });

const DATABASE_URL = process.env.DATABASE_URL || '';

// Debug: Show loaded configuration (mask password for security)
console.log('🔧 Database Configuration (PostgreSQL):');
if (DATABASE_URL) {
    console.log('   DATABASE_URL:', DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, '://$1:****@'));
} else {
    console.log('   DB_HOST:', process.env.DB_HOST || '(not set, using localhost)');
    console.log('   DB_PORT:', process.env.DB_PORT || '(not set, using 5432)');
    console.log('   DB_USER:', process.env.DB_USER || '(not set, using postgres)');
    console.log('   DB_NAME:', process.env.DB_NAME || '(not set, using postgres)');
}

// Create a connection pool. Prefer DATABASE_URL; fall back to discrete vars.
const pgPool = DATABASE_URL
    ? new Pool({ connectionString: DATABASE_URL, max: 10 })
    : new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'postgres',
        max: 10
    });

pgPool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
});

// Convert mysql2-style `?` placeholders to PostgreSQL `$1, $2, ...`.
function convertPlaceholders(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

// mysql2-compatible query wrapper. Returns [rows, fields].
async function query(sql, params = []) {
    const text = convertPlaceholders(sql);
    const result = await pgPool.query(text, params);
    const rows = result.rows || [];
    // Expose mysql2-style metadata on the rows array.
    rows.affectedRows = result.rowCount;
    if (rows[0] && Object.prototype.hasOwnProperty.call(rows[0], 'insertId')) {
        rows.insertId = rows[0].insertId;
    }
    return [rows, result.fields];
}

// mysql2-compatible getConnection (used by testConnection()).
async function getConnection() {
    const client = await pgPool.connect();
    return {
        release: () => client.release(),
        query: async (sql, params = []) => query(sql, params)
    };
}

const pool = {
    query,
    getConnection,
    end: () => pgPool.end()
};

// ---------------------------------------------------------------------------
// Schema (idempotent) — tables / sequence / views the app relies on
// ---------------------------------------------------------------------------
async function ensureSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS production_records (
            unique_id                  BIGSERIAL PRIMARY KEY,
            batch_num                  VARCHAR(40),
            po_num                     VARCHAR(64),
            fg_num                     VARCHAR(64),
            job_name                   VARCHAR(255),
            operator_name              VARCHAR(128),
            shift_type                 VARCHAR(16),
            machine_name               VARCHAR(128),
            process_name               VARCHAR(64),
            planned_qty                INTEGER DEFAULT 0,
            job_start_time             TIMESTAMP,
            job_end_time               TIMESTAMP,
            quantity_processed         INTEGER DEFAULT 0,
            role_quantity_used         NUMERIC,
            chemical_quantity_used     NUMERIC,
            speed_impressions_per_hour NUMERIC DEFAULT 0,
            sheets_wasted              INTEGER DEFAULT 0,
            remark                     TEXT,
            activity_name              VARCHAR(64),
            activity_time_minutes      NUMERIC DEFAULT 0,
            device_id                  VARCHAR(64),
            date_of_entry              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_batch ON production_records (batch_num)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_po ON production_records (po_num)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_fg ON production_records (fg_num)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pr_machine ON production_records (machine_name)`);

    // Sequence backing the batch number series (B000001, B000002, ...)
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS batch_num_seq START 1`);

    // Widen batch_num before views (views block ALTER on PostgreSQL)
    try {
        const [colRows] = await pool.query(`
            SELECT character_maximum_length::int AS len
            FROM information_schema.columns
            WHERE table_name = 'production_records' AND column_name = 'batch_num'
        `);
        const colLen = colRows[0]?.len || 16;
        if (colLen < 40) {
            await pool.query('DROP VIEW IF EXISTS vw_shift_summary');
            await pool.query('DROP VIEW IF EXISTS vw_job_summary');
            await pool.query('DROP VIEW IF EXISTS vw_batch_summary');
            await pool.query('ALTER TABLE production_records ALTER COLUMN batch_num TYPE VARCHAR(40)');
            console.log('   ✅ batch_num column widened to VARCHAR(40)');
        }
    } catch (err) {
        console.warn('⚠️ batch_num column widen failed:', err.message);
    }

    for (const col of ['role_quantity_used', 'chemical_quantity_used']) {
        try {
            await pool.query(
                `ALTER TABLE production_records ADD COLUMN IF NOT EXISTS ${col} NUMERIC`
            );
        } catch (err) {
            console.warn(`⚠️ Could not add column ${col}:`, err.message);
        }
    }

    // PostgreSQL cannot add/reorder view columns via CREATE OR REPLACE — drop first.
    await pool.query('DROP VIEW IF EXISTS vw_shift_summary');
    await pool.query('DROP VIEW IF EXISTS vw_job_summary');
    await pool.query('DROP VIEW IF EXISTS vw_batch_summary');

    await pool.query(`
        CREATE VIEW vw_batch_summary AS
        SELECT batch_num,
               MAX(po_num)               AS po_num,
               MAX(fg_num)               AS fg_num,
               MAX(job_name)             AS job_name,
               MAX(machine_name)         AS machine_name,
               MAX(operator_name)        AS operator_name,
               MAX(shift_type)           AS shift_type,
               MIN(job_start_time)       AS job_start,
               MAX(job_end_time)         AS job_end,
               MAX(planned_qty)          AS planned_qty,
               MAX(quantity_processed)   AS quantity_processed,
               MAX(role_quantity_used)   AS role_quantity_used,
               MAX(chemical_quantity_used) AS chemical_quantity_used,
               SUM(sheets_wasted)        AS total_sheets_wasted,
               SUM(activity_time_minutes) AS total_minutes,
               COUNT(*)                  AS activity_count
        FROM production_records
        GROUP BY batch_num
    `);

    await pool.query(`
        CREATE VIEW vw_job_summary AS
        SELECT batch_num,
               MAX(po_num)               AS po_num,
               MAX(fg_num)               AS fg_num,
               MAX(job_name)             AS job_name,
               MAX(machine_name)         AS machine_name,
               MAX(operator_name)        AS operator_name,
               MAX(shift_type)           AS shift_type,
               MAX(process_name)         AS process_name,
               MAX(planned_qty)          AS planned_qty,
               MAX(quantity_processed)   AS quantity_processed,
               MIN(job_start_time)       AS job_start_time,
               MAX(job_end_time)         AS job_end_time,
               SUM(sheets_wasted)        AS total_sheets_wasted,
               SUM(activity_time_minutes) AS total_minutes,
               SUM(CASE WHEN activity_name = 'makeready' THEN activity_time_minutes ELSE 0 END) AS makeready_minutes,
               SUM(CASE WHEN activity_name = 'running'   THEN activity_time_minutes ELSE 0 END) AS running_minutes,
               COUNT(*)                  AS activity_count
        FROM production_records
        GROUP BY batch_num
    `);

    await pool.query(`
        CREATE VIEW vw_shift_summary AS
        SELECT machine_name,
               (job_start_time)::date    AS shift_date,
               shift_type,
               COUNT(DISTINCT batch_num) AS job_count,
               SUM(quantity_processed)   AS total_quantity,
               SUM(sheets_wasted)        AS total_sheets_wasted,
               SUM(activity_time_minutes) AS total_minutes
        FROM production_records
        GROUP BY machine_name, (job_start_time)::date, shift_type
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS po_local_reset (
            po_num    VARCHAR(64) PRIMARY KEY,
            reset_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Material issue traceability: every roll/batch issued to a PO, later linked
    // to the output batch produced at job finish (input → output genealogy).
    await pool.query(`
        CREATE TABLE IF NOT EXISTS material_issue_log (
            issue_id        BIGSERIAL PRIMARY KEY,
            po_num          VARCHAR(64),
            absolute_entry  BIGINT,
            line_number     INTEGER,
            item_code       VARCHAR(64),
            batch_number    VARCHAR(80),
            quantity        NUMERIC DEFAULT 0,
            warehouse       VARCHAR(32),
            operator_name   VARCHAR(128),
            machine_name    VARCHAR(128),
            sap_doc_entry   VARCHAR(64),
            output_batch    VARCHAR(80),
            remarks         TEXT,
            issued_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mil_po ON material_issue_log (po_num)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mil_batch ON material_issue_log (batch_number)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mil_output ON material_issue_log (output_batch)`);

    console.log('✅ Production schema ready (production_records, material_issue_log, views, batch_num_seq)');
}

// Test database connection
async function testConnection() {
    try {
        console.log('🔌 Attempting database connection...');
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully!');
        connection.release();
        // Make sure the schema the app needs exists.
        await ensureSchema();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed!');
        console.error('   Error:', error.message);
        console.error('   Code:', error.code);
        if (error.code === '28P01' || error.code === '28000') {
            console.error('   → Check username/password in DATABASE_URL (.env)');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('   → PostgreSQL server not running or not accessible');
        } else if (error.code === '3D000') {
            console.error('   → Database does not exist (check DATABASE_URL db name)');
        } else if (error.code === 'ENOTFOUND') {
            console.error('   → Invalid host address');
        }
        console.log('⚠️  App will continue without database (data saved locally)');
        return false;
    }
}

/** Unit 1 batch prefix: PBP-12-1003-ALO-EMB- (FG item code already includes process suffix). */
function buildUnit1BatchPrefix(itemCode, processTag) {
    const code = String(itemCode || '').trim().toUpperCase();
    const tag = String(processTag || '').trim().toUpperCase();
    // SAP FG item is e.g. PBP-12-1003-ALO-EMB — process is already in item code
    if (tag && code.endsWith(`-${tag}`)) {
        return `${code}-`;
    }
    return tag ? `${code}-${tag}-` : `${code}-`;
}

/** Infer process tag from FG item code suffix (e.g. …-ALO-COT, …-HRI-COT, …-TRI-COT → COT). */
function inferUnit1ProcessTagFromItemCode(itemCode) {
    const c = String(itemCode || '').trim().toUpperCase();
    if (c.endsWith('-COT')) return 'COT';
    if (c.endsWith('-EMB')) return 'EMB';
    if (c.endsWith('-MTL') || c.endsWith('-MET')) return 'MET';
    if (c.endsWith('-SLT')) return 'SLT';
    if (c.endsWith('-REW')) return 'REW';
    return null;
}

/** Resolve process tag for Unit 1 output batches (EMB, MET, SLT, REW, COT). */
function getUnit1ProcessBatchTag(uPCode, processName, machineName, itemCode) {
    const u = String(uPCode || '').toUpperCase();
    if (u.includes('COT')) return 'COT';
    if (u.includes('MET') || u.includes('MTL')) return 'MET';
    if (u.includes('SLT')) return 'SLT';
    if (u.includes('REW')) return 'REW';
    if (u.includes('EMB')) return 'EMB';

    const fromItem = inferUnit1ProcessTagFromItemCode(itemCode);
    if (fromItem) return fromItem;

    const machine = String(machineName || '').toLowerCase();
    if (machine.includes('emboss')) return 'EMB';
    if (machine.includes('metall')) return 'MET';
    if (machine.includes('slitting') || machine.startsWith('slt')) return 'SLT';
    if (machine.includes('rewind')) return 'REW';
    if (machine.includes('coat')) return 'COT';

    const proc = String(processName || '').toLowerCase();
    if (proc.includes('emboss')) return 'EMB';
    if (proc.includes('metall')) return 'MET';
    if (proc.includes('slitting')) return 'SLT';
    if (proc.includes('rewind')) return 'REW';
    if (proc.includes('coating')) return 'COT';

    return 'EMB';
}

/** Parse seq from Unit 1 batch (PBP-12-1003-ALO-EMB-001 → 1). */
function parseUnit1BatchSeq(batchNumber, itemCode, processTag) {
    const prefix = buildUnit1BatchPrefix(itemCode, processTag);
    const batch = String(batchNumber || '').trim().toUpperCase();
    if (!batch.startsWith(prefix)) return null;
    const suffix = batch.slice(prefix.length);
    if (!/^\d{3}$/.test(suffix)) return null;
    return parseInt(suffix, 10);
}

// Unit 1 batch: {ITEM_CODE}-{PROCESS}-{001} e.g. PBP-12-1003-ALO-EMB-001
async function getUnit1BatchNum(itemCode, processTag, poNum, startTime, sapMaxSeq = 0) {
    const code = String(itemCode || '').trim().toUpperCase();
    const tag = String(processTag || '').trim().toUpperCase();
    if (!code || !tag) {
        return getBatchNum(poNum, startTime, null);
    }

    const prefix = buildUnit1BatchPrefix(code, tag);
    console.log(`   🔢 Generating Unit 1 batch: ${prefix}###`);
    console.log(`      PO: ${poNum}, SAP max seq: ${sapMaxSeq}`);

    if (poNum && startTime) {
        const [existing] = await pool.query(
            `SELECT batch_num FROM production_records
             WHERE po_num = ? AND job_start_time = ?
             ORDER BY date_of_entry ASC LIMIT 1`,
            [poNum, startTime]
        );
        if (existing[0] && existing[0].batch_num) {
            console.log(`      ♻️  Reusing existing batch: ${existing[0].batch_num}`);
            return existing[0].batch_num;
        }
    }

    const likePrefix = `${prefix}%`;
    const [rows] = await pool.query(
        `SELECT batch_num FROM production_records
         WHERE UPPER(fg_num) = ?
           AND UPPER(batch_num) LIKE ?
           AND RIGHT(batch_num, 3) ~ '^[0-9]+$'
         ORDER BY CAST(RIGHT(batch_num, 3) AS INTEGER) DESC
         LIMIT 1`,
        [code, likePrefix.toUpperCase()]
    );

    let localMax = 0;
    if (rows[0] && rows[0].batch_num) {
        localMax = parseUnit1BatchSeq(rows[0].batch_num, code, tag) || 0;
    }

    const nextSeq = Math.max(localMax, Number(sapMaxSeq) || 0) + 1;
    if (nextSeq > 999) {
        throw new Error(`Batch sequence exceeded 999 for ${prefix}`);
    }

    const batchNum = `${prefix}${String(nextSeq).padStart(3, '0')}`;
    console.log(`      ✅ Generated Unit 1 batch: ${batchNum}`);
    return batchNum;
}

// Get or generate batch number.
// Format: B + 6-digit sequential number (B000001, B000002, etc.)
// Reuses an existing batch for the same PO + job start time.
async function getBatchNum(poNum, startTime, endTime) {
    try {
        console.log(`   🔢 Generating batch number for PO: ${poNum}`);
        console.log(`      Start time: ${startTime}`);
        console.log(`      End time: ${endTime}`);

        if (poNum && startTime) {
            const [existing] = await pool.query(
                `SELECT batch_num FROM production_records
                 WHERE po_num = ? AND job_start_time = ?
                 ORDER BY date_of_entry ASC LIMIT 1`,
                [poNum, startTime]
            );
            if (existing[0] && existing[0].batch_num) {
                console.log(`      ♻️  Reusing existing batch number: ${existing[0].batch_num}`);
                return existing[0].batch_num;
            }
        }

        const [seq] = await pool.query(
            `SELECT 'B' || LPAD(nextval('batch_num_seq')::text, 6, '0') AS batch_num`
        );
        if (seq[0] && seq[0].batch_num) {
            console.log(`      ✅ Generated batch number: ${seq[0].batch_num}`);
            return seq[0].batch_num;
        }

        throw new Error('Failed to generate batch number');
    } catch (error) {
        console.error('Error getting batch number:', error);
        console.error('   Error code:', error.code);
        console.error('   Error message:', error.message);
        throw error;
    }
}

// Insert a production activity record
async function insertActivityRecord(data) {
    try {
        const batchNum = data.batch_num || await getBatchNum(
            data.po_num,
            data.job_start_time,
            data.job_end_time
        );

        const query = `
            INSERT INTO production_records 
            (batch_num, po_num, fg_num, job_name, operator_name, shift_type, machine_name, 
             process_name, planned_qty, job_start_time, job_end_time, quantity_processed,
             role_quantity_used, chemical_quantity_used,
             speed_impressions_per_hour, sheets_wasted, remark,
             activity_name, activity_time_minutes, device_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING unique_id AS "insertId"
        `;

        const values = [
            batchNum,
            data.po_num || null,
            data.fg_num || null,
            data.job_name || null,
            data.operator_name || 'Operator',
            data.shift_type || 'day',
            data.machine_name || null,
            data.process_name || null,
            data.planned_qty || 0,
            data.job_start_time || null,
            data.job_end_time || null,
            data.quantity_processed || 0,
            data.role_quantity_used ?? null,
            data.chemical_quantity_used ?? null,
            data.speed_impressions_per_hour || 0,
            data.sheets_wasted || 0,
            data.remark || null,
            data.activity_name || null,
            data.activity_time_minutes || 0,
            data.device_id || null
        ];

        const [result] = await pool.query(query, values);
        return {
            unique_id: result.insertId,
            batch_num: batchNum
        };
    } catch (error) {
        console.error('Error inserting activity record:', error);
        throw error;
    }
}

// Insert multiple activity records for a job (batch insert)
async function insertJobActivities(jobData, activities) {
    try {
        const fgCode = (jobData.fg_num || jobData.item_no || '').trim();
        const processTag = jobData._batch_process_tag || getUnit1ProcessBatchTag(
            jobData.u_pcode || jobData.uPCode || jobData.process_code,
            jobData.process_name,
            jobData.machine_name,
            fgCode
        );
        const batchNum = (jobData.use_item_code_batch && fgCode)
            ? await getUnit1BatchNum(
                fgCode,
                processTag,
                jobData.po_num,
                jobData.job_start_time,
                Number(jobData._sap_batch_seq) || 0
            )
            : await getBatchNum(
                jobData.po_num,
                jobData.job_start_time,
                jobData.job_end_time
            );

        const rows = activities.map(activity => [
            batchNum,
            jobData.po_num,
            jobData.fg_num || null,
            jobData.job_name || null,
            jobData.operator_name || 'Operator',
            jobData.shift_type || 'day',
            jobData.machine_name || null,
            jobData.process_name || null,
            jobData.planned_qty || 0,
            jobData.job_start_time || null,
            jobData.job_end_time || null,
            jobData.quantity_processed || 0,
            jobData.role_quantity_used ?? null,
            jobData.chemical_quantity_used ?? null,
            jobData.speed_impressions_per_hour || 0,
            jobData.sheets_wasted || 0,
            jobData.remark || null,
            activity.activity_name,
            activity.activity_time_minutes || 0,
            jobData.device_id || null
        ]);

        if (rows.length === 0) {
            return { batch_num: batchNum, inserted: 0 };
        }

        const COLS = 20;
        const placeholders = rows
            .map(() => `(${new Array(COLS).fill('?').join(', ')})`)
            .join(', ');

        const query = `
            INSERT INTO production_records 
            (batch_num, po_num, fg_num, job_name, operator_name, shift_type, machine_name, 
             process_name, planned_qty, job_start_time, job_end_time, quantity_processed,
             role_quantity_used, chemical_quantity_used,
             speed_impressions_per_hour, sheets_wasted, remark,
             activity_name, activity_time_minutes, device_id)
            VALUES ${placeholders}
        `;

        const [result] = await pool.query(query, rows.flat());
        return {
            batch_num: batchNum,
            inserted: result.affectedRows
        };
    } catch (error) {
        console.error('Error inserting job activities:', error);
        throw error;
    }
}

// Get all activities for a batch
async function getActivitiesByBatchNum(batchNum) {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM production_records WHERE batch_num = ? ORDER BY date_of_entry',
            [batchNum]
        );
        return rows;
    } catch (error) {
        console.error('Error fetching activities:', error);
        throw error;
    }
}

// Get all batches for a PO
async function getBatchesByPO(poNum) {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM vw_batch_summary WHERE po_num = ? ORDER BY job_start DESC',
            [poNum]
        );
        return rows;
    } catch (error) {
        console.error('Error fetching batches:', error);
        throw error;
    }
}

/** Cumulative embossing role/chemical from local batches (role drives RM remaining). */
async function getEmbossingQuantitiesByPO(poNum) {
    try {
        const [rows] = await pool.query(
            `SELECT
                COALESCE(SUM(role_quantity_used), 0)     AS role_used,
                COALESCE(SUM(chemical_quantity_used), 0) AS chemical_used,
                COUNT(*) FILTER (WHERE role_quantity_used IS NOT NULL) AS tracked_batches
             FROM vw_batch_summary
             WHERE po_num = ?`,
            [poNum]
        );
        const row = rows[0] || {};
        return {
            roleUsed: Number(row.role_used) || 0,
            chemicalUsed: Number(row.chemical_used) || 0,
            trackedBatches: Number(row.tracked_batches) || 0
        };
    } catch (error) {
        console.error('Error fetching embossing quantities:', error);
        throw error;
    }
}

// Get job summary using view
async function getJobSummary(batchNum) {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM vw_job_summary WHERE batch_num = ?',
            [batchNum]
        );
        return rows[0] || null;
    } catch (error) {
        console.error('Error fetching job summary:', error);
        throw error;
    }
}

// Get shift summary
async function getShiftSummary(machineName, date, shiftType) {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM vw_shift_summary WHERE machine_name = ? AND shift_date = ? AND shift_type = ?',
            [machineName, date, shiftType]
        );
        return rows[0] || null;
    } catch (error) {
        console.error('Error fetching shift summary:', error);
        throw error;
    }
}

// Get activities by machine and date
async function getActivitiesByMachineAndDate(machineName, date) {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM production_records WHERE machine_name = ? AND job_start_time::date = ? ORDER BY job_start_time, batch_num',
            [machineName, date]
        );
        return rows;
    } catch (error) {
        console.error('Error fetching activities:', error);
        throw error;
    }
}

// Update activity record
async function updateActivityRecord(uniqueId, data) {
    try {
        const updates = [];
        const values = [];

        const allowedFields = [
            'activity_time_minutes', 'quantity_processed', 'speed_impressions_per_hour',
            'sheets_wasted', 'remark', 'job_end_time'
        ];

        allowedFields.forEach(field => {
            if (data[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(data[field]);
            }
        });

        if (updates.length === 0) {
            return false;
        }

        values.push(uniqueId);
        const query = `UPDATE production_records SET ${updates.join(', ')} WHERE unique_id = ?`;

        const [result] = await pool.query(query, values);
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error updating activity record:', error);
        throw error;
    }
}

// Update all activities in a batch (for job completion)
async function updateBatchActivities(batchNum, data) {
    try {
        const updates = [];
        const values = [];

        const allowedFields = [
            'job_end_time', 'quantity_processed', 'speed_impressions_per_hour',
            'sheets_wasted', 'remark'
        ];

        allowedFields.forEach(field => {
            if (data[field] !== undefined) {
                updates.push(`${field} = ?`);
                values.push(data[field]);
            }
        });

        if (updates.length === 0) {
            return false;
        }

        values.push(batchNum);
        const query = `UPDATE production_records SET ${updates.join(', ')} WHERE batch_num = ?`;

        const [result] = await pool.query(query, values);
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error updating batch activities:', error);
        throw error;
    }
}

// Delete activity record
async function deleteActivityRecord(uniqueId) {
    try {
        const [result] = await pool.query(
            'DELETE FROM production_records WHERE unique_id = ?',
            [uniqueId]
        );
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error deleting activity record:', error);
        throw error;
    }
}

// Delete all activities in a batch
async function deleteBatch(batchNum) {
    try {
        const [result] = await pool.query(
            'DELETE FROM production_records WHERE batch_num = ?',
            [batchNum]
        );
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error deleting batch:', error);
        throw error;
    }
}

/** Delete all local production records for a PO (not SAP — local DB only). */
async function deleteRecordsByPO(poNum) {
    const po = String(poNum || '').trim();
    if (!po) return { deleted: 0, batches: [] };

    const [batchRows] = await pool.query(
        `SELECT DISTINCT batch_num FROM production_records WHERE po_num = ? ORDER BY batch_num`,
        [po]
    );
    const batches = (batchRows || []).map((r) => r.batch_num).filter(Boolean);

    const [result] = await pool.query(
        'DELETE FROM production_records WHERE po_num = ?',
        [po]
    );

    await markPOLocalReset(po);

    return {
        deleted: result.affectedRows || 0,
        batches
    };
}

/** Mark PO so Already Done shows 0 until next successful SAP completion. */
async function markPOLocalReset(poNum) {
    const po = String(poNum || '').trim();
    if (!po) return;
    await pool.query(
        `INSERT INTO po_local_reset (po_num, reset_at) VALUES (?, CURRENT_TIMESTAMP)
         ON CONFLICT (po_num) DO UPDATE SET reset_at = CURRENT_TIMESTAMP`,
        [po]
    );
}

async function clearPOLocalReset(poNum) {
    const po = String(poNum || '').trim();
    if (!po) return;
    await pool.query('DELETE FROM po_local_reset WHERE po_num = ?', [po]);
}

async function isPOLocallyReset(poNum) {
    const po = String(poNum || '').trim();
    if (!po) return false;
    const [rows] = await pool.query(
        'SELECT po_num FROM po_local_reset WHERE po_num = ? LIMIT 1',
        [po]
    );
    return !!(rows && rows[0]);
}

// Get best historical performance for a finished goods number (fg_num)
// Returns minimum MakeReady time and minimum per-unit running time from past jobs
async function getBestPerformance(fgNum, machineName = null) {
    try {
        const whereClause = 'fg_num = ?';
        const params = [fgNum];

        const makeReadyQuery = `
            SELECT 
                MIN(activity_time_minutes) as best_makeready_minutes,
                COUNT(DISTINCT batch_num) as job_count
            FROM production_records 
            WHERE ${whereClause}
              AND activity_name = 'makeready'
              AND activity_time_minutes >= 1
        `;

        const bestMakeReadyMachineQuery = `
            SELECT machine_name, activity_time_minutes
            FROM production_records 
            WHERE ${whereClause}
              AND activity_name = 'makeready'
              AND activity_time_minutes >= 1
            ORDER BY activity_time_minutes ASC
            LIMIT 1
        `;

        const runningQuery = `
            SELECT 
                MIN(activity_time_minutes / NULLIF(quantity_processed, 0)) as best_running_per_unit,
                AVG(activity_time_minutes / NULLIF(quantity_processed, 0)) as avg_running_per_unit
            FROM production_records 
            WHERE ${whereClause}
              AND activity_name = 'running'
              AND activity_time_minutes >= 1
              AND quantity_processed > 0
        `;

        const bestRunningMachineQuery = `
            SELECT 
                machine_name,
                activity_time_minutes,
                quantity_processed,
                (activity_time_minutes / NULLIF(quantity_processed, 0)) as running_per_unit
            FROM production_records 
            WHERE ${whereClause}
              AND activity_name = 'running'
              AND activity_time_minutes >= 1
              AND quantity_processed > 0
            ORDER BY running_per_unit ASC
            LIMIT 1
        `;

        const speedQuery = `
            SELECT 
                MAX(speed_impressions_per_hour) as best_speed,
                AVG(speed_impressions_per_hour) as avg_speed
            FROM production_records 
            WHERE ${whereClause}
              AND speed_impressions_per_hour > 0
            GROUP BY fg_num
        `;

        const [makeReadyResult] = await pool.query(makeReadyQuery, params);
        const [bestMakeReadyMachineResult] = await pool.query(bestMakeReadyMachineQuery, params);
        const [runningResult] = await pool.query(runningQuery, params);
        const [bestRunningMachineResult] = await pool.query(bestRunningMachineQuery, params);
        const [speedResult] = await pool.query(speedQuery, params);

        const makeReadyData = makeReadyResult[0] || {};
        const bestMakeReadyMachine = bestMakeReadyMachineResult[0] || {};
        const runningData = runningResult[0] || {};
        const bestRunningMachine = bestRunningMachineResult[0] || {};
        const speedData = speedResult[0] || {};

        return {
            fgNum: fgNum,
            machineName: machineName,
            hasHistory: (makeReadyData.job_count || 0) > 0,
            jobCount: parseInt(makeReadyData.job_count, 10) || 0,
            bestMakeReadyMinutes: parseFloat(makeReadyData.best_makeready_minutes) || null,
            bestMakeReadyMachine: bestMakeReadyMachine.machine_name || null,
            bestRunningPerUnit: parseFloat(runningData.best_running_per_unit) || null,
            avgRunningPerUnit: parseFloat(runningData.avg_running_per_unit) || null,
            bestRunningMachine: bestRunningMachine.machine_name || null,
            bestSpeed: parseFloat(speedData.best_speed) || null,
            avgSpeed: parseFloat(speedData.avg_speed) || null
        };
    } catch (error) {
        console.error('Error fetching best performance:', error);
        throw error;
    }
}

// Detect duplicate submit (same PO + start time + qty within 2 minutes)
async function findRecentDuplicateJobCompletion(poNum, jobStartTime, quantityProcessed) {
    if (!poNum || !jobStartTime) return null;
    try {
        const [rows] = await pool.query(
            `SELECT batch_num, MAX(job_end_time) AS job_end_time
             FROM production_records
             WHERE po_num = ? AND job_start_time = ? AND quantity_processed = ?
               AND job_end_time >= NOW() - INTERVAL '2 minutes'
             GROUP BY batch_num
             ORDER BY job_end_time DESC
             LIMIT 1`,
            [String(poNum), jobStartTime, Number(quantityProcessed) || 0]
        );
        return rows[0] || null;
    } catch (error) {
        console.warn('Duplicate job check failed:', error.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Material issue traceability (input rolls/batches → output batch genealogy)
// ---------------------------------------------------------------------------

/** Record one issued roll/batch against a PO. Best-effort; never throws. */
async function recordMaterialIssue(entry) {
    try {
        const batchNumber = String(entry.batch_number || '').trim();
        const quantity = Number(entry.quantity) || 0;
        if (!batchNumber || quantity <= 0) return null;

        const [result] = await pool.query(
            `INSERT INTO material_issue_log
                (po_num, absolute_entry, line_number, item_code, batch_number,
                 quantity, warehouse, operator_name, machine_name, sap_doc_entry, remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING issue_id AS "insertId"`,
            [
                entry.po_num || null,
                entry.absolute_entry != null ? Number(entry.absolute_entry) : null,
                entry.line_number != null ? Number(entry.line_number) : null,
                entry.item_code || null,
                batchNumber,
                quantity,
                entry.warehouse || null,
                entry.operator_name || null,
                entry.machine_name || null,
                entry.sap_doc_entry != null ? String(entry.sap_doc_entry) : null,
                entry.remarks || null
            ]
        );
        return result.insertId;
    } catch (error) {
        console.warn('⚠️ recordMaterialIssue failed (non-blocking):', error.message);
        return null;
    }
}

/** Record many issued batches at once for a PO. Best-effort. */
async function recordMaterialIssues(common, allocations) {
    if (!Array.isArray(allocations) || allocations.length === 0) return 0;
    let count = 0;
    for (const a of allocations) {
        const id = await recordMaterialIssue({
            ...common,
            batch_number: a.batch_number || a.batchNumber || a.batch || a.BatchNumber,
            quantity: a.quantity != null ? a.quantity : a.Quantity,
            sap_doc_entry: a.sap_doc_entry || a.docEntry || common.sap_doc_entry
        });
        if (id) count++;
    }
    return count;
}

/** Insert an issued roll only if the same (po, item, batch, sap doc) is not logged yet. */
async function recordMaterialIssueIfAbsent(entry) {
    try {
        const batchNumber = String(entry.batch_number || '').trim();
        const quantity = Number(entry.quantity) || 0;
        if (!batchNumber || quantity <= 0) return null;

        const [existing] = await pool.query(
            `SELECT issue_id FROM material_issue_log
              WHERE po_num = ? AND item_code = ? AND batch_number = ?
                AND COALESCE(sap_doc_entry, '') = COALESCE(?, '')
              LIMIT 1`,
            [
                entry.po_num || null,
                entry.item_code || null,
                batchNumber,
                entry.sap_doc_entry != null ? String(entry.sap_doc_entry) : null
            ]
        );
        if (existing[0]) {
            // Already logged — ensure it is linked to the output batch.
            if (entry.output_batch) {
                await pool.query(
                    `UPDATE material_issue_log SET output_batch = ?
                      WHERE issue_id = ? AND (output_batch IS NULL OR output_batch = '')`,
                    [String(entry.output_batch), existing[0].issue_id]
                );
            }
            return existing[0].issue_id;
        }

        const [result] = await pool.query(
            `INSERT INTO material_issue_log
                (po_num, absolute_entry, line_number, item_code, batch_number,
                 quantity, warehouse, operator_name, machine_name, sap_doc_entry, output_batch, remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING issue_id AS "insertId"`,
            [
                entry.po_num || null,
                entry.absolute_entry != null ? Number(entry.absolute_entry) : null,
                entry.line_number != null ? Number(entry.line_number) : null,
                entry.item_code || null,
                batchNumber,
                quantity,
                entry.warehouse || null,
                entry.operator_name || null,
                entry.machine_name || null,
                entry.sap_doc_entry != null ? String(entry.sap_doc_entry) : null,
                entry.output_batch || null,
                entry.remarks || null
            ]
        );
        return result.insertId;
    } catch (error) {
        console.warn('⚠️ recordMaterialIssueIfAbsent failed (non-blocking):', error.message);
        return null;
    }
}

/** Link all not-yet-linked issued rolls of a PO to the produced output batch. */
async function linkOutputBatchToIssues(poNum, outputBatch) {
    try {
        const po = String(poNum || '').trim();
        const batch = String(outputBatch || '').trim();
        if (!po || !batch) return 0;
        const [result] = await pool.query(
            `UPDATE material_issue_log
                SET output_batch = ?
              WHERE po_num = ? AND (output_batch IS NULL OR output_batch = '')`,
            [batch, po]
        );
        const n = result.affectedRows || 0;
        if (n > 0) console.log(`   🔗 Linked ${n} issued roll(s) to output batch ${batch} (PO ${po})`);
        return n;
    } catch (error) {
        console.warn('⚠️ linkOutputBatchToIssues failed (non-blocking):', error.message);
        return 0;
    }
}

/** Full traceability for a PO: issued input rolls grouped by output batch. */
async function getTraceabilityByPO(poNum) {
    const [rows] = await pool.query(
        `SELECT issue_id, po_num, line_number, item_code, batch_number, quantity,
                warehouse, operator_name, machine_name, sap_doc_entry, output_batch, issued_at
           FROM material_issue_log
          WHERE po_num = ?
          ORDER BY issued_at ASC, line_number ASC`,
        [String(poNum)]
    );
    return rows;
}

/** Reverse trace: which input rolls produced a given output batch. */
async function getTraceabilityByOutputBatch(outputBatch) {
    const [rows] = await pool.query(
        `SELECT issue_id, po_num, line_number, item_code, batch_number, quantity,
                warehouse, operator_name, machine_name, sap_doc_entry, output_batch, issued_at
           FROM material_issue_log
          WHERE output_batch = ?
          ORDER BY issued_at ASC, line_number ASC`,
        [String(outputBatch)]
    );
    return rows;
}

module.exports = {
    pool,
    testConnection,
    ensureSchema,
    recordMaterialIssue,
    recordMaterialIssues,
    recordMaterialIssueIfAbsent,
    linkOutputBatchToIssues,
    getTraceabilityByPO,
    getTraceabilityByOutputBatch,
    getBatchNum,
    getUnit1BatchNum,
    inferUnit1ProcessTagFromItemCode,
    getUnit1ProcessBatchTag,
    buildUnit1BatchPrefix,
    parseUnit1BatchSeq,
    insertActivityRecord,
    insertJobActivities,
    getActivitiesByBatchNum,
    getBatchesByPO,
    getEmbossingQuantitiesByPO,
    getJobSummary,
    getShiftSummary,
    getActivitiesByMachineAndDate,
    updateActivityRecord,
    updateBatchActivities,
    deleteActivityRecord,
    deleteBatch,
    deleteRecordsByPO,
    markPOLocalReset,
    findRecentDuplicateJobCompletion,
    clearPOLocalReset,
    isPOLocallyReset,
    getBestPerformance
};
