// Database Configuration - Final Schema with batch_num
const mysql = require('mysql2/promise');
const path = require('path');

// Load .env from the same directory as this file
const envPath = path.join(__dirname, '.env');
console.log('📁 Loading .env from:', envPath);
require('dotenv').config({ path: envPath });

// Debug: Show loaded environment variables (mask password for security)
console.log('🔧 Database Configuration:');
console.log('   DB_HOST:', process.env.DB_HOST || '(not set, using default)');
console.log('   DB_PORT:', process.env.DB_PORT || '(not set, using 3306)');
console.log('   DB_USER:', process.env.DB_USER || '(not set, using default)');
console.log('   DB_PASSWORD:', process.env.DB_PASSWORD ? '****' + process.env.DB_PASSWORD.slice(-4) : '(not set, EMPTY!)');
console.log('   DB_NAME:', process.env.DB_NAME || '(not set, using default)');

// Create a connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || '192.168.3.12',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sap',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

// Test database connection
async function testConnection() {
    try {
        console.log('🔌 Attempting database connection...');
        console.log('   Connecting to:', process.env.DB_HOST || 'localhost');
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully!');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed!');
        console.error('   Error:', error.message);
        console.error('   Code:', error.code);
        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('   → Check username/password in .env file');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('   → MySQL server not running or not accessible');
        } else if (error.code === 'ENOTFOUND') {
            console.error('   → Invalid host address');
        }
        console.log('⚠️  App will continue without database (data saved locally)');
        return false;
    }
}

// Get or generate batch number using stored procedure
// Format: B + 6-digit sequential number (B000001, B000002, etc.)
async function getBatchNum(poNum, startTime, endTime) {
    try {
        console.log(`   🔢 Generating batch number for PO: ${poNum}`);
        console.log(`      Start time: ${startTime}`);
        console.log(`      End time: ${endTime}`);
        
        // Call stored procedure to get/generate batch number
        const [rows] = await pool.query(
            'CALL get_next_batch_num(?, ?, ?, @batch_num)',
            [poNum, startTime, endTime || null]
        );
        
        // Get the output parameter
        const [result] = await pool.query('SELECT @batch_num as batch_num');
        
        console.log(`      Stored procedure result:`, result);
        
        if (result && result[0] && result[0].batch_num) {
            console.log(`      ✅ Generated batch number: ${result[0].batch_num}`);
            return result[0].batch_num;
        }
        
        throw new Error('Failed to generate batch number - stored procedure returned null');
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
        // Get or generate batch number
        const batchNum = data.batch_num || await getBatchNum(
            data.po_num,
            data.job_start_time,
            data.job_end_time
        );
        
        const query = `
            INSERT INTO production_records 
            (batch_num, po_num, fg_num, job_name, operator_name, shift_type, machine_name, 
             process_name, planned_qty, job_start_time, job_end_time, quantity_processed, 
             speed_impressions_per_hour, sheets_wasted, remark,
             activity_name, activity_time_minutes, device_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        // Get or generate batch number for this job
        const batchNum = await getBatchNum(
            jobData.po_num,
            jobData.job_start_time,
            jobData.job_end_time
        );
        
        const values = activities.map(activity => [
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
            jobData.speed_impressions_per_hour || 0,
            jobData.sheets_wasted || 0,
            jobData.remark || null,
            activity.activity_name,
            activity.activity_time_minutes || 0,
            jobData.device_id || null
        ]);

        if (values.length === 0) {
            return { batch_num: batchNum, inserted: 0 };
        }

        const query = `
            INSERT INTO production_records 
            (batch_num, po_num, fg_num, job_name, operator_name, shift_type, machine_name, 
             process_name, planned_qty, job_start_time, job_end_time, quantity_processed, 
             speed_impressions_per_hour, sheets_wasted, remark,
             activity_name, activity_time_minutes, device_id)
            VALUES ?
        `;

        const [result] = await pool.query(query, [values]);
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
            'SELECT * FROM production_records WHERE machine_name = ? AND DATE(job_start_time) = ? ORDER BY job_start_time, batch_num',
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

// Get best historical performance for a finished goods number (fg_num)
// Returns minimum MakeReady time and minimum per-unit running time from past jobs
async function getBestPerformance(fgNum, machineName = null) {
    try {
        // Only filter by fg_num (machine name can vary)
        const whereClause = 'fg_num = ?';
        const params = [fgNum];
        
        // Query for best MakeReady time (minimum from all completed jobs with same fg_num)
        // Only consider entries with time >= 1 minute
        const makeReadyQuery = `
            SELECT 
                MIN(activity_time_minutes) as best_makeready_minutes,
                COUNT(DISTINCT batch_num) as job_count
            FROM production_records 
            WHERE ${whereClause}
              AND activity_name = 'makeready'
              AND activity_time_minutes >= 1
        `;
        
        // Query for best MakeReady with machine name
        const bestMakeReadyMachineQuery = `
            SELECT machine_name, activity_time_minutes
            FROM production_records 
            WHERE ${whereClause}
              AND activity_name = 'makeready'
              AND activity_time_minutes >= 1
            ORDER BY activity_time_minutes ASC
            LIMIT 1
        `;
        
        // Query for best running time per unit with machine name
        // Only consider entries with running time >= 1 minute
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
        
        // Query for best running time per unit WITH machine name
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
        
        // Also get the best speed (impressions per hour) for reference
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
            jobCount: makeReadyData.job_count || 0,
            bestMakeReadyMinutes: parseFloat(makeReadyData.best_makeready_minutes) || null,
            bestMakeReadyMachine: bestMakeReadyMachine.machine_name || null,
            bestRunningPerUnit: parseFloat(runningData.best_running_per_unit) || null,  // minutes per unit
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

module.exports = {
    pool,
    testConnection,
    getBatchNum,
    insertActivityRecord,
    insertJobActivities,
    getActivitiesByBatchNum,
    getBatchesByPO,
    getJobSummary,
    getShiftSummary,
    getActivitiesByMachineAndDate,
    updateActivityRecord,
    updateBatchActivities,
    deleteActivityRecord,
    deleteBatch,
    getBestPerformance
};

