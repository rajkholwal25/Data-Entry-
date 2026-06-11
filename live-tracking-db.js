// ============================================================================
// Live Tracking DB module
// ----------------------------------------------------------------------------
// Persists per-machine live data so a central dashboard can be built:
//   - operator login / logout per shift           -> machine_shift_sessions
//   - current loaded job + state per machine       -> machine_status
//   - full timeline of machine states (durations)  -> machine_state_history
//
// All times are stored in server local time (assumed IST) as
// 'YYYY-MM-DD HH:MM:SS' to stay consistent with the rest of the app.
// ============================================================================
const { pool } = require('./db-config');

// Known machine states (documentation / dashboard legend). 'idle' = logged in /
// job loaded but not started. 'offline' = no operator logged in.
// NOTE: data-entry machines use many more states (cleaning, waiting_qc,
// line_clearance, ...), so setState() validates the FORMAT of the token rather
// than restricting to this list.
const VALID_STATES = [
    'idle', 'running', 'makeready',
    'downtime_mech', 'downtime_elec',
    'feeder_trip', 'sticky_sheets', 'sorting_waiting',
    'cleaning', 'waiting_qc', 'waiting_die', 'waiting_input', 'line_clearance',
    'lunch', 'offline'
];

const STATE_TOKEN_RE = /^[a-z][a-z0-9_]{0,31}$/i;

// ----------------------------------------------------------------------------
// Time helpers (server local time, formatted for MySQL DATETIME)
// ----------------------------------------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }

function nowMySQL(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateStr(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Day shift: 09:00–20:00, Night shift: 20:00–09:00 (matches the rest of the app).
// For night-shift hours after midnight (00:00–08:59) the shift belongs to the
// PREVIOUS calendar day.
function currentShift(d = new Date()) {
    const h = d.getHours();
    if (h >= 9 && h < 20) {
        return { type: 'day', date: dateStr(d) };
    }
    const base = new Date(d);
    if (h < 9) base.setDate(base.getDate() - 1);
    return { type: 'night', date: dateStr(base) };
}

// When does a given shift end? Used by the auto-logout sweeper.
function shiftEndTime(shiftType, shiftDateStr) {
    const [y, m, day] = shiftDateStr.split('-').map(Number);
    if (shiftType === 'day') {
        // ends at 20:00 of the shift date
        return new Date(y, m - 1, day, 20, 0, 0, 0);
    }
    // night ends at 09:00 of the NEXT day
    return new Date(y, m - 1, day + 1, 9, 0, 0, 0);
}

// ----------------------------------------------------------------------------
// Schema creation (idempotent)
// ----------------------------------------------------------------------------
async function ensureTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS machine_shift_sessions (
            session_id     BIGSERIAL PRIMARY KEY,
            machine_id     VARCHAR(64)  NOT NULL,
            machine_name   VARCHAR(128),
            category       VARCHAR(32),
            process        VARCHAR(64),
            operator_name  VARCHAR(128) NOT NULL,
            shift_type     VARCHAR(8) NOT NULL,
            shift_date     DATE NOT NULL,
            login_time     TIMESTAMP NOT NULL,
            logout_time    TIMESTAMP,
            logout_reason  VARCHAR(32),
            device_id      VARCHAR(64),
            status         VARCHAR(8) NOT NULL DEFAULT 'active',
            created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mss_machine_status ON machine_shift_sessions (machine_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mss_shift ON machine_shift_sessions (shift_date, shift_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mss_operator ON machine_shift_sessions (operator_name)`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS machine_status (
            machine_id          VARCHAR(64) PRIMARY KEY,
            machine_name        VARCHAR(128),
            category            VARCHAR(32),
            process             VARCHAR(64),
            current_session_id  BIGINT,
            current_operator    VARCHAR(128),
            shift_type          VARCHAR(8),
            shift_date          DATE,
            is_online           SMALLINT NOT NULL DEFAULT 0,
            current_job_po      VARCHAR(64),
            current_job_name    VARCHAR(255),
            current_fg_num      VARCHAR(64),
            job_planned_qty     INTEGER,
            job_loaded_at       TIMESTAMP,
            current_state       VARCHAR(32),
            state_started_at    TIMESTAMP,
            last_event_at       TIMESTAMP,
            updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS machine_state_history (
            id               BIGSERIAL PRIMARY KEY,
            machine_id       VARCHAR(64) NOT NULL,
            machine_name     VARCHAR(128),
            session_id       BIGINT,
            operator_name    VARCHAR(128),
            shift_type       VARCHAR(8),
            shift_date       DATE,
            job_po           VARCHAR(64),
            job_name         VARCHAR(255),
            state            VARCHAR(32) NOT NULL,
            started_at       TIMESTAMP NOT NULL,
            ended_at         TIMESTAMP,
            duration_seconds INTEGER
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msh_machine ON machine_state_history (machine_id, started_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msh_open ON machine_state_history (machine_id, ended_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msh_session ON machine_state_history (session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msh_shift ON machine_state_history (shift_date, shift_type)`);

    console.log('✅ Live tracking tables ready (machine_shift_sessions, machine_status, machine_state_history)');
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------
async function getStatusRow(machineId) {
    const [rows] = await pool.query('SELECT * FROM machine_status WHERE machine_id = ?', [machineId]);
    return rows[0] || null;
}

// Close the currently-open state-history row for a machine (sets ended_at + duration).
async function closeOpenHistory(machineId, endTime) {
    await pool.query(
        `UPDATE machine_state_history
            SET ended_at = ?, duration_seconds = EXTRACT(EPOCH FROM (?::timestamp - started_at))::int
          WHERE machine_id = ? AND ended_at IS NULL`,
        [endTime, endTime, machineId]
    );
}

// Upsert the machine_status row with a partial set of fields.
async function upsertStatus(machineId, fields) {
    // Always refresh updated_at (Postgres has no MySQL-style ON UPDATE clause).
    const merged = { ...fields, updated_at: nowMySQL() };
    const cols = Object.keys(merged);
    const vals = cols.map(c => merged[c]);

    const insertCols = ['machine_id', ...cols].join(', ');
    const insertPlaceholders = ['?', ...cols.map(() => '?')].join(', ');
    const updateClause = cols.map(c => `${c} = EXCLUDED.${c}`).join(', ');

    await pool.query(
        `INSERT INTO machine_status (${insertCols}) VALUES (${insertPlaceholders})
         ON CONFLICT (machine_id) DO UPDATE SET ${updateClause}`,
        [machineId, ...vals]
    );
}

// Record a state transition: finalize the previous open history row, open a new
// one (unless going offline), and update machine_status.
async function recordState(machineId, newState, ctx = {}) {
    const ts = nowMySQL();
    await closeOpenHistory(machineId, ts);

    const status = await getStatusRow(machineId);

    const sessionId = ctx.sessionId != null ? ctx.sessionId : (status ? status.current_session_id : null);
    const operator = ctx.operator != null ? ctx.operator : (status ? status.current_operator : null);
    const shift = currentShift();
    const jobPo = ctx.jobPo !== undefined ? ctx.jobPo : (status ? status.current_job_po : null);
    const jobName = ctx.jobName !== undefined ? ctx.jobName : (status ? status.current_job_name : null);

    if (newState && newState !== 'offline') {
        await pool.query(
            `INSERT INTO machine_state_history
                (machine_id, machine_name, session_id, operator_name, shift_type, shift_date,
                 job_po, job_name, state, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [machineId, ctx.machineName || (status && status.machine_name) || null,
                sessionId, operator, shift.type, shift.date,
                jobPo, jobName, newState, ts]
        );
    }

    await upsertStatus(machineId, {
        current_state: newState,
        state_started_at: (newState && newState !== 'offline') ? ts : null,
        last_event_at: ts
    });

    return ts;
}

// ----------------------------------------------------------------------------
// Public operations
// ----------------------------------------------------------------------------

// Operator selects a machine and marks it online for the shift.
//
// We keep ONE session row per (machine, shift): the FIRST login of the shift
// sets login_time + operator_name, and the LAST logout sets logout_time.
// Re-selecting the machine or re-logging-in during the same shift reuses /
// reactivates that same row instead of creating a new one.
async function login({ machineId, machineName, category, process, operator, deviceId }) {
    if (!machineId || !operator) {
        throw new Error('machineId and operator are required');
    }
    const ts = nowMySQL();
    const shift = currentShift();

    // Look for an existing session for this machine in the current shift.
    const [existing] = await pool.query(
        `SELECT * FROM machine_shift_sessions
          WHERE machine_id = ? AND shift_type = ? AND shift_date = ?
          ORDER BY login_time ASC LIMIT 1`,
        [machineId, shift.type, shift.date]
    );

    let sessionId;
    let firstLoginTime = ts;
    let firstLoginOperator = operator;
    const reused = existing.length > 0;

    if (reused) {
        const sess = existing[0];
        sessionId = sess.session_id;
        firstLoginTime = sess.login_time;
        firstLoginOperator = sess.operator_name; // preserve the shift's first operator
        // Reactivate (clears any earlier logout) but keep the first login_time.
        await pool.query(
            `UPDATE machine_shift_sessions
                SET status = 'active', logout_time = NULL, logout_reason = NULL,
                    machine_name = COALESCE(machine_name, ?),
                    category = COALESCE(category, ?),
                    process  = COALESCE(process, ?)
              WHERE session_id = ?`,
            [machineName || null, category || null, process || null, sessionId]
        );
    } else {
        const [result] = await pool.query(
            `INSERT INTO machine_shift_sessions
                (machine_id, machine_name, category, process, operator_name,
                 shift_type, shift_date, login_time, device_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
             RETURNING session_id AS "insertId"`,
            [machineId, machineName || null, category || null, process || null, operator,
                shift.type, shift.date, ts, deviceId || null]
        );
        sessionId = result.insertId;
    }

    const statusFields = {
        current_session_id: sessionId,
        current_operator: operator,   // live current operator on the machine
        shift_type: shift.type,
        shift_date: shift.date,
        is_online: 1,
        last_event_at: ts
    };
    // Only set identity columns when provided so a partial update never wipes them.
    if (machineName) statusFields.machine_name = machineName;
    if (category) statusFields.category = category;
    if (process) statusFields.process = process;
    await upsertStatus(machineId, statusFields);

    // Start an "idle" state segment for the dashboard timeline.
    await recordState(machineId, 'idle', { sessionId, operator, machineName });

    return { sessionId, machineId, operator, firstLoginOperator, firstLoginTime, shift, reused };
}

// Operator logs out (manual button or auto at shift end).
async function logout({ machineId, reason }) {
    if (!machineId) throw new Error('machineId is required');
    const ts = nowMySQL();

    await pool.query(
        `UPDATE machine_shift_sessions
            SET status = 'closed', logout_time = ?, logout_reason = ?
          WHERE machine_id = ? AND status = 'active'`,
        [ts, reason || 'manual', machineId]
    );

    await closeOpenHistory(machineId, ts);

    await upsertStatus(machineId, {
        current_session_id: null,
        current_operator: null,
        is_online: 0,
        current_state: 'offline',
        state_started_at: null,
        last_event_at: ts
    });

    return { machineId, loggedOutAt: ts, reason: reason || 'manual' };
}

// A job is loaded onto the machine.
async function jobLoad({ machineId, machineName, po, jobName, fgNum, plannedQty }) {
    if (!machineId) throw new Error('machineId is required');
    const ts = nowMySQL();
    const fields = {
        current_job_po: po || null,
        current_job_name: jobName || null,
        current_fg_num: fgNum || null,
        job_planned_qty: (plannedQty != null ? plannedQty : null),
        job_loaded_at: ts,
        last_event_at: ts
    };
    // Only set machine_name when provided so a partial update never wipes it.
    if (machineName) fields.machine_name = machineName;
    await upsertStatus(machineId, fields);
    return { machineId, po, loadedAt: ts };
}

// Job finished / unloaded -> clear job fields, return machine to idle.
async function jobUnload({ machineId }) {
    if (!machineId) throw new Error('machineId is required');
    const ts = nowMySQL();

    const status = await getStatusRow(machineId);
    // Only re-open an idle segment if an operator is still logged in.
    const stillOnline = status && status.is_online;

    await upsertStatus(machineId, {
        current_job_po: null,
        current_job_name: null,
        current_fg_num: null,
        job_planned_qty: null,
        job_loaded_at: null,
        last_event_at: ts
    });

    if (stillOnline) {
        await recordState(machineId, 'idle', {
            jobPo: null,
            jobName: null
        });
    } else {
        await closeOpenHistory(machineId, ts);
        await upsertStatus(machineId, { current_state: 'offline', state_started_at: null });
    }

    return { machineId, unloadedAt: ts };
}

// Record a machine state change.
async function setState({ machineId, machineName, state }) {
    if (!machineId || !state) throw new Error('machineId and state are required');
    if (!STATE_TOKEN_RE.test(state)) {
        throw new Error(`Invalid state token '${state}' (expected letters/digits/underscore, max 32 chars)`);
    }
    const ts = await recordState(machineId, state, { machineName });
    return { machineId, state, at: ts };
}

// ----------------------------------------------------------------------------
// Read operations (dashboard data)
// ----------------------------------------------------------------------------
// Format a value (Date or string) coming back from MySQL into a stable local
// 'YYYY-MM-DD HH:MM:SS' string, so the dashboard never sees confusing UTC values.
function fmtLocal(v) {
    if (v == null) return null;
    if (v instanceof Date) return nowMySQL(v);
    return String(v);
}
function fmtDateOnly(v) {
    if (v == null) return null;
    if (v instanceof Date) return dateStr(v);
    return String(v).slice(0, 10);
}

function decorateStatusRow(row) {
    if (!row) return row;
    const out = { ...row };

    if (row.state_started_at) {
        const started = new Date(row.state_started_at);
        out.state_elapsed_seconds = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
    } else {
        out.state_elapsed_seconds = null;
    }
    if (row.job_loaded_at) {
        const loaded = new Date(row.job_loaded_at);
        out.job_elapsed_seconds = Math.max(0, Math.floor((Date.now() - loaded.getTime()) / 1000));
    } else {
        out.job_elapsed_seconds = null;
    }

    // Normalize timestamps to local strings
    out.shift_date = fmtDateOnly(row.shift_date);
    out.job_loaded_at = fmtLocal(row.job_loaded_at);
    out.state_started_at = fmtLocal(row.state_started_at);
    out.last_event_at = fmtLocal(row.last_event_at);
    out.updated_at = fmtLocal(row.updated_at);
    return out;
}

async function getStatus(machineId) {
    const row = await getStatusRow(machineId);
    return decorateStatusRow(row);
}

async function getDashboard() {
    const [rows] = await pool.query('SELECT * FROM machine_status ORDER BY machine_id');
    return rows.map(decorateStatusRow);
}

async function getSessions({ date, shift, machineId, limit } = {}) {
    const where = [];
    const params = [];
    if (date) { where.push('shift_date = ?'); params.push(date); }
    if (shift) { where.push('shift_type = ?'); params.push(shift); }
    if (machineId) { where.push('machine_id = ?'); params.push(machineId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.min(parseInt(limit, 10) || 200, 1000);
    const [rows] = await pool.query(
        `SELECT * FROM machine_shift_sessions ${whereSql} ORDER BY login_time DESC LIMIT ${lim}`,
        params
    );
    return rows;
}

async function getStateHistory({ machineId, date, shift, limit } = {}) {
    const where = [];
    const params = [];
    if (machineId) { where.push('machine_id = ?'); params.push(machineId); }
    if (date) { where.push('shift_date = ?'); params.push(date); }
    if (shift) { where.push('shift_type = ?'); params.push(shift); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.min(parseInt(limit, 10) || 500, 5000);
    const [rows] = await pool.query(
        `SELECT * FROM machine_state_history ${whereSql} ORDER BY started_at DESC LIMIT ${lim}`,
        params
    );
    return rows;
}

// ----------------------------------------------------------------------------
// Auto-logout sweeper: close sessions whose shift has already ended.
// ----------------------------------------------------------------------------
async function autoLogoutExpiredSessions() {
    try {
        const [active] = await pool.query(
            `SELECT session_id, machine_id, shift_type, shift_date
               FROM machine_shift_sessions WHERE status = 'active'`
        );
        const now = Date.now();
        let closed = 0;
        for (const s of active) {
            const shiftDate = s.shift_date instanceof Date ? dateStr(s.shift_date) : String(s.shift_date);
            const end = shiftEndTime(s.shift_type, shiftDate);
            if (now >= end.getTime()) {
                await logout({ machineId: s.machine_id, reason: 'auto_shift_end' });
                closed++;
            }
        }
        if (closed > 0) {
            console.log(`🕐 Auto-logout: closed ${closed} session(s) whose shift ended`);
        }
        return closed;
    } catch (err) {
        console.error('Auto-logout sweeper failed:', err.message);
        return 0;
    }
}

function startAutoLogoutSweeper(intervalMs = 60 * 1000) {
    autoLogoutExpiredSessions();
    const t = setInterval(autoLogoutExpiredSessions, intervalMs);
    if (t.unref) t.unref();
    return t;
}

module.exports = {
    VALID_STATES,
    ensureTables,
    login,
    logout,
    jobLoad,
    jobUnload,
    setState,
    getStatus,
    getDashboard,
    getSessions,
    getStateHistory,
    autoLogoutExpiredSessions,
    startAutoLogoutSweeper,
    currentShift
};
