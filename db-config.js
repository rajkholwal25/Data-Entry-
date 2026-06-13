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

    await dedupeMaterialIssueLog();
    try {
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_mil_po_batch
            ON material_issue_log (po_num, batch_number)
        `);
    } catch (e) {
        if (!String(e.message || '').includes('duplicate key')) {
            console.warn('⚠️ Could not create uq_mil_po_batch:', e.message);
        } else {
            await dedupeMaterialIssueLog();
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS uq_mil_po_batch
                ON material_issue_log (po_num, batch_number)
            `);
        }
    }

    // Per-roll consumption at report completion (partial use of issued roles)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS role_batch_usage (
            usage_id           BIGSERIAL PRIMARY KEY,
            po_num             VARCHAR(64) NOT NULL,
            issue_id           BIGINT,
            input_batch_number VARCHAR(80) NOT NULL,
            item_code          VARCHAR(64),
            output_batch       VARCHAR(80),
            quantity_used      NUMERIC NOT NULL DEFAULT 0,
            created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rbu_po ON role_batch_usage (po_num)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rbu_issue ON role_batch_usage (issue_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rbu_output ON role_batch_usage (output_batch)`);
    await pool.query(`
        ALTER TABLE role_batch_usage
        ADD COLUMN IF NOT EXISTS input_type VARCHAR(20) DEFAULT 'raw_roll'
    `);
    await pool.query(`
        ALTER TABLE role_batch_usage
        ADD COLUMN IF NOT EXISTS operator_name VARCHAR(128)
    `);
    await pool.query(`
        ALTER TABLE role_batch_usage
        ADD COLUMN IF NOT EXISTS machine_name VARCHAR(128)
    `);

    try {
        await backfillRoleBatchUsageOperators();
    } catch (_) { /* non-blocking */ }

    console.log('✅ Production schema ready (production_records, material_issue_log, role_batch_usage, views, batch_num_seq)');
}

const GENERIC_OPERATOR_NAMES = new Set(['', 'Operator', 'Unknown']);

function isUsableOperatorName(name) {
    const v = String(name || '').trim();
    return v.length > 0 && !GENERIC_OPERATOR_NAMES.has(v);
}

/** Aggregated completion operator/machine per output batch (one row per batch_num). */
const PR_COMPLETION_SUBQUERY = `
    SELECT batch_num,
           MAX(CASE WHEN operator_name IS NOT NULL
                     AND TRIM(operator_name) NOT IN ('', 'Operator', 'Unknown')
                THEN operator_name END) AS operator_name,
           MAX(CASE WHEN machine_name IS NOT NULL AND TRIM(machine_name) <> ''
                THEN machine_name END) AS machine_name,
           MAX(quantity_processed) AS quantity_processed,
           MAX(fg_num) AS fg_num,
           MAX(process_name) AS process_name,
           MIN(job_start_time) AS job_start_time
      FROM production_records
     GROUP BY batch_num`;

/** Backfill report-completion operator on role_batch_usage from production_records. */
async function backfillRoleBatchUsageOperators(poNum = null) {
    const po = poNum != null ? String(poNum).trim() : '';
    const poClause = po ? 'AND rbu.po_num = ?' : '';
    const params = po ? [po] : [];
    const [result] = await pool.query(
        `UPDATE role_batch_usage rbu
            SET operator_name = COALESCE(
                    NULLIF(TRIM(rbu.operator_name), ''),
                    pr.operator_name
                ),
                machine_name = COALESCE(
                    NULLIF(TRIM(rbu.machine_name), ''),
                    pr.machine_name
                )
           FROM (${PR_COMPLETION_SUBQUERY}) pr
          WHERE pr.batch_num = rbu.output_batch
            AND (
                rbu.operator_name IS NULL OR TRIM(rbu.operator_name) = ''
                OR rbu.operator_name IN ('Operator', 'Unknown')
                OR rbu.machine_name IS NULL OR TRIM(rbu.machine_name) = ''
            )
            ${poClause}`,
        params
    );
    return result.affectedRows || 0;
}

async function resolveCompletionOperatorMeta(outputBatch, completionMeta = {}) {
    let operatorName = completionMeta.operator_name || completionMeta.operatorName || null;
    let machineName = completionMeta.machine_name || completionMeta.machineName || null;
    if ((!isUsableOperatorName(operatorName) || !machineName) && outputBatch) {
        const [rows] = await pool.query(
            `SELECT operator_name, machine_name
               FROM (${PR_COMPLETION_SUBQUERY}) pr
              WHERE pr.batch_num = ?
              LIMIT 1`,
            [String(outputBatch).trim()]
        );
        if (!isUsableOperatorName(operatorName)) {
            operatorName = rows[0]?.operator_name || operatorName;
        }
        if (!machineName) {
            machineName = rows[0]?.machine_name || machineName;
        }
    }
    return { operatorName: operatorName || null, machineName: machineName || null };
}

/** Unit 1 process chain — each step consumes previous step output batches. */
const UNIT1_PROCESS_CHAIN = ['EMB', 'MET', 'COT', 'SLT', 'REW', 'FG'];

function getPreviousUnit1ProcessTag(processTag) {
    const t = String(processTag || '').toUpperCase();
    const i = UNIT1_PROCESS_CHAIN.indexOf(t);
    return i <= 0 ? null : UNIT1_PROCESS_CHAIN[i - 1];
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
    if (u === 'FG' || u.includes('FINISHED')) return 'FG';

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

/**
 * Merge duplicate material_issue_log rows (same PO + batch from app issue + SAP backfill).
 * Keeps earliest issue_id; quantity = MAX across duplicates (not SUM).
 */
async function dedupeMaterialIssueLog(poNum) {
    try {
        const poFilter = poNum != null ? 'WHERE po_num = ?' : '';
        const params = poNum != null ? [String(poNum)] : [];
        const [dupes] = await pool.query(
            `SELECT po_num, batch_number
               FROM material_issue_log
              ${poFilter}
              GROUP BY po_num, batch_number
             HAVING COUNT(*) > 1`,
            params
        );
        if (!dupes.length) return 0;

        let removed = 0;
        for (const d of dupes) {
            const [rows] = await pool.query(
                `SELECT issue_id, quantity, sap_doc_entry, output_batch, remarks,
                        warehouse, operator_name, machine_name, absolute_entry, line_number, item_code
                   FROM material_issue_log
                  WHERE po_num = ? AND batch_number = ?
                  ORDER BY issue_id ASC`,
                [d.po_num, d.batch_number]
            );
            if (rows.length < 2) continue;

            const keeper = rows[0];
            const keeperId = keeper.issue_id;
            let maxQty = Number(keeper.quantity) || 0;
            let sapDoc = keeper.sap_doc_entry;
            let outputBatch = keeper.output_batch;
            let remarks = keeper.remarks;

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                maxQty = Math.max(maxQty, Number(row.quantity) || 0);
                if (!sapDoc && row.sap_doc_entry) sapDoc = row.sap_doc_entry;
                if (!outputBatch && row.output_batch) outputBatch = row.output_batch;
                if ((!remarks || String(remarks).includes('Backfilled')) && row.remarks
                    && !String(row.remarks).includes('Backfilled')) {
                    remarks = row.remarks;
                }
            }

            await pool.query(
                `UPDATE material_issue_log
                    SET quantity = ?,
                        sap_doc_entry = COALESCE(sap_doc_entry, ?),
                        output_batch = COALESCE(NULLIF(output_batch, ''), ?),
                        remarks = COALESCE(?, remarks)
                  WHERE issue_id = ?`,
                [maxQty, sapDoc, outputBatch, remarks, keeperId]
            );

            const dupeIds = rows.slice(1).map((r) => r.issue_id);
            for (const dupeId of dupeIds) {
                await pool.query(
                    `UPDATE role_batch_usage SET issue_id = ? WHERE issue_id = ?`,
                    [keeperId, dupeId]
                );
            }
            const placeholders = dupeIds.map(() => '?').join(',');
            const [del] = await pool.query(
                `DELETE FROM material_issue_log WHERE issue_id IN (${placeholders})`,
                dupeIds
            );
            removed += del.affectedRows || 0;
        }
        if (removed > 0) {
            console.log(`🧹 Deduped material_issue_log: removed ${removed} duplicate row(s)${poNum ? ` for PO ${poNum}` : ''}`);
        }
        return removed;
    } catch (error) {
        console.warn('⚠️ dedupeMaterialIssueLog failed (non-blocking):', error.message);
        return 0;
    }
}

/** Record one issued roll/batch against a PO. Skips duplicate (po, batch). Best-effort; never throws. */
async function recordMaterialIssue(entry) {
    return recordMaterialIssueIfAbsent(entry);
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

/** Upsert one issued roll/batch per (po, batch) — prevents double-count from SAP backfill races. */
async function recordMaterialIssueIfAbsent(entry) {
    try {
        const poNum = entry.po_num != null ? String(entry.po_num).trim() : null;
        const batchNumber = String(entry.batch_number || '').trim();
        const quantity = Number(entry.quantity) || 0;
        if (!poNum || !batchNumber || quantity <= 0) return null;

        const [result] = await pool.query(
            `INSERT INTO material_issue_log
                (po_num, absolute_entry, line_number, item_code, batch_number,
                 quantity, warehouse, operator_name, machine_name, sap_doc_entry, output_batch, remarks)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (po_num, batch_number) DO UPDATE SET
                quantity = GREATEST(material_issue_log.quantity, EXCLUDED.quantity),
                sap_doc_entry = COALESCE(material_issue_log.sap_doc_entry, EXCLUDED.sap_doc_entry),
                output_batch = COALESCE(NULLIF(material_issue_log.output_batch, ''), EXCLUDED.output_batch),
                warehouse = COALESCE(material_issue_log.warehouse, EXCLUDED.warehouse),
                operator_name = COALESCE(material_issue_log.operator_name, EXCLUDED.operator_name),
                machine_name = COALESCE(material_issue_log.machine_name, EXCLUDED.machine_name),
                absolute_entry = COALESCE(material_issue_log.absolute_entry, EXCLUDED.absolute_entry),
                line_number = COALESCE(material_issue_log.line_number, EXCLUDED.line_number),
                item_code = COALESCE(material_issue_log.item_code, EXCLUDED.item_code),
                remarks = CASE
                    WHEN material_issue_log.remarks IS NULL OR material_issue_log.remarks LIKE '%Backfilled%'
                    THEN EXCLUDED.remarks ELSE material_issue_log.remarks END
             RETURNING issue_id AS "insertId"`,
            [
                poNum,
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
        if (String(error.message || '').includes('uq_mil_po_batch')
            || String(error.message || '').includes('duplicate key')) {
            await dedupeMaterialIssueLog(entry.po_num);
            return recordMaterialIssueIfAbsent(entry);
        }
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

/** Issued input rolls for a PO with remaining qty (one row per batch; issued − prior completions). */
async function getIssuedRolesWithRemaining(poNum) {
    const po = String(poNum);
    const [rows] = await pool.query(
        `SELECT MIN(mil.issue_id) AS issue_id,
                mil.batch_number,
                MAX(mil.item_code) AS item_code,
                COALESCE(MAX(mil.quantity), 0) AS issued_qty,
                MAX(mil.warehouse) AS warehouse,
                MIN(mil.issued_at) AS issued_at,
                COALESCE((
                    SELECT SUM(rbu.quantity_used)
                      FROM role_batch_usage rbu
                     WHERE rbu.po_num = mil.po_num
                       AND (
                           rbu.input_batch_number = mil.batch_number
                           OR rbu.issue_id IN (
                               SELECT mil2.issue_id
                                 FROM material_issue_log mil2
                                WHERE mil2.po_num = mil.po_num
                                  AND mil2.batch_number = mil.batch_number
                           )
                       )
                ), 0) AS used_qty
           FROM material_issue_log mil
          WHERE mil.po_num = ?
          GROUP BY mil.po_num, mil.batch_number
          ORDER BY MIN(mil.issued_at) ASC NULLS LAST, MIN(mil.issue_id) ASC`,
        [po]
    );
    return rows.map((r) => {
        const issued = Number(r.issued_qty) || 0;
        const used = Number(r.used_qty) || 0;
        return {
            issue_id: r.issue_id,
            batch_number: r.batch_number,
            item_code: r.item_code,
            issued_qty: issued,
            used_qty: used,
            remaining_qty: Math.max(0, issued - used),
            warehouse: r.warehouse,
            issued_at: r.issued_at
        };
    });
}

/** Record roll/batch consumption for one report completion (source of truth for traceability). */
async function recordRoleBatchUsages(poNum, outputBatch, usages, completionMeta = {}) {
    if (!Array.isArray(usages) || usages.length === 0) return 0;
    const { operatorName, machineName } = await resolveCompletionOperatorMeta(outputBatch, completionMeta);
    let count = 0;
    for (const u of usages) {
        const qty = Number(u.quantity_used ?? u.quantityUsed) || 0;
        const batch = String(u.batch_number ?? u.batchNumber ?? '').trim();
        if (!batch || qty <= 0) continue;
        const inputType = String(u.input_type || u.inputType || '').trim()
            || (u.issue_id != null && Number.isFinite(Number(u.issue_id)) ? 'raw_roll' : 'process_batch');
        const issueId = inputType === 'raw_roll' && u.issue_id != null ? Number(u.issue_id) : null;
        await pool.query(
            `INSERT INTO role_batch_usage
                (po_num, issue_id, input_batch_number, item_code, output_batch,
                 quantity_used, input_type, operator_name, machine_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                String(poNum),
                issueId,
                batch,
                u.item_code || u.itemCode || null,
                outputBatch || null,
                qty,
                inputType,
                operatorName,
                machineName
            ]
        );
        count++;
    }
    return count;
}

/** Link specific issued rolls to an output batch (traceability). */
async function linkIssuesToOutputBatch(issueIds, outputBatch) {
    const batch = String(outputBatch || '').trim();
    if (!batch || !Array.isArray(issueIds) || issueIds.length === 0) return 0;
    const ids = issueIds.map((id) => Number(id)).filter((id) => id > 0);
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await pool.query(
        `UPDATE material_issue_log
            SET output_batch = ?
          WHERE issue_id IN (${placeholders})
            AND (output_batch IS NULL OR output_batch = '')`,
        [batch, ...ids]
    );
    return result.affectedRows || 0;
}

/** PO that produced this output batch (report completion on that PO). */
async function getOutputBatchOwnerPO(outputBatch) {
    const batch = String(outputBatch || '').trim();
    if (!batch) return null;
    const [prodRows] = await pool.query(
        `SELECT po_num, process_name
           FROM production_records
          WHERE batch_num = ?
          ORDER BY job_end_time DESC NULLS LAST, unique_id DESC
          LIMIT 1`,
        [batch]
    );
    if (prodRows[0]?.po_num) {
        return {
            poNum: String(prodRows[0].po_num).trim(),
            processName: prodRows[0].process_name || null
        };
    }
    const [rbuRows] = await pool.query(
        `SELECT po_num FROM role_batch_usage
          WHERE output_batch = ?
          GROUP BY po_num
          ORDER BY MAX(created_at) DESC NULLS LAST
          LIMIT 1`,
        [batch]
    );
    if (rbuRows[0]?.po_num) {
        return { poNum: String(rbuRows[0].po_num).trim(), processName: null };
    }
    return null;
}

/** True only when this output batch was produced on the given PO. */
async function outputBatchBelongsToPO(poNum, outputBatch) {
    const owner = await getOutputBatchOwnerPO(outputBatch);
    if (!owner?.poNum) return false;
    return String(poNum || '').trim() === owner.poNum;
}

/** Inputs consumed to produce an output batch (from report completion only). */
async function getGenealogyByOutputBatch(outputBatch, poNum = null) {
    const batch = String(outputBatch || '').trim();
    if (!batch) return [];
    const po = poNum != null ? String(poNum).trim() : '';
    const params = po ? [batch, po] : [batch];
    const poClause = po ? ' AND rbu.po_num = ?' : '';
    const [rows] = await pool.query(
        `SELECT rbu.usage_id,
                rbu.po_num,
                rbu.input_batch_number AS batch_number,
                rbu.item_code,
                rbu.quantity_used AS quantity,
                rbu.input_type,
                rbu.created_at AS used_at,
                rbu.operator_name AS usage_operator,
                rbu.machine_name AS usage_machine,
                mil.warehouse,
                mil.operator_name AS issue_operator,
                mil.machine_name AS issue_machine,
                mil.issued_at,
                pr_out.operator_name AS completion_operator,
                pr_out.machine_name AS completion_machine
           FROM role_batch_usage rbu
           LEFT JOIN material_issue_log mil
                  ON mil.issue_id = rbu.issue_id
           LEFT JOIN (${PR_COMPLETION_SUBQUERY}) pr_out
                  ON pr_out.batch_num = rbu.output_batch
          WHERE rbu.output_batch = ?${poClause}
          ORDER BY rbu.created_at ASC, rbu.usage_id ASC`,
        params
    );
    return rows.map((r) => ({
        output_batch: batch,
        batch_number: r.batch_number,
        item_code: r.item_code,
        quantity: Number(r.quantity) || 0,
        input_type: r.input_type || 'raw_roll',
        used_at: r.used_at,
        warehouse: r.warehouse || null,
        operator_name: r.usage_operator || r.completion_operator || r.issue_operator || null,
        machine_name: r.usage_machine || r.completion_machine || r.issue_machine || null,
        issued_at: r.issued_at || null,
        po_num: r.po_num
    }));
}

/** All output batches for a PO with their consumed inputs (report completion links only). */
async function getGenealogyByPO(poNum) {
    const po = String(poNum || '').trim();
    if (!po) return [];
    const [rows] = await pool.query(
        `SELECT rbu.output_batch,
                rbu.input_batch_number AS batch_number,
                rbu.item_code,
                rbu.quantity_used AS quantity,
                rbu.input_type,
                rbu.created_at AS used_at,
                rbu.operator_name AS usage_operator,
                rbu.machine_name AS usage_machine,
                mil.warehouse,
                mil.operator_name AS issue_operator,
                mil.machine_name AS issue_machine,
                mil.issued_at,
                pr_out.operator_name AS completion_operator,
                pr_out.machine_name AS completion_machine
           FROM role_batch_usage rbu
           LEFT JOIN material_issue_log mil ON mil.issue_id = rbu.issue_id
           LEFT JOIN (${PR_COMPLETION_SUBQUERY}) pr_out ON pr_out.batch_num = rbu.output_batch
          WHERE rbu.po_num = ?
          ORDER BY rbu.output_batch ASC NULLS LAST, rbu.created_at ASC`,
        [po]
    );
    return rows.map((r) => ({
        output_batch: r.output_batch,
        batch_number: r.batch_number,
        item_code: r.item_code,
        quantity: Number(r.quantity) || 0,
        input_type: r.input_type || 'raw_roll',
        used_at: r.used_at,
        warehouse: r.warehouse || null,
        operator_name: r.usage_operator || r.completion_operator || r.issue_operator || null,
        machine_name: r.usage_machine || r.completion_machine || r.issue_machine || null,
        issued_at: r.issued_at || null
    }));
}

/** @deprecated Use getGenealogyByOutputBatch — material_issue_log.output_batch is not authoritative. */
async function getTraceabilityByOutputBatch(outputBatch) {
    return getGenealogyByOutputBatch(outputBatch);
}

/** @deprecated Use getGenealogyByPO */
async function getTraceabilityByPO(poNum) {
    return getGenealogyByPO(poNum);
}

/** PO-level trace summary: all issued input batches + output batches with usage from report completion. */
async function getPOTraceabilitySummary(poNum, options = {}) {
    const po = String(poNum || '').trim();
    if (!po) {
        return { poNum: po, inputBatches: [], outputBatches: [], genealogy: [] };
    }

    try {
        await backfillRoleBatchUsageOperators(po);
    } catch (_) { /* non-blocking */ }

    let fgItemCode = options.fgItemCode || options.fg_num || null;
    if (!fgItemCode) {
        try {
            const [fgRows] = await pool.query(
                `SELECT fg_num FROM production_records
                  WHERE po_num = ? AND fg_num IS NOT NULL AND TRIM(fg_num) <> ''
                  ORDER BY job_start_time DESC NULLS LAST
                  LIMIT 1`,
                [po]
            );
            fgItemCode = fgRows[0]?.fg_num || null;
        } catch (_) { /* non-blocking */ }
    }
    const processTag = String(
        options.processTag || options.process_tag || inferUnit1ProcessTagFromItemCode(fgItemCode) || ''
    ).toUpperCase();
    const prevTag = processTag ? getPreviousUnit1ProcessTag(processTag) : null;

    const [genealogyRows, issuedRows, prevProcessInputs] = await Promise.all([
        getGenealogyByPO(po),
        getIssuedRolesWithRemaining(po),
        prevTag ? getPreviousProcessOutputBatches(po, prevTag, fgItemCode) : Promise.resolve([])
    ]);

    const inputMap = new Map();
    const outputMap = new Map();

    const issuedBatchKeys = new Set();
    for (const iss of issuedRows) {
        const inKey = iss.batch_number;
        if (!inKey || inputMap.has(inKey)) continue;
        issuedBatchKeys.add(inKey);
        const isProcessBatch = prevTag && String(inKey).includes(`-${prevTag}-`);
        inputMap.set(inKey, {
            batchNumber: inKey,
            itemCode: iss.item_code,
            inputType: isProcessBatch ? 'process_batch' : 'raw_roll',
            warehouse: iss.warehouse,
            issuedQty: Number(iss.issued_qty) || 0,
            totalQtyUsed: Number(iss.used_qty) || 0,
            remainingQty: Number(iss.remaining_qty) || 0,
            issuedAt: iss.issued_at,
            sourcePoNum: null,
            usedInOutputs: new Set()
        });
    }

    for (const prev of prevProcessInputs) {
        const inKey = prev.batch_number;
        if (!inKey) continue;
        if (inputMap.has(inKey)) {
            const inp = inputMap.get(inKey);
            const issuedQty = Math.max(Number(inp.issuedQty) || 0, Number(prev.issued_qty) || 0);
            inp.issuedQty = issuedQty;
            inp.remainingQty = Math.max(0, issuedQty - (Number(inp.totalQtyUsed) || 0));
            inp.inputType = 'process_batch';
            inp.sourcePoNum = prev.source_po_num || inp.sourcePoNum;
            if (!inp.itemCode) inp.itemCode = prev.item_code;
            if (!inp.issuedAt) inp.issuedAt = prev.issued_at;
            continue;
        }
        issuedBatchKeys.add(inKey);
        inputMap.set(inKey, {
            batchNumber: inKey,
            itemCode: prev.item_code,
            inputType: 'process_batch',
            warehouse: null,
            issuedQty: Number(prev.issued_qty) || 0,
            totalQtyUsed: Number(prev.used_qty) || 0,
            remainingQty: Number(prev.remaining_qty) || 0,
            issuedAt: prev.issued_at,
            sourcePoNum: prev.source_po_num,
            usedInOutputs: new Set()
        });
    }

    for (const r of genealogyRows) {
        const inKey = r.batch_number;
        const fromIssueLog = issuedBatchKeys.has(inKey);
        if (!inputMap.has(inKey)) {
            inputMap.set(inKey, {
                batchNumber: r.batch_number,
                itemCode: r.item_code,
                inputType: r.input_type || 'raw_roll',
                warehouse: r.warehouse,
                issuedQty: null,
                totalQtyUsed: 0,
                remainingQty: null,
                issuedAt: r.issued_at || null,
                usedInOutputs: new Set()
            });
        }
        const inp = inputMap.get(inKey);
        if (!fromIssueLog) {
            inp.totalQtyUsed += Number(r.quantity) || 0;
        }
        if (r.output_batch) inp.usedInOutputs.add(r.output_batch);
        if (!inp.itemCode && r.item_code) inp.itemCode = r.item_code;
        if (!inp.warehouse && r.warehouse) inp.warehouse = r.warehouse;
        if (!inp.issuedAt && r.issued_at) inp.issuedAt = r.issued_at;
        if (r.input_type === 'process_batch') inp.inputType = 'process_batch';

        const outKey = r.output_batch;
        if (!outKey) continue;
        if (!outputMap.has(outKey)) {
            outputMap.set(outKey, {
                outputBatch: outKey,
                inputs: [],
                totalInputQty: 0,
                inputCount: 0
            });
        }
        const out = outputMap.get(outKey);
        out.inputs.push({
            batchNumber: r.batch_number,
            itemCode: r.item_code,
            quantity: Number(r.quantity) || 0,
            inputType: r.input_type || 'raw_roll',
            warehouse: r.warehouse,
            operator: r.operator_name,
            machine: r.machine_name,
            usedAt: r.used_at
        });
        out.totalInputQty += Number(r.quantity) || 0;
        out.inputCount = out.inputs.length;
    }

    const [prodRows] = await pool.query(
        `SELECT batch_num, quantity_processed, fg_num, job_start_time,
                operator_name, machine_name, process_name
           FROM (${PR_COMPLETION_SUBQUERY}) pr
          WHERE batch_num IN (
              SELECT DISTINCT batch_num FROM production_records WHERE po_num = ?
          )
          ORDER BY batch_num ASC`,
        [po]
    );
    for (const pr of prodRows) {
        const bn = pr.batch_num;
        if (!bn) continue;
        const completionOperator = isUsableOperatorName(pr.operator_name) ? pr.operator_name : null;
        const completionMachine = pr.machine_name || null;
        if (!outputMap.has(bn)) {
            outputMap.set(bn, {
                outputBatch: bn,
                inputs: [],
                totalInputQty: 0,
                inputCount: 0,
                outputQty: Number(pr.quantity_processed) || 0,
                itemCode: pr.fg_num,
                producedAt: pr.job_start_time,
                completionOperator,
                completionMachine,
                processName: pr.process_name || null,
                noInputsRecorded: true
            });
        } else {
            const o = outputMap.get(bn);
            o.outputQty = Number(pr.quantity_processed) || 0;
            o.itemCode = pr.fg_num;
            o.producedAt = pr.job_start_time;
            o.completionOperator = completionOperator || o.completionOperator;
            o.completionMachine = completionMachine || o.completionMachine;
            o.noInputsRecorded = o.inputs.length === 0;
        }
    }

    const inputBatches = Array.from(inputMap.values())
        .map((i) => {
            const issuedQty = i.issuedQty != null ? Number(i.issuedQty) : null;
            const totalQtyUsed = Number(i.totalQtyUsed) || 0;
            const remainingQty = i.remainingQty != null
                ? Number(i.remainingQty)
                : (issuedQty != null ? Math.max(0, issuedQty - totalQtyUsed) : null);
            let usageStatus = 'unused';
            if (totalQtyUsed > 0 && (remainingQty == null || remainingQty <= 0)) usageStatus = 'used';
            else if (totalQtyUsed > 0) usageStatus = 'partial';
            else if (issuedQty != null) usageStatus = 'issued';
            return {
                batchNumber: i.batchNumber,
                itemCode: i.itemCode,
                inputType: i.inputType,
                warehouse: i.warehouse,
                sourcePoNum: i.sourcePoNum || null,
                issuedQty,
                totalQtyUsed,
                remainingQty,
                issuedAt: i.issuedAt || null,
                usageStatus,
                usedInOutputs: Array.from(i.usedInOutputs).sort()
            };
        })
        .sort((a, b) => {
            const ta = a.issuedAt ? new Date(a.issuedAt).getTime() : 0;
            const tb = b.issuedAt ? new Date(b.issuedAt).getTime() : 0;
            if (ta !== tb) return ta - tb;
            return String(a.batchNumber).localeCompare(String(b.batchNumber));
        });

    const finalizedInputMeta = new Map();
    for (const [key, i] of inputMap.entries()) {
        const issuedQty = i.issuedQty != null ? Number(i.issuedQty) : null;
        const totalQtyUsed = Number(i.totalQtyUsed) || 0;
        const remainingQty = i.remainingQty != null
            ? Number(i.remainingQty)
            : (issuedQty != null ? Math.max(0, issuedQty - totalQtyUsed) : null);
        finalizedInputMeta.set(key, { issuedQty, remainingQty, sourcePoNum: i.sourcePoNum || null });
    }

    const outputBatches = Array.from(outputMap.values())
        .map((out) => {
            for (const inp of out.inputs) {
                const meta = finalizedInputMeta.get(inp.batchNumber);
                if (meta) {
                    inp.issuedQty = meta.issuedQty;
                    inp.remainingQty = meta.remainingQty;
                    inp.sourcePoNum = meta.sourcePoNum;
                }
                if (!inp.operator && out.completionOperator) {
                    inp.operator = out.completionOperator;
                }
                if (!inp.machine && out.completionMachine) {
                    inp.machine = out.completionMachine;
                }
            }
            return out;
        })
        .sort((a, b) => String(a.outputBatch).localeCompare(String(b.outputBatch)));

    const groups = {};
    for (const r of genealogyRows) {
        const key = r.output_batch || '__pending__';
        if (!groups[key]) {
            groups[key] = { outputBatch: r.output_batch || null, inputs: [], totalQty: 0 };
        }
        groups[key].inputs.push({
            itemCode: r.item_code,
            batchNumber: r.batch_number,
            quantity: Number(r.quantity) || 0,
            inputType: r.input_type || 'raw_roll',
            warehouse: r.warehouse,
            operator: r.operator_name,
            machine: r.machine_name,
            usedAt: r.used_at,
            issuedAt: r.issued_at
        });
        groups[key].totalQty += Number(r.quantity) || 0;
    }

    return {
        poNum: po,
        inputBatches,
        outputBatches,
        count: genealogyRows.length,
        genealogy: Object.values(groups)
    };
}

/** Build LIKE pattern for previous-process output batches (e.g. PET-…-HF-EMB-%). */
function buildPrevProcessBatchPattern(fgItemCode, prevTag) {
    const prev = String(prevTag || '').trim().toUpperCase();
    if (!prev) return null;
    const code = String(fgItemCode || '').trim().toUpperCase();
    if (code) {
        const curTag = inferUnit1ProcessTagFromItemCode(code);
        const base = curTag && code.endsWith(`-${curTag}`)
            ? code.slice(0, -(curTag.length + 1))
            : code.replace(/-(EMB|MET|MTL|COT|SLT|REW)$/i, '');
        if (base) return `${base}-${prev}-%`;
    }
    return `%-${prev}-%`;
}

/**
 * Previous-process output batches for a PO chain (753 EMB outputs → inputs for 754 MET).
 * Sourced from production_records on the source PO(s), not the current PO.
 */
async function getPreviousProcessOutputBatches(poNum, prevTag, fgItemCode) {
    const po = String(poNum || '').trim();
    const pattern = buildPrevProcessBatchPattern(fgItemCode, prevTag);
    if (!po || !pattern) return [];

    const [rows] = await pool.query(
        `SELECT pr.batch_num AS batch_number,
                MAX(pr.fg_num) AS item_code,
                MAX(pr.quantity_processed) AS output_qty,
                MIN(pr.job_start_time) AS produced_at,
                MAX(pr.po_num) AS source_po_num,
                MAX(CASE WHEN pr.operator_name IS NOT NULL
                          AND TRIM(pr.operator_name) NOT IN ('', 'Operator', 'Unknown')
                     THEN pr.operator_name END) AS producer_operator,
                MAX(CASE WHEN pr.machine_name IS NOT NULL AND TRIM(pr.machine_name) <> ''
                     THEN pr.machine_name END) AS producer_machine
           FROM production_records pr
          WHERE pr.batch_num LIKE ?
          GROUP BY pr.batch_num
          ORDER BY pr.batch_num ASC`,
        [pattern]
    );

    const results = [];
    for (const r of rows) {
        const issued = Number(r.output_qty) || 0;
        if (issued <= 0) continue;
        const [usedRows] = await pool.query(
            `SELECT COALESCE(SUM(quantity_used), 0) AS used_qty
               FROM role_batch_usage
              WHERE po_num = ?
                AND input_batch_number = ?`,
            [po, r.batch_number]
        );
        const used = Number(usedRows[0]?.used_qty) || 0;
        results.push({
            issue_id: r.batch_number,
            batch_number: r.batch_number,
            item_code: r.item_code,
            issued_qty: issued,
            used_qty: used,
            remaining_qty: Math.max(0, issued - used),
            input_type: 'process_batch',
            source_batch: r.batch_number,
            source_po_num: r.source_po_num,
            issued_at: r.produced_at,
            producer_operator: r.producer_operator || null,
            producer_machine: r.producer_machine || null
        });
    }
    return results;
}

async function mergeProcessInputSources(poNum, prevTag, fgItemCode) {
    const po = String(poNum || '').trim();
    const issuedRows = await getIssuedRolesWithRemaining(po);
    const prevOutputs = await getPreviousProcessOutputBatches(po, prevTag, fgItemCode);
    const byBatch = new Map();

    for (const r of issuedRows) {
        const isProcess = String(r.batch_number || '').includes(`-${prevTag}-`)
            || !String(r.batch_number || '').toUpperCase().startsWith('PMI');
        byBatch.set(r.batch_number, {
            ...r,
            input_type: isProcess ? 'process_batch' : 'raw_roll',
            source_batch: r.batch_number,
            source_po_num: null
        });
    }

    for (const r of prevOutputs) {
        const existing = byBatch.get(r.batch_number);
        if (!existing) {
            byBatch.set(r.batch_number, r);
            continue;
        }
        const issuedQty = Math.max(Number(existing.issued_qty) || 0, Number(r.issued_qty) || 0);
        const usedQty = Math.max(Number(existing.used_qty) || 0, Number(r.used_qty) || 0);
        byBatch.set(r.batch_number, {
            ...existing,
            issued_qty: issuedQty,
            used_qty: usedQty,
            remaining_qty: Math.max(0, issuedQty - usedQty),
            input_type: 'process_batch',
            source_po_num: r.source_po_num || existing.source_po_num,
            item_code: existing.item_code || r.item_code
        });
    }

    return Array.from(byBatch.values()).sort((a, b) => {
        const ta = a.issued_at ? new Date(a.issued_at).getTime() : 0;
        const tb = b.issued_at ? new Date(b.issued_at).getTime() : 0;
        if (ta !== tb) return ta - tb;
        return String(a.batch_number).localeCompare(String(b.batch_number));
    });
}

/**
 * Inputs available for report completion: raw rolls (EMB) or previous-process output
 * batches issued/auto-issued to this PO (754 ← 753 EMB-001, EMB-002, …).
 */
async function getProcessInputsWithRemaining(poNum, currentProcessTag, fgItemCode) {
    const po = String(poNum || '').trim();
    const tag = String(currentProcessTag || 'EMB').toUpperCase();
    const prevTag = getPreviousUnit1ProcessTag(tag);

    if (!prevTag) {
        const rows = await getIssuedRolesWithRemaining(po);
        return rows.map((r) => ({
            ...r,
            input_type: 'raw_roll',
            source_batch: r.batch_number
        }));
    }

    return mergeProcessInputSources(po, prevTag, fgItemCode);
}

module.exports = {
    pool,
    testConnection,
    ensureSchema,
    recordMaterialIssue,
    recordMaterialIssues,
    recordMaterialIssueIfAbsent,
    dedupeMaterialIssueLog,
    linkOutputBatchToIssues,
    linkIssuesToOutputBatch,
    getIssuedRolesWithRemaining,
    getProcessInputsWithRemaining,
    getPreviousProcessOutputBatches,
    mergeProcessInputSources,
    buildPrevProcessBatchPattern,
    getPreviousUnit1ProcessTag,
    recordRoleBatchUsages,
    backfillRoleBatchUsageOperators,
    resolveCompletionOperatorMeta,
    getGenealogyByPO,
    getGenealogyByOutputBatch,
    getOutputBatchOwnerPO,
    outputBatchBelongsToPO,
    getPOTraceabilitySummary,
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
