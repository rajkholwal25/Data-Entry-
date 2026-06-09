// Machine Landing Page - Production Management System
// Fixed version with: Idle state, Finish/Cancel job, Day Summary with aggregated times, Job validation

// Sample job data
const sampleJobs = [
    {
        jobNumber: 'JOB-2401',
        jobName: 'Premium Business Cards - ABC Corp',
        plannedQuantity: 5000,
        numOfUps: 8,
        state: 'In Queue',
        isActive: false,
        jobStartTime: null,
        jobEndTime: null
    },
    {
        jobNumber: 'JOB-2402',
        jobName: 'Luxury Packaging Box - XYZ Ltd',
        plannedQuantity: 2000,
        numOfUps: 4,
        state: 'In Queue',
        isActive: false,
        jobStartTime: null,
        jobEndTime: null
    },
    {
        jobNumber: 'JOB-2403',
        jobName: 'Brochure Printing - Marketing Inc',
        plannedQuantity: 10000,
        numOfUps: 16,
        state: 'In Queue',
        isActive: false,
        jobStartTime: null,
        jobEndTime: null
    },
    {
        jobNumber: 'JOB-2404',
        jobName: 'Product Labels - Tech Solutions',
        plannedQuantity: 15000,
        numOfUps: 24,
        state: 'In Queue',
        isActive: false,
        jobStartTime: null,
        jobEndTime: null
    },
    {
        jobNumber: 'JOB-2405',
        jobName: 'Invitation Cards - Event Co',
        plannedQuantity: 3000,
        numOfUps: 6,
        state: 'In Queue',
        isActive: false,
        jobStartTime: null,
        jobEndTime: null
    }
];

// Global state
let currentJobs = [...sampleJobs];
let selectedJob = null;
let timerInterval = null;
let timerSeconds = 0;
let currentMachineState = null;

// Timestamp-based timer tracking (survives screen off)
let stateStartTimestamp = null; // When current state started (Unix timestamp)
let accumulatedStateTime = 0;   // Time accumulated before current state started

// State-specific time tracking
let stateTimers = {
    makeready: 0,
    running: 0,
    lunch: 0,
    cleaning: 0,
    waiting_qc: 0,
    waiting_die: 0,
    waiting_input: 0,
    line_clearance: 0,
    downtime_elec: 0,
    downtime_mech: 0,
    downtime: 0,
    idle: 0,
    feeder_trip: 0,
    sticky_sheets: 0,
    sorting_waiting: 0
};

// Production management data
let completedJobs = [];
let cancelledJobs = [];
// Current clock-in session (reset on Clock in, shown on Clock out / Summary)
let sessionCompletedJobs = [];
let sessionCancelledJobs = [];
let activeJobNumber = null;  // Track which job is currently Running/MakeReady
let activeJobState = null;   // Track the state of active job

// Makeready type tracking (New or Repeat)
let currentMakereadyType = null;

// Pending shift end time - set when shift changeover happens with no active job
let pendingShiftEndTime = null;

/**
 * Update PO input state based on whether a job is currently running
 * Disables input and button when a job is in Running or Make Ready state
 */
function updatePOInputState() {
    const poInput = document.getElementById('po-search-input');
    const poSearchBtn = document.getElementById('po-search-btn');
    
    const isJobActive = activeJobNumber && (activeJobState === 'running' || activeJobState === 'makeready');
    
    if (poInput) {
        poInput.disabled = isJobActive;
        if (isJobActive) {
            poInput.placeholder = `Job ${activeJobNumber} is running - finish first`;
            poInput.style.opacity = '0.6';
            poInput.style.cursor = 'not-allowed';
        } else {
            poInput.placeholder = 'Enter PO Number';
            poInput.style.opacity = '1';
            poInput.style.cursor = 'text';
        }
    }
    
    if (poSearchBtn) {
        poSearchBtn.disabled = isJobActive;
        if (isJobActive) {
            poSearchBtn.style.opacity = '0.6';
            poSearchBtn.style.cursor = 'not-allowed';
            poSearchBtn.title = `Cannot add new job - Job ${activeJobNumber} is currently active`;
        } else {
            poSearchBtn.style.opacity = '1';
            poSearchBtn.style.cursor = 'pointer';
            poSearchBtn.title = '';
        }
    }
}

// ==================== LocalStorage Persistence ====================

// Base storage key - will be made machine-specific
const STORAGE_KEY_BASE = 'vkglobal_production_state';
const OPERATOR_KEY_BASE = 'vkglobal_operator';

/**
 * Get machine-specific storage key
 * This allows multiple machines to run in parallel on the same device
 */
function getStorageKey() {
    const urlParams = new URLSearchParams(window.location.search);
    const machine = urlParams.get('machine');
    if (machine) {
        return `${STORAGE_KEY_BASE}_${machine}`;
    }
    return STORAGE_KEY_BASE;
}

/**
 * Get machine-specific operator storage key
 */
function getOperatorStorageKey() {
    const urlParams = new URLSearchParams(window.location.search);
    const machine = urlParams.get('machine');
    if (machine) {
        return `${OPERATOR_KEY_BASE}_${machine}`;
    }
    return OPERATOR_KEY_BASE;
}

/**
 * Save current state to localStorage
 */
function saveStateToStorage() {
    ensureShiftOperatorLoaded();

    const state = {
        currentJobs,
        selectedJob,
        currentMachineState,
        stateStartTimestamp,
        accumulatedStateTime,
        stateTimers,
        completedJobs,
        cancelledJobs,
        activeJobNumber,
        activeJobState,
        currentShift,
        shiftStartTime,
        currentJobId,
        machineInfo,
        currentOperator,
        operatorSelectedForShift,
        shiftLoginAt,
        pendingShiftEndTime,
        currentMakereadyType,
        savedAt: Date.now()
    };
    
    try {
        localStorage.setItem(getStorageKey(), JSON.stringify(state));
        console.log('💾 State saved to localStorage');
    } catch (e) {
        console.error('Failed to save state:', e);
    }
}

/**
 * Load state from localStorage
 * On refresh: Restores running job state but clears queued jobs
 * If no active job is found, ALL states are reset to zero
 */
function loadStateFromStorage() {
    try {
        const saved = localStorage.getItem(getStorageKey());
        if (!saved) return false;
        
        const state = JSON.parse(saved);
        
        // Check if saved state is from same machine/process
        const urlParams = new URLSearchParams(window.location.search);
        const currentMachine = urlParams.get('machine');
        const currentProcess = urlParams.get('process');
        
        if (state.machineInfo && 
            (state.machineInfo.name !== currentMachine || state.machineInfo.process !== currentProcess)) {
            console.log('📍 Different machine/process, not restoring state');
            return false;
        }
        
        // ALWAYS restore operator and shift info FIRST (regardless of active job status)
        // This ensures operator selection persists across page refreshes within the same shift
        completedJobs = state.completedJobs || [];
        cancelledJobs = state.cancelledJobs || [];
        currentShift = state.currentShift;
        shiftStartTime = state.shiftStartTime;
        currentOperator = state.currentOperator;
        operatorSelectedForShift = state.operatorSelectedForShift || false;
        if (state.shiftLoginAt) {
            shiftLoginAt = state.shiftLoginAt;
        }
        
        // Restore subProcess if it was saved
        if (state.machineInfo && state.machineInfo.subProcess) {
            machineInfo.subProcess = state.machineInfo.subProcess;
        }
        
        // Restore pending shift end time and makeready type
        pendingShiftEndTime = state.pendingShiftEndTime || null;
        currentMakereadyType = state.currentMakereadyType || null;
        
        console.log('👤 Operator info restored:', currentOperator || 'not selected');
        console.log('   - operatorSelectedForShift:', operatorSelectedForShift);
        
        // Filter jobs: Only keep the active/running job, clear queued jobs
        // Jobs with state 'In Queue' that are not active should be cleared on refresh
        const savedJobs = state.currentJobs || [];
        const activeJob = savedJobs.find(job => 
            job.jobNumber === state.activeJobNumber && 
            (job.state === 'Running' || job.state === 'Make Ready' || job.isActive)
        );
        
        // Only restore the active job, clear the queue
        if (activeJob) {
            // Active job found - restore job and all related states
            currentJobs = [activeJob];
            selectedJob = activeJob;
            currentMachineState = state.currentMachineState;
            stateStartTimestamp = state.stateStartTimestamp;
            accumulatedStateTime = state.accumulatedStateTime || 0;
            stateTimers = state.stateTimers || {};
            activeJobNumber = state.activeJobNumber;
            activeJobState = state.activeJobState;
            currentJobId = state.currentJobId;
            console.log('🔄 Restored active job and states:', activeJob.jobNumber);
            
            console.log('✅ Full state restored from localStorage');
            console.log('   - Current state:', currentMachineState);
            console.log('   - State start:', stateStartTimestamp ? new Date(stateStartTimestamp).toLocaleTimeString() : 'none');
            console.log('   - Selected job:', selectedJob?.jobNumber || 'none');
            console.log('   - Active job number:', activeJobNumber || 'none');
            console.log('   - Sub-process:', machineInfo.subProcess || 'none');
            
            return true;
        } else {
            // NO active job found - RESET JOB STATES TO ZERO but KEEP operator info
            currentJobs = [];
            selectedJob = null;
            currentMachineState = null;
            stateStartTimestamp = null;
            accumulatedStateTime = 0;
            stateTimers = {
                makeready: 0,
                running: 0,
                lunch: 0,
                cleaning: 0,
                waiting_qc: 0,
                waiting_die: 0,
                waiting_input: 0,
                line_clearance: 0,
                downtime_elec: 0,
                downtime_mech: 0,
                downtime: 0,
                idle: 0,
                feeder_trip: 0,
                sticky_sheets: 0,
                sorting_waiting: 0
            };
            activeJobNumber = null;
            activeJobState = null;
            currentJobId = null;
            
            console.log('⚠️ No active job found - job states reset, operator info preserved');
            console.log('   - Operator still set:', currentOperator || 'none');
            console.log('   - operatorSelectedForShift:', operatorSelectedForShift);
            
            // Re-sync from operator store so we never wipe clock-in on save
            restoreShiftOperatorFromStorage();

            // Don't call clearStateStorage() here - we want to preserve operator info
            // Save the updated state with operator info but no active job
            saveStateToStorage();
            
            // Return false to indicate no active job to resume
            return false;
        }
    } catch (e) {
        console.error('Failed to load state:', e);
        return false;
    }
}

/**
 * Clear saved state from localStorage
 */
function clearStateStorage() {
    localStorage.removeItem(getStorageKey());
    console.log('🗑️ State cleared from localStorage');
}

/**
 * Reset Memory PIN - 4 digit PIN for clearing tablet memory
 */
const RESET_MEMORY_PIN = '8686';

/**
 * Show the reset memory modal
 */
function showResetMemoryModal() {
    const modal = document.getElementById('reset-memory-modal-overlay');
    const pinInput = document.getElementById('reset-pin-input');
    const errorMessage = document.getElementById('pin-error-message');
    
    if (modal) {
        modal.classList.add('active');
        if (pinInput) {
            pinInput.value = '';
            pinInput.focus();
        }
        if (errorMessage) {
            errorMessage.textContent = '';
        }
    }
}

/**
 * Close the reset memory modal
 */
function closeResetMemoryModal() {
    const modal = document.getElementById('reset-memory-modal-overlay');
    const pinInput = document.getElementById('reset-pin-input');
    const errorMessage = document.getElementById('pin-error-message');
    
    if (modal) {
        modal.classList.remove('active');
    }
    if (pinInput) {
        pinInput.value = '';
    }
    if (errorMessage) {
        errorMessage.textContent = '';
    }
}

/**
 * Confirm reset memory with PIN verification
 */
function confirmResetMemory() {
    const pinInput = document.getElementById('reset-pin-input');
    const errorMessage = document.getElementById('pin-error-message');
    
    if (!pinInput) return;
    
    const enteredPin = pinInput.value;
    
    if (enteredPin.length !== 4) {
        if (errorMessage) {
            errorMessage.textContent = 'Please enter a 4-digit PIN';
        }
        return;
    }
    
    if (enteredPin !== RESET_MEMORY_PIN) {
        if (errorMessage) {
            errorMessage.textContent = 'Incorrect PIN. Please try again.';
        }
        pinInput.value = '';
        pinInput.focus();
        return;
    }
    
    performMemoryReset();
}

/**
 * Perform the actual memory reset
 */
function performMemoryReset() {
    console.log('🗑️ Performing memory reset...');
    
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    
    currentJobs = [];
    selectedJob = null;
    currentMachineState = null;
    stateStartTimestamp = null;
    accumulatedStateTime = 0;
    timerSeconds = 0;
    completedJobs = [];
    cancelledJobs = [];
    activeJobNumber = null;
    activeJobState = null;
    currentShift = null;
    shiftStartTime = null;
    currentJobId = null;
    currentOperator = null;
    operatorSelectedForShift = false;
    pendingShiftEndTime = null;
    currentMakereadyType = null;
    
    stateTimers = {
        makeready: 0,
        running: 0,
        lunch: 0,
        cleaning: 0,
        waiting_qc: 0,
        waiting_die: 0,
        waiting_input: 0,
        line_clearance: 0,
        downtime_elec: 0,
        downtime_mech: 0,
        downtime: 0,
        idle: 0,
        feeder_trip: 0,
        sticky_sheets: 0,
        sorting_waiting: 0
    };
    
    localStorage.removeItem(getStorageKey());
    localStorage.removeItem(getOperatorStorageKey());
    
    updateTimerDisplay(0);
    updateFooterStats();
    
    // Clear active state from all control buttons
    document.querySelectorAll('.control-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Clear job queue display
    renderJobQueue([]);
    
    const jobDetailsCard = document.querySelector('.job-details-card');
    if (jobDetailsCard) {
        jobDetailsCard.innerHTML = `
            <div class="card-header">
                <h3>Job Details</h3>
            </div>
            <div class="no-job-message">
                <span class="no-job-icon">📋</span>
                <p>No job loaded</p>
                <p class="no-job-hint">Search for a PO number to load a job</p>
            </div>
        `;
    }
    
    closeResetMemoryModal();
    
    console.log('✅ Memory reset complete');
    
    alert('✅ Memory cleared successfully!\n\nAll data has been reset:\n• Jobs unloaded\n• Timers reset to zero\n• Machine state cleared');
}

/**
 * Refresh SAP data for a restored job
 * This fetches fresh issuedQuantity and completedQuantity from SAP
 * to ensure the display reflects the latest backend state
 */
async function refreshSAPDataForJob(job) {
    if (!job || !job.jobNumber) {
        console.log('⚠️ No job to refresh SAP data for');
        return;
    }
    
    try {
        console.log(`🔄 Refreshing SAP data for job ${job.jobNumber}...`);
        
        const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.productionOrder(job.jobNumber)}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            console.warn(`⚠️ Failed to refresh SAP data: HTTP ${response.status}`);
            return;
        }
        
        const result = await response.json();
        
        if (result && result.success && result.data) {
            const freshData = result.data;
            
            // Update the job with fresh SAP data
            const oldIssued = job.issuedQuantity || 0;
            const oldCompleted = job.completedQuantity || 0;
            
            job.issuedQuantity = freshData.issuedQuantity || 0;
            job.completedQuantity = freshData.completedQuantity || 0;
            
            console.log(`✅ SAP data refreshed for job ${job.jobNumber}:`);
            console.log(`   - Issued: ${oldIssued} → ${job.issuedQuantity}`);
            console.log(`   - Completed: ${oldCompleted} → ${job.completedQuantity}`);
            
            // Update the selected job reference if it's the same job
            if (selectedJob && selectedJob.jobNumber === job.jobNumber) {
                selectedJob.issuedQuantity = job.issuedQuantity;
                selectedJob.completedQuantity = job.completedQuantity;
                
                // Refresh the job details display
                showJobDetails(selectedJob);
            }
            
            // Update the job in currentJobs array
            const jobIndex = currentJobs.findIndex(j => j.jobNumber === job.jobNumber);
            if (jobIndex !== -1) {
                currentJobs[jobIndex].issuedQuantity = job.issuedQuantity;
                currentJobs[jobIndex].completedQuantity = job.completedQuantity;
            }
            
            // Save updated state to localStorage
            saveStateToStorage();
            
        } else {
            console.warn('⚠️ Invalid response when refreshing SAP data');
        }
    } catch (error) {
        console.error('❌ Error refreshing SAP data:', error);
    }
}

/**
 * Calculate current timer value based on timestamp
 */
function calculateCurrentTimerSeconds() {
    if (!stateStartTimestamp || !currentMachineState) {
        return accumulatedStateTime;
    }
    
    const elapsedSinceStart = Math.floor((Date.now() - stateStartTimestamp) / 1000);
    return accumulatedStateTime + elapsedSinceStart;
}

// ==================== IST Time Helper Functions ====================

/**
 * Get current time in IST (Indian Standard Time)
 * @returns {Date} Date object adjusted to IST
 */
function getISTDate() {
    const now = new Date();
    // IST is UTC+5:30
    const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    return new Date(utcTime + istOffset);
}

/**
 * Format date to IST ISO string (YYYY-MM-DD HH:MM:SS)
 * @param {Date} date - Date to format (optional, defaults to now)
 * @returns {string} Formatted date string in IST
 */
function formatISTDateTime(date = null) {
    const istDate = date ? date : getISTDate();
    const year = istDate.getFullYear();
    const month = String(istDate.getMonth() + 1).padStart(2, '0');
    const day = String(istDate.getDate()).padStart(2, '0');
    const hours = String(istDate.getHours()).padStart(2, '0');
    const minutes = String(istDate.getMinutes()).padStart(2, '0');
    const seconds = String(istDate.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Get IST timestamp for database storage
 * @returns {string} MySQL compatible datetime string in IST
 */
function getISTTimestamp() {
    return formatISTDateTime();
}

// Shift tracking
let currentShift = null;
let shiftStartTime = null;

// Database tracking
let currentJobId = null; // Database job ID for current job
let machineInfo = {
    name: null,
    process: null,
    subProcess: null  // Selected sub-process (e.g., "DieCutting + Embossing", "Lock Bottom")
};

// Operator tracking
let currentOperator = null;
let operatorSelectedForShift = false;
let shiftLoginAt = null; // ms timestamp when operator logged in for this shift
let shiftFooterInterval = null;

// Operator lists by machine
const OPERATOR_LISTS = {
    // NovaCut machines (die-cutting-embossing)
    'nova-cut-1': ['Durgesh', 'Avnish', 'Ranjesh', 'Gopal', 'Amit'],
    'nova-cut-2': ['Durgesh', 'Avnish', 'Ranjesh', 'Gopal', 'Amit'],
    
    // Manual DieCutting machines
    'manual-mdc-1': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    'manual-mdc-2': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    'manual-mdc-3': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    'manual-mdc-4': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    
    // Foiling machines
    'mk-foiling': ['Sachin', 'Khodas', 'Kunal', 'Arvind', 'Ashok'],
    'manual-mf': ['Sachin', 'Khodas', 'Kunal', 'Arvind', 'Ashok'],
    
    // Folding/Pasting machines
    'ambition': ['Ravindra', 'Sandeep', 'Goutam', 'Ambuj', 'Sajan', 'Rajnesh', 'Balram', 'Jageswer'],
    'visionfold': ['Ravindra', 'Sandeep', 'Goutam', 'Ambuj', 'Sajan', 'Rajnesh', 'Balram', 'Jageswer'],
    'nova-fold': ['Ravindra', 'Sandeep', 'Goutam', 'Ambuj', 'Sajan', 'Rajnesh', 'Balram', 'Jageswer'],
    
    // Lamination machines
    'yilee': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],
    'yong-shun': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],
    'narendra': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],
    'wity': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],

    // Spot UV machines (Sakurai, Horda, APR)
    'spotuv-sakurai': ['Ashish Thakur', 'Gourav Pal', 'Sunil', 'Arjun'],
    'spotuv-horda': ['Ashish Thakur', 'Gourav Pal', 'Sunil', 'Arjun'],
    'spotuv-apr': ['Ashish Thakur', 'Gourav Pal', 'Sunil', 'Arjun'],

    // Unit 1 - Holographic machines
    'embossing-1': [],
    'embossing-2': [],
    'embossing-3': [],
    'rewinding-1': [],
    'rewinding-2': [],
    'slitting-1': [],
    'slitting-2': [],
    'metallisation-1': []
};

// Get operator list for current machine
function getOperatorListForMachine(machineName) {
    if (!machineName) return [];
    
    const normalizedName = machineName.toLowerCase().trim();
    
    // Try exact match first
    if (OPERATOR_LISTS[normalizedName]) {
        return OPERATOR_LISTS[normalizedName];
    }
    
    // Try partial match
    for (const [key, operators] of Object.entries(OPERATOR_LISTS)) {
        if (normalizedName.includes(key) || key.includes(normalizedName)) {
            return operators;
        }
    }
    
    // Default empty list (will show "Other" option only)
    return [];
}

// Show operator selection modal
function showOperatorSelectionModal() {
    return new Promise((resolve) => {
        const operators = getOperatorListForMachine(machineInfo.name);
        
        // Remove any existing operator modal first
        const existingModal = document.getElementById('operator-modal-overlay');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Create modal HTML with inline styles for better portrait mode support
        const modalHTML = `
            <div class="modal-overlay active" id="operator-modal-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.7); z-index: 10000;">
                <div class="modal-content" style="max-width: 400px; width: 90%; background: linear-gradient(145deg, rgba(17, 24, 39, 0.98) 0%, rgba(10, 15, 26, 0.99) 100%); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 16px; margin: 20px; overflow: hidden;">
                    <div class="modal-header" style="padding: 20px 20px 10px 20px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                        <h2 class="modal-title" style="margin: 0; font-size: 1.2rem; color: #fff;">👤 Select Operator</h2>
                    </div>
                    <div class="modal-body" style="padding: 20px;">
                        <p style="margin-bottom: 15px; color: #9ca3af; font-size: 0.9rem;">
                            Please select the operator for this shift on <strong style="color: #3b82f6;">${formatMachineName(machineInfo.name)}</strong>
                        </p>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label for="operator-select" style="display: block; margin-bottom: 8px; font-size: 0.9rem; color: #e5e7eb;">Operator Name *</label>
                            <select id="operator-select" class="operator-dropdown" style="width: 100%; padding: 12px; font-size: 16px; border-radius: 8px; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(255,255,255,0.1); color: #fff; -webkit-appearance: menulist; appearance: menulist;">
                                <option value="">-- Select Operator --</option>
                                ${operators.map(op => `<option value="${op}">${op}</option>`).join('')}
                                <option value="other">Other (Enter manually)</option>
                            </select>
                        </div>
                        <div class="form-group" id="other-operator-group" style="display: none; margin-bottom: 15px;">
                            <label for="other-operator-input" style="display: block; margin-bottom: 8px; font-size: 0.9rem; color: #e5e7eb;">Enter Operator Name *</label>
                            <input type="text" id="other-operator-input" placeholder="Enter operator name..." style="width: 100%; padding: 12px; font-size: 16px; border-radius: 8px; background: rgba(30, 41, 59, 0.8); border: 1px solid rgba(255,255,255,0.1); color: #fff; box-sizing: border-box;">
                        </div>
                        <div style="margin-top: 20px;">
                            <button type="button" id="operator-confirm-btn" style="width: 100%; padding: 14px; font-size: 1rem; font-weight: 600; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; border: none; border-radius: 8px; cursor: pointer;">
                                ✓ Confirm & Start
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        const modal = document.getElementById('operator-modal-overlay');
        const select = document.getElementById('operator-select');
        const otherGroup = document.getElementById('other-operator-group');
        const otherInput = document.getElementById('other-operator-input');
        const confirmBtn = document.getElementById('operator-confirm-btn');
        
        let resolved = false; // Prevent double resolution
        
        // Handle "Other" selection
        if (select) {
            select.addEventListener('change', () => {
                if (select.value === 'other') {
                    if (otherGroup) otherGroup.style.display = 'block';
                    if (otherInput) otherInput.focus();
                } else {
                    if (otherGroup) otherGroup.style.display = 'none';
                }
            });
        }
        
        // Handle confirm
        const handleConfirm = () => {
            if (resolved) return;
            
            let operatorName = select ? select.value : '';
            
            if (operatorName === 'other') {
                operatorName = otherInput ? otherInput.value.trim() : '';
                if (!operatorName) {
                    alert('Please enter the operator name');
                    if (otherInput) otherInput.focus();
                    return;
                }
            }
            
            if (!operatorName) {
                alert('Please select an operator');
                return;
            }
            
            resolved = true;
            
            // Save operator
            currentOperator = operatorName;
            operatorSelectedForShift = true;
            shiftLoginAt = Date.now();

            // Save to localStorage
            saveOperatorToStorage();

            // Live tracking: record operator login (machine selected for shift)
            if (typeof LiveTracking !== 'undefined') {
                LiveTracking.login(operatorName);
            }

            updateShiftFooterDisplay();
            updateClockButtonUI();
            saveShiftSessionToStorage();
            saveStateToStorage();
            
            // Remove modal
            if (modal) modal.remove();
            
            console.log(`👤 Operator selected: ${operatorName}`);
            resolve(operatorName);
        };
        
        if (confirmBtn) {
            confirmBtn.onclick = handleConfirm;
        }
        
        // Prevent closing by clicking outside
        if (modal) {
            modal.onclick = (e) => {
                if (e.target === modal) {
                    alert('Please select an operator to continue');
                }
            };
        }
    });
}

// Save operator to localStorage (loginAt = first login of shift, never updated on re-save)
function saveOperatorToStorage() {
    let loginAt = shiftLoginAt;
    if (!loginAt) {
        try {
            const existing = localStorage.getItem(getOperatorStorageKey());
            if (existing) {
                const prev = JSON.parse(existing);
                if (isOperatorValidForCurrentShift(prev) && (prev.loginAt || prev.savedAt)) {
                    loginAt = prev.loginAt || prev.savedAt;
                }
            }
        } catch (e) { /* ignore */ }
    }
    if (!loginAt) loginAt = Date.now();
    shiftLoginAt = loginAt;

    const operatorData = {
        operator: currentOperator,
        machine: machineInfo.name,
        shift: getCurrentShift(),
        shiftDate: new Date().toISOString().split('T')[0],
        loginAt,
        savedAt: Date.now()
    };
    localStorage.setItem(getOperatorStorageKey(), JSON.stringify(operatorData));
}

// Validate if stored operator matches current shift details
function isOperatorValidForCurrentShift(storedData) {
    if (!storedData) return false;

    const currentDate = new Date().toISOString().split('T')[0];
    const currentShiftType = getCurrentShift();

    return storedData.machine === machineInfo.name &&
        storedData.shift === currentShiftType &&
        storedData.shiftDate === currentDate;
}

// Load operator from localStorage (alias for shift restore)
function loadOperatorFromStorage() {
    const ok = restoreShiftOperatorFromStorage();
    if (ok) {
        console.log(`👤 Operator restored: ${currentOperator} (login ${shiftLoginAt ? new Date(shiftLoginAt).toLocaleTimeString() : '?'})`);
    }
    return ok;
}

// Clear operator on shift change
function clearOperatorForNewShift() {
    currentOperator = null;
    operatorSelectedForShift = false;
    shiftLoginAt = null;
    localStorage.removeItem(getOperatorStorageKey());
    updateShiftFooterDisplay();
}

// Restore operator + first-login time from dedicated per-shift storage.
// Always run on page load — main state may have operator name but not shiftLoginAt.
function restoreShiftOperatorFromStorage() {
    try {
        const saved = localStorage.getItem(getOperatorStorageKey());
        if (!saved) return false;

        const data = JSON.parse(saved);
        if (!isOperatorValidForCurrentShift(data)) return false;

        currentOperator = data.operator;
        operatorSelectedForShift = true;
        // Never reset login time on re-entry — use first login of the shift only
        const loginAt = data.loginAt || data.savedAt;
        if (loginAt) {
            shiftLoginAt = loginAt;
        }
        return true;
    } catch (e) {
        console.error('Failed to restore shift operator:', e);
        return false;
    }
}

/** Load clocked-in operator from memory or per-shift storage (no modal). */
function ensureShiftOperatorLoaded() {
    if (currentOperator && shiftLoginAt) return true;
    if (restoreShiftOperatorFromStorage()) return true;
    if (currentOperator && !shiftLoginAt) {
        shiftLoginAt = Date.now();
        saveOperatorToStorage();
        return true;
    }
    return false;
}

/** Operator name for DB/API — stays set until clock out. */
function getOperatorForSubmission() {
    ensureShiftOperatorLoaded();
    return currentOperator || null;
}

/** Persist operator + login time to dedicated store and main page state. */
function persistShiftOperator() {
    ensureShiftOperatorLoaded();
    if (!currentOperator) return;
    saveOperatorToStorage();
}

// Capture the operator once per shift (page open / shift changeover).
// Job loads must NOT re-prompt — operator stays logged in across jobs.
async function ensureOperatorForShift() {
    restoreShiftOperatorFromStorage();

    if (!currentOperator) {
        await showOperatorSelectionModal();
    } else {
        // Only set login time on first login this shift (never on page re-entry)
        if (!shiftLoginAt) {
            const saved = localStorage.getItem(getOperatorStorageKey());
            let loginAt = null;
            if (saved) {
                try {
                    const data = JSON.parse(saved);
                    loginAt = data.loginAt || data.savedAt;
                } catch (e) { /* ignore */ }
            }
            shiftLoginAt = loginAt || Date.now();
            saveOperatorToStorage();
        }
        if (typeof LiveTracking !== 'undefined') {
            LiveTracking.login(currentOperator);
        }
    }

    updateShiftFooterDisplay();
    saveStateToStorage();
}

// Tick shift timer in footer every second (independent of job state timer)
function startShiftFooterTimer() {
    if (shiftFooterInterval) clearInterval(shiftFooterInterval);
    updateShiftFooterDisplay();
    shiftFooterInterval = setInterval(updateShiftFooterDisplay, 1000);
}

function updateShiftFooterDisplay() {
    const opEl = document.getElementById('footer-operator-name');
    const timerEl = document.getElementById('footer-shift-timer');

    if (opEl) opEl.textContent = currentOperator || '-';
    if (timerEl) {
        timerEl.textContent = shiftLoginAt
            ? formatTime(Math.floor((Date.now() - shiftLoginAt) / 1000))
            : '00:00:00';
    }
}

function isShiftClockedIn() {
    return !!(currentOperator && shiftLoginAt);
}

function isJobLoadedOnMachine() {
    if (selectedJob) return true;
    if (activeJobNumber) return true;
    if (currentJobs && currentJobs.length > 0) return true;
    if (currentMachineState === 'running' || currentMachineState === 'makeready') return true;
    return false;
}

function getShiftSessionStorageKey() {
    return `${getOperatorStorageKey()}_session`;
}

function getEmptyStateTimers() {
    return {
        makeready: 0,
        running: 0,
        lunch: 0,
        cleaning: 0,
        waiting_qc: 0,
        waiting_die: 0,
        waiting_input: 0,
        line_clearance: 0,
        downtime_elec: 0,
        downtime_mech: 0,
        downtime: 0,
        idle: 0,
        feeder_trip: 0,
        sticky_sheets: 0,
        sorting_waiting: 0
    };
}

function resetShiftSessionData() {
    sessionCompletedJobs = [];
    sessionCancelledJobs = [];
    completedJobs = [];
    cancelledJobs = [];
    stateTimers = getEmptyStateTimers();
    try {
        localStorage.removeItem(getShiftSessionStorageKey());
    } catch (e) { /* ignore */ }
    saveStateToStorage();
}

function saveShiftSessionToStorage() {
    if (!isShiftClockedIn()) return;
    try {
        localStorage.setItem(getShiftSessionStorageKey(), JSON.stringify({
            sessionCompletedJobs,
            sessionCancelledJobs,
            shiftLoginAt
        }));
    } catch (e) {
        console.error('Failed to save shift session:', e);
    }
}

function loadShiftSessionFromStorage() {
    if (!isShiftClockedIn()) return;
    try {
        const saved = localStorage.getItem(getShiftSessionStorageKey());
        if (!saved) return;
        const data = JSON.parse(saved);
        if (data.shiftLoginAt && data.shiftLoginAt !== shiftLoginAt) return;
        sessionCompletedJobs = data.sessionCompletedJobs || [];
        sessionCancelledJobs = data.sessionCancelledJobs || [];
    } catch (e) {
        console.error('Failed to load shift session:', e);
    }
}

function updateClockButtonUI() {
    const btn = document.getElementById('shift-clock-btn');
    if (!btn) return;
    if (isShiftClockedIn()) {
        btn.textContent = 'Clock out';
        btn.classList.remove('clock-in');
        btn.classList.add('clock-out');
        btn.title = 'Finish current job first, then clock out to see shift summary';
    } else {
        btn.textContent = 'Clock in';
        btn.classList.remove('clock-out');
        btn.classList.add('clock-in');
        btn.title = 'Select operator and start shift timer';
    }
}

function requireClockedIn(actionLabel) {
    if (isShiftClockedIn()) return true;
    alert(`Please clock in before ${actionLabel}.`);
    return false;
}

async function handleClockIn() {
    if (isShiftClockedIn()) return;

    resetShiftSessionData();

    await showOperatorSelectionModal();
    if (!isShiftClockedIn()) return;

    if (typeof LiveTracking !== 'undefined') {
        LiveTracking.login(currentOperator);
    }

    updateClockButtonUI();
    updateShiftFooterDisplay();
    saveShiftSessionToStorage();
    saveStateToStorage();
}

async function handleClockOut() {
    if (!isShiftClockedIn()) {
        alert('You are not clocked in.');
        return;
    }

    if (isJobLoadedOnMachine()) {
        alert('Please finish or cancel the current job before clocking out.');
        return;
    }

    if (!confirm(`Clock out operator "${currentOperator}"?\n\nYour shift summary will be shown.`)) {
        return;
    }

    const clockOutAt = Date.now();
    const operatorName = currentOperator;

    showShiftSummary({ endAt: clockOutAt, operatorName, forClockOut: true });

    if (typeof LiveTracking !== 'undefined') {
        await LiveTracking.logout('manual');
    }

    clearOperatorForNewShift();
    updateClockButtonUI();
    updateShiftFooterDisplay();
    saveStateToStorage();
}

// ==================== Database Helper Functions ====================

// Use current host for API calls (works on both localhost and network)
const API_BASE_URL = `${window.location.protocol}//${window.location.host}/api`;

// Save or update job in database
// Save or update job in database
async function createJobInDatabase(jobData) {
    try {
        const response = await fetch(`${API_BASE_URL}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobNumber: jobData.jobNumber,
                poNumber: jobData.poNumber || jobData.jobNumber,
                itemNo: jobData.itemNo || '',
                jobName: jobData.jobName,
                processCode: jobData.uPCode || jobData.processCode || '',
                targetQuantity: jobData.plannedQuantity || 0,
                // If sub-process is selected (e.g. DieCutting variants), append it to machine name
                machineName: machineInfo.subProcess
                    ? `${machineInfo.name} (${machineInfo.subProcess})`
                    : machineInfo.name,
                operator_name: currentOperator,
                shiftType: getCurrentShift(),
                shiftDate: new Date().toISOString().split('T')[0]
            })
        });

        const result = await response.json();
        if (result.success) {
            console.log('✓ Job created in database:', result.jobId);
            return result.jobId;
        } else {
            console.error('Failed to create job:', result.error);
        }
    } catch (error) {
        console.error('Error creating job in database:', error);
    }
    return null;
}

// Update job time breakdown in database
async function updateJobTimeBreakdown(jobId, timeBreakdown) {
    try {
        const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/time-breakdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeBreakdown })
        });

        const result = await response.json();
        if (!result.success) {
            console.error('Failed to update time breakdown:', result.error);
        }
    } catch (error) {
        console.error('Error updating time breakdown:', error);
    }
}

// Complete job in database
// Complete job in database (DEPRECATED - Use completeJobInDatabase instead)
async function unused_completeJobInDatabase(jobId, completionData) {
    try {
        const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                makereadySeconds: completionData.makereadySeconds || 0,
                runningSeconds: completionData.runningSeconds || 0,
                totalSessionSeconds: completionData.totalSessionSeconds || 0,
                sheetsProcessed: completionData.sheetsProcessed || 0,
                wastedSheets: completionData.wastedSheets || 0,
                machineSpeed: completionData.machineSpeed || 0,
                remarks: completionData.remarks || '',
                completedBy: 'Operator' // You can add operator login later
            })
        });

        const result = await response.json();
        if (result.success) {
            console.log('✓ Job completed in database');
        } else {
            console.error('Failed to complete job:', result.error);
        }
    } catch (error) {
        console.error('Error completing job in database:', error);
    }
}

// Cancel job in database
async function cancelJobInDatabase(jobId) {
    try {
        const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const result = await response.json();
        if (result.success) {
            console.log('✓ Job cancelled in database');
        } else {
            console.error('Failed to cancel job:', result.error);
        }
    } catch (error) {
        console.error('Error cancelling job in database:', error);
    }
}

// Update shift timers in database
async function updateShiftTimers() {
    try {
        const response = await fetch(`${API_BASE_URL}/shifts/update-timers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                machineName: machineInfo.name,
                shiftDate: new Date().toISOString().split('T')[0],
                shiftType: getCurrentShift(),
                stateTimers: stateTimers
            })
        });

        const result = await response.json();
        if (!result.success) {
            console.error('Failed to update shift timers:', result.error);
        }
    } catch (error) {
        console.error('Error updating shift timers:', error);
    }
}

// Log state change in database
async function logStateChange(stateName, startedAt, endedAt, durationSeconds) {
    try {
        const response = await fetch(`${API_BASE_URL}/state-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                machineName: machineInfo.name,
                jobId: currentJobId,
                stateName: stateName,
                startedAt: startedAt.toISOString(),
                endedAt: endedAt ? endedAt.toISOString() : null,
                durationSeconds: durationSeconds,
                shiftDate: new Date().toISOString().split('T')[0],
                shiftType: getCurrentShift()
            })
        });

        const result = await response.json();
        if (!result.success) {
            console.error('Failed to log state change:', result.error);
        }
    } catch (error) {
        console.error('Error logging state change:', error);
    }
}

// Test database connection
async function testDatabaseConnection() {
    try {
        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000)
        });

        if (response.ok) {
            const result = await response.json();
            if (result.databaseConnected) {
                console.log('✅ Database connected - data will be saved automatically');
            } else {
                console.warn('⚠️ Database not connected - data saved locally only');
            }
        }
    } catch (error) {
        console.warn('⚠️ Backend not available - data saved locally only');
    }
}

// Shift helpers
function getCurrentShift() {
    const now = new Date();
    const hour = now.getHours();
    // Day shift: 9AM-8PM, Night shift: 8PM-9AM
    if (hour >= 9 && hour < 20) {
        return 'day';
    }
    return 'night';
}

function getShiftName(shift) {
    return shift === 'day' ? 'Day Shift (9AM-8PM)' : 'Night Shift (8PM-9AM)';
}

// Initialize shift and check for shift changes
function initializeShift() {
    const newShift = getCurrentShift();

    if (currentShift === null) {
        // First initialization
        currentShift = newShift;
        shiftStartTime = new Date();
        console.log(`🌅 Shift initialized: ${getShiftName(newShift)}`);
    } else if (currentShift !== newShift) {
        // Shift changed - reset timers
        console.log(`🔄 Shift changed from ${currentShift} to ${newShift}`);

        // Reset ALL state timers when shift changes
        stateTimers = {
            makeready: 0,
            running: 0,
            lunch: 0,
            cleaning: 0,
            waiting_qc: 0,
            waiting_die: 0,
            waiting_input: 0,
            line_clearance: 0,
            downtime_elec: 0,
            downtime_mech: 0,
            downtime: 0,
            idle: 0,
            feeder_trip: 0,
            sticky_sheets: 0,
            sorting_waiting: 0
        };

        // Reset timer if currently running
        if (timerInterval) {
            timerSeconds = 0;
            updateTimerDisplay();
            updateFooterStats();
        }

        currentShift = newShift;
        shiftStartTime = new Date();

        console.log(`✅ Timers reset for ${getShiftName(newShift)}`);
    }
}

// Check for shift change periodically
function startShiftMonitoring() {
    // Check every minute for shift change and update changeover button
    setInterval(() => {
        initializeShift();
        updateShiftChangeoverButton();
    }, 60000); // Check every 60 seconds
}

// Check if current time is in shift changeover window
function isShiftChangeoverTime() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Convert to total minutes since midnight
    const currentMinutes = hour * 60 + minute;

    // Changeover windows: 
    // Morning: 8:30-9:30 AM (510-570 minutes) - for day shift start at 9AM
    // Evening: 7:30-8:30 PM (1170-1230 minutes) - for night shift start at 8PM
    const morningStart = 8 * 60 + 30;   // 8:30 AM = 510 minutes
    const morningEnd = 9 * 60 + 30;     // 9:30 AM = 570 minutes
    const eveningStart = 19 * 60 + 30;  // 7:30 PM = 1170 minutes
    const eveningEnd = 20 * 60 + 30;    // 8:30 PM = 1230 minutes

    return (currentMinutes >= morningStart && currentMinutes <= morningEnd) ||
        (currentMinutes >= eveningStart && currentMinutes <= eveningEnd);
}

// Update shift changeover button status
function updateShiftChangeoverButton() {
    const changeoverBtn = document.getElementById('shift-changeover-btn-main');
    const timeStatus = document.getElementById('changeover-time-status-main');

    if (!changeoverBtn || !timeStatus) return;

    const nextShift = getCurrentShift() === 'day' ? 'night' : 'day';

    // Shift changeover is now available 24/7
    changeoverBtn.disabled = false;
    timeStatus.textContent = `Switch → ${nextShift} shift`;
    changeoverBtn.classList.add('ready');
}

// Handle shift changeover
async function handleShiftChangeover() {
    const currentShiftName = getShiftName(currentShift);
    const nextShift = currentShift === 'day' ? 'night' : 'day';
    const nextShiftName = getShiftName(nextShift);

    // Check if there's an active job that needs to be finished first
    if (selectedJob && selectedJob.isActive) {
        const hasActiveJob = confirm(
            `⚠️ Active Job Detected!\n\n` +
            `Job ${selectedJob.jobNumber} is currently active.\n\n` +
            `Before shift changeover, you need to:\n` +
            `• Enter production details (sheets processed, waste, speed)\n` +
            `• Save the job data\n\n` +
            `Click OK to enter production details, or Cancel to abort shift changeover.`
        );

        if (!hasActiveJob) {
            return;
        }

        // Show shift changeover production modal
        const productionSaved = await showShiftChangeoverProductionModal();
        
        if (!productionSaved) {
            alert('Shift changeover cancelled. Please complete the production details to proceed.');
            return;
        }
    }

    const confirmed = confirm(
        `🔄 Shift Changeover\n\n` +
        `Current Shift: ${currentShiftName}\n` +
        `New Shift: ${nextShiftName}\n\n` +
        `This will:\n` +
        `• Save current shift data\n` +
        `• Reset all timers to zero\n` +
        `• Start fresh for new shift\n\n` +
        `Are you sure you want to proceed?`
    );

    if (!confirmed) {
        return;
    }

    // If no active job was processed during changeover, set pending shift end time
    // This will be added to the remarks of the first job in the new shift
    if (!selectedJob || !selectedJob.isActive) {
        const currentShiftType = currentShift;
        const shiftEndTime = currentShiftType === 'day' ? '8:00 PM' : '9:00 AM';
        pendingShiftEndTime = {
            time: shiftEndTime,
            shift: currentShiftType,
            timestamp: new Date().toISOString()
        };
        console.log('📝 Set pending shift end time for next job:', pendingShiftEndTime);
    }

    console.log('🔄 Starting shift changeover...');
    console.log('From:', currentShiftName, '→ To:', nextShiftName);

    // Save current shift data before resetting
    const oldShiftData = {
        shift: currentShift,
        shiftName: currentShiftName,
        stateTimers: { ...stateTimers },
        completedJobs: [...completedJobs],
        operator: currentOperator,
        timestamp: new Date().toISOString()
    };

    console.log('📊 Old shift data saved:', oldShiftData);

    // Force shift change
    currentShift = nextShift;
    shiftStartTime = new Date();

    // Reset ALL state timers
    stateTimers = {
        makeready: 0,
        running: 0,
        lunch: 0,
        cleaning: 0,
        waiting_qc: 0,
        waiting_die: 0,
        waiting_input: 0,
        line_clearance: 0,
        downtime_elec: 0,
        downtime_mech: 0,
        downtime: 0,
        idle: 0
    };

    // Reset timer if currently running
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    timerSeconds = 0;
    stateStartTimestamp = null;
    accumulatedStateTime = 0;
    currentMachineState = null;

    // Clear active job state
    activeJobNumber = null;
    activeJobState = null;
    selectedJob = null;
    
    // Re-enable PO input after shift change
    updatePOInputState();

    // Reset completed/cancelled jobs for new shift
    completedJobs = [];
    cancelledJobs = [];
    currentJobs = [];
    
    // Clear operator for new shift (will prompt for new selection)
    clearOperatorForNewShift();

    // Update UI
    updateTimerDisplay();
    updateFooterStats();
    renderJobQueue(currentJobs);

    // Clear job details display
    const jobNumberEl = document.getElementById('selected-job-number');
    if (jobNumberEl) jobNumberEl.textContent = '--';
    const jobNameEl = document.getElementById('selected-job-name');
    if (jobNameEl) jobNameEl.textContent = 'Select a job from "Search PO"';
    const itemNoEl = document.getElementById('selected-job-itemno');
    if (itemNoEl) itemNoEl.textContent = '-';
    const quantityEl = document.getElementById('selected-job-quantity');
    if (quantityEl) quantityEl.textContent = '-';
    const statusEl = document.getElementById('selected-job-status');
    if (statusEl) statusEl.textContent = 'No Job Selected';

    // Remove active state from all buttons
    document.querySelectorAll('.control-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Update state label
    const stateLabel = document.getElementById('current-state-label');
    if (stateLabel) {
        stateLabel.textContent = `${nextShiftName} - Select a job to start tracking`;
    }

    // Save state to localStorage
    saveStateToStorage();

    console.log(`✅ Shift changeover complete! New shift: ${nextShiftName}`);

    alert(
        `✅ Shift Changeover Complete!\n\n` +
        `New Shift: ${nextShiftName}\n` +
        `All timers have been reset.\n` +
        `Production data has been saved.\n\n` +
        `Please select the operator for the new shift.`
    );

    // Update changeover button
    updateShiftChangeoverButton();
    
    // Show operator selection for new shift
    await showOperatorSelectionModal();
    
    console.log(`👤 New operator selected for ${nextShiftName}: ${currentOperator}`);
}

// Show production modal for shift changeover
function showShiftChangeoverProductionModal() {
    return new Promise((resolve) => {
        // Calculate current timer values
        if (currentMachineState && stateStartTimestamp) {
            timerSeconds = calculateCurrentTimerSeconds();
            stateTimers[currentMachineState] = timerSeconds;
            if (selectedJob && selectedJob.timeBreakdown) {
                selectedJob.timeBreakdown[currentMachineState] = timerSeconds;
            }
        }

        const timeBreakdown = selectedJob?.timeBreakdown || {};
        const makereadyTime = timeBreakdown.makeready || 0;
        const runningTime = timeBreakdown.running || 0;
        const totalTime = Object.values(timeBreakdown).reduce((a, b) => a + (b || 0), 0);
        
        // Check machine type for field configuration
        const isLamination = isLaminationMachine();
        const isNarendra = isNarendraMachine();

        // Build form fields based on machine type
        let productionFieldsHTML = '';
        
        if (isNarendra) {
            // Narendra: Quantity + Wastage (Machine Speed removed)
            productionFieldsHTML = `
                <div class="form-group">
                    <label for="shift-sheets-processed">Quantity Processed *</label>
                    <input type="number" id="shift-sheets-processed" required min="0" 
                        style="width: 100%; padding: 12px; font-size: 1rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary);"
                        placeholder="Enter quantity processed">
                </div>
                <div class="form-group">
                    <label for="shift-wasted-sheets">Wastage *</label>
                    <input type="number" id="shift-wasted-sheets" required min="0" value="0"
                        style="width: 100%; padding: 12px; font-size: 1rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary);"
                        placeholder="Enter wastage">
                </div>
            `;
        } else {
            // Standard: Sheets + Wasted (Machine Speed removed)
            productionFieldsHTML = `
                <div class="form-group">
                    <label for="shift-sheets-processed">Quantity Processed *</label>
                    <input type="number" id="shift-sheets-processed" required min="0" 
                        style="width: 100%; padding: 12px; font-size: 1rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary);"
                        placeholder="Enter quantity processed">
                </div>
                <div class="form-group">
                    <label for="shift-wasted-sheets">Wasted Sheets *</label>
                    <input type="number" id="shift-wasted-sheets" required min="0" value="0"
                        style="width: 100%; padding: 12px; font-size: 1rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary);"
                        placeholder="Enter wasted sheets">
                </div>
            `;
        }
        
        // Build remarks section based on machine type
        const isFolding = isFoldingPastingMachine();
        let remarksHTML = '';
        if (isFolding) {
            // Folding & Pasting: PKD, No. of Pcs/Carton, Additional Remarks
            remarksHTML = `
                <h4 style="margin: 15px 0 10px; color: var(--text-primary); font-size: 0.95rem;">Folding & Pasting Details</h4>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div class="form-group">
                        <label for="shift-fold-pkd">PKD (Date)</label>
                        <input type="date" id="shift-fold-pkd" style="width: 100%; padding: 10px; font-size: 0.9rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary);">
                    </div>
                    <div class="form-group">
                        <label for="shift-fold-num-cartons">No. of Pcs/Carton *</label>
                        <input type="number" id="shift-fold-num-cartons" min="1" style="width: 100%; padding: 10px; font-size: 0.9rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary);" placeholder="e.g. 50" required>
                    </div>
                </div>
                <div class="form-group" style="margin-top: 10px;">
                    <label for="shift-fold-extra-remarks">Additional Remarks</label>
                    <textarea id="shift-fold-extra-remarks" rows="2" style="width: 100%; padding: 10px; font-size: 0.9rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary); resize: none;" placeholder="Any additional notes..."></textarea>
                </div>
            `;
        } else {
            // Standard remarks
            remarksHTML = `
                <div class="form-group">
                    <label for="shift-remarks">Remarks</label>
                    <textarea id="shift-remarks" rows="2"
                        style="width: 100%; padding: 12px; font-size: 1rem; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary); resize: none;"
                        placeholder="Shift changeover - partial job"></textarea>
                </div>
            `;
        }

        // Create modal HTML
        const modalHTML = `
            <div class="modal-overlay active" id="shift-production-modal-overlay">
                <div class="modal-content" style="max-width: ${(isLamination || isFolding) ? '550px' : '500px'};">
                    <div class="modal-header">
                        <h2 class="modal-title">📊 Enter Production Details</h2>
                    </div>
                    <div class="modal-body" style="max-height: 70vh; overflow-y: auto;">
                        <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                            <p style="margin: 0; color: #f59e0b; font-size: 0.9rem;">
                                ⚠️ <strong>Shift Changeover:</strong> Please enter production details for job <strong>${selectedJob?.jobNumber || 'Unknown'}</strong> before changing shift.
                            </p>
                        </div>
                        
                        <div style="background: rgba(59, 130, 246, 0.1); border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; text-align: center;">
                                <div>
                                    <div style="font-size: 0.7rem; color: var(--text-muted);">Make Ready</div>
                                    <div style="font-size: 1.1rem; font-weight: 600; color: #f59e0b;">${formatTime(makereadyTime)}</div>
                                </div>
                                <div>
                                    <div style="font-size: 0.7rem; color: var(--text-muted);">Running</div>
                                    <div style="font-size: 1.1rem; font-weight: 600; color: #10b981;">${formatTime(runningTime)}</div>
                                </div>
                                <div>
                                    <div style="font-size: 0.7rem; color: var(--text-muted);">Total</div>
                                    <div style="font-size: 1.1rem; font-weight: 600; color: #3b82f6;">${formatTime(totalTime)}</div>
                                </div>
                            </div>
                        </div>

                        <form id="shift-production-form">
                            ${productionFieldsHTML}
                            ${remarksHTML}
                            <div class="modal-actions" style="margin-top: 20px; display: flex; gap: 10px;">
                                <button type="button" class="btn-secondary" id="shift-production-cancel" style="flex: 1; padding: 12px;">
                                    Cancel
                                </button>
                                <button type="submit" class="btn-primary" id="shift-production-submit" style="flex: 2; padding: 12px;">
                                    ✓ Save & Continue Changeover
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        `;

        // Add modal to page
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        const modal = document.getElementById('shift-production-modal-overlay');
        const form = document.getElementById('shift-production-form');
        const cancelBtn = document.getElementById('shift-production-cancel');

        // Handle cancel
        cancelBtn.addEventListener('click', () => {
            modal.remove();
            resolve(false);
        });

        // Handle form submit
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            let sheetsProcessed, wastedSheets, machineSpeed, remarks;
            
            if (isNarendra) {
                // Narendra: Quantity + Wastage
                sheetsProcessed = parseInt(document.getElementById('shift-sheets-processed').value) || 0;
                wastedSheets = parseInt(document.getElementById('shift-wasted-sheets').value) || 0;
                machineSpeed = 0;
                
                if (sheetsProcessed <= 0) {
                    alert('Please enter quantity processed');
                    return;
                }
                if (wastedSheets < 0) {
                    alert('Please enter wastage');
                    return;
                }
            } else {
                // Standard fields
                sheetsProcessed = parseInt(document.getElementById('shift-sheets-processed').value) || 0;
                wastedSheets = parseInt(document.getElementById('shift-wasted-sheets').value) || 0;
                machineSpeed = 0;
                
                // Validate standard fields
                if (sheetsProcessed <= 0) {
                    alert('Please enter quantity processed');
                    return;
                }
            }
            
            // Build remarks
            if (isFolding) {
                // Folding & Pasting remarks
                const parts = [];
                const pkd = document.getElementById('shift-fold-pkd')?.value;
                const numCartons = document.getElementById('shift-fold-num-cartons')?.value;
                const extraRemarks = document.getElementById('shift-fold-extra-remarks')?.value;
                
                // Validate number of cartons
                if (!numCartons || parseInt(numCartons) <= 0) {
                    alert('Please enter Number of Pcs/Carton');
                    return;
                }
                
                if (pkd) parts.push(`PKD: ${pkd}`);
                if (numCartons) parts.push(`Pcs/Carton: ${numCartons}`);
                
                remarks = parts.length > 0 ? parts.join(' | ') : '';
                
                // Add extra remarks at the end if provided
                if (extraRemarks && extraRemarks.trim()) {
                    remarks = remarks ? `${remarks} | Notes: ${extraRemarks.trim()}` : `Notes: ${extraRemarks.trim()}`;
                }
                
                if (!remarks) remarks = 'Shift changeover - partial job';
            } else {
                remarks = document.getElementById('shift-remarks')?.value || 'Shift changeover - partial job';
            }

            // Get packing details (number of cartons) for folding/pasting
            let packingDetails = '';
            if (isFolding) {
                const numCartons = document.getElementById('shift-fold-num-cartons')?.value;
                if (numCartons) {
                    packingDetails = numCartons;  // U_nopkg = number of pieces per carton
                }
            }

            // Prepare job data
            const jobData = {
                jobNumber: selectedJob.jobNumber,
                poNumber: selectedJob.poNumber || selectedJob.jobNumber,
                itemNo: selectedJob.itemNo || '',
                jobName: selectedJob.jobName || '',
                plannedQuantity: selectedJob.plannedQuantity || 0,
                sheetsProcessed: sheetsProcessed,
                wastedSheets: wastedSheets,
                machineSpeed: machineSpeed,
                remarks: remarks,
                isLamination: isLamination,
                isNarendra: isNarendra,
                isFoldingPasting: isFolding,
                jobStartTime: selectedJob.jobStartTime || getISTTimestamp(),
                completedAt: getISTTimestamp(),
                shift: getCurrentShift(),
                timeBreakdown: selectedJob.timeBreakdown || {},
                // SAP posting fields
                absoluteEntry: selectedJob.absoluteEntry || null,
                uJobEnt: selectedJob.uJobEnt ?? null,
                packingDetails: packingDetails  // U_nopkg for SAP
            };

            console.log('📊 Saving shift changeover production data:', jobData);

            // Save to database
            try {
                await completeJobInDatabase(jobData, makereadyTime, runningTime);
                console.log('✅ Production data saved to database');
                
                // Add to completed jobs
                completedJobs.push(jobData);
                
                // Remove modal
                modal.remove();
                resolve(true);
            } catch (error) {
                console.error('❌ Error saving production data:', error);
                alert('Error saving data. Please try again.');
            }
        });

        // Prevent closing by clicking outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                alert('Please enter production details or click Cancel');
            }
        });
    });
}

// Initialize page
document.addEventListener('DOMContentLoaded', function () {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const process = urlParams.get('process');
        const machine = urlParams.get('machine');

        // Store machine info for database operations
        machineInfo.name = machine;
        machineInfo.process = process;

        // Live tracking: identify this machine to the server
        if (machine && typeof LiveTracking !== 'undefined') {
            LiveTracking.configure({
                machineId: machine,
                machineName: machine,
                process: process || null
            });
        }

        // Try to restore state from localStorage
        const stateRestored = loadStateFromStorage();

        // Restore clock-in session (operator + timer + session summary data)
        if (machine) {
            restoreShiftOperatorFromStorage();
            loadShiftSessionFromStorage();
            updateShiftFooterDisplay();
        }
        
        updateMachineInfo(process, machine);
        renderJobQueue(currentJobs);
        setupEventListeners();
        
        // Update PO input state based on restored active job
        updatePOInputState();

        // Initialize shift tracking
        initializeShift();
        startShiftMonitoring();

        // Initialize shift changeover button
        updateShiftChangeoverButton();

        // Test database connection and enable sync if available
        testDatabaseConnection();
        
        // If state was restored, resume the timer and update UI FIRST
        // This ensures timer continues even while operator modal is shown
        if (stateRestored && currentMachineState) {
            console.log('🔄 Resuming timer from saved state...');
            
            // Calculate elapsed time since state was saved
            timerSeconds = calculateCurrentTimerSeconds();
            stateTimers[currentMachineState] = timerSeconds;
            
            // Update UI to reflect restored state
            updateTimerDisplay();
            updateFooterStats();
            
            // Highlight active state button
            document.querySelectorAll('.control-btn').forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.state === currentMachineState) {
                    btn.classList.add('active');
                }
            });
            
            // Update state label
            const stateLabels = {
                'makeready': 'Make Ready',
                'running': 'Running',
                'lunch': 'Lunch Break',
                'cleaning': 'Cleaning',
                'waiting_qc': 'Waiting QC',
                'waiting_die': 'Waiting Die',
                'waiting_input': 'Waiting Input',
                'line_clearance': 'Line Clearance',
                'downtime_elec': 'Downtime (Electrical)',
                'downtime_mech': 'Downtime (Mechanical)',
                'feeder_trip': 'Feeder Trip',
                'sticky_sheets': 'Sticky Sheets',
                'sorting_waiting': 'Sorting Waiting'
            };
            const currentStateLabel = document.getElementById('current-state-label');
            if (currentStateLabel) {
                currentStateLabel.textContent = stateLabels[currentMachineState] || currentMachineState;
            }
            
            // Show selected job details if any
            if (selectedJob) {
                showJobDetails(selectedJob);
                
                // Refresh SAP data (issued/completed quantities) in the background
                // This ensures the display reflects the latest backend state after page refresh
                refreshSAPDataForJob(selectedJob).catch(err => {
                    console.warn('⚠️ Could not refresh SAP data on page load:', err.message);
                });
            }
            
            // Resume timer - this will continue running even with modal open
            startTimer();
            console.log('⏱️ Timer resumed successfully');
        }
        
        updateClockButtonUI();

        // Setup visibility change handler (for when screen turns on/off)
        setupVisibilityHandler();
        
        // Setup beforeunload handler (for when navigating away)
        setupBeforeUnloadHandler();

        startShiftFooterTimer();

        console.log('Production Management System initialized');
    } catch (err) {
        console.error('Error initializing page:', err);
        alert('Error loading page. Please refresh.');
    }
});

// Handle page visibility changes (screen on/off)
function setupVisibilityHandler() {
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            console.log('📱 Screen turned ON - recalculating timer');
            
            // Recalculate timer from timestamp
            if (currentMachineState && stateStartTimestamp) {
                timerSeconds = calculateCurrentTimerSeconds();
                stateTimers[currentMachineState] = timerSeconds;
                
                // Update job's time breakdown
                if (selectedJob && selectedJob.timeBreakdown) {
                    selectedJob.timeBreakdown[currentMachineState] = timerSeconds;
                }
                
                updateTimerDisplay();
                updateFooterStats();
                
                console.log(`   Timer updated to: ${formatTime(timerSeconds)}`);
            }
        } else {
            console.log('📱 Screen turned OFF - saving state');
            saveStateToStorage();
        }
    });
}

// Handle page unload (navigating away)
function setupBeforeUnloadHandler() {
    window.addEventListener('beforeunload', function (e) {
        console.log('🚪 Page unloading - saving state');
        
        // Update timer one last time
        if (currentMachineState && stateStartTimestamp) {
            timerSeconds = calculateCurrentTimerSeconds();
            stateTimers[currentMachineState] = timerSeconds;
            
            if (selectedJob && selectedJob.timeBreakdown) {
                selectedJob.timeBreakdown[currentMachineState] = timerSeconds;
            }
        }
        
        // Save to localStorage
        saveStateToStorage();
    });
    
    // Also save when clicking back button
    window.addEventListener('pagehide', function () {
        saveStateToStorage();
    });
}

// Update machine information
function updateMachineInfo(process, machine) {
    try {
    const machineNameEl = document.getElementById('machine-name');
    const processNameEl = document.getElementById('process-name');
    const diecuttingContainer = document.getElementById('diecutting-options-container');
    const diecuttingSelect = document.getElementById('diecutting-process-select');
    const foldingContainer = document.getElementById('folding-options-container');
    const foldingSelect = document.getElementById('folding-process-select');
    const foilingContainer = document.getElementById('foiling-options-container');
    const foilingSelect = document.getElementById('foiling-process-select');

    if (machine && process) {
        machineNameEl.textContent = formatMachineName(machine);
        processNameEl.textContent = formatProcessName(process);

        // Reset all dropdowns first
        if (diecuttingContainer) diecuttingContainer.style.display = 'none';
        if (foldingContainer) foldingContainer.style.display = 'none';
        if (foilingContainer) foilingContainer.style.display = 'none';
        processNameEl.style.display = 'inline-block';

        // CHECK IF PROCESS IS DIECUTTING (Case insensitive)
        // Checks for 'diecutting', 'die-cutting', or 'die cutting'
        if (process.toLowerCase().includes('diecutting') ||
            process.toLowerCase().includes('die-cutting') ||
            process.toLowerCase().includes('die cutting')) {

            // SHOW DieCutting Dropdown
            diecuttingContainer.style.display = 'flex';

            // HIDE Static Badge (User request: dropdown replaces badge for this process)
            processNameEl.style.display = 'none';

            // Allow user to select sub-process
            diecuttingSelect.onchange = function () {
                // Update the tracked process info when selection changes
                machineInfo.subProcess = this.value;
                console.log('Sub-process selected:', machineInfo.subProcess);
                // Save state when sub-process changes
                saveStateToStorage();
            };

            // Restore saved sub-process or use default
            if (machineInfo.subProcess && Array.from(diecuttingSelect.options).some(opt => opt.value === machineInfo.subProcess)) {
                diecuttingSelect.value = machineInfo.subProcess;
                console.log('📋 Restored DieCutting sub-process:', machineInfo.subProcess);
            } else {
            machineInfo.subProcess = diecuttingSelect.value;
            }
        } 
        // Show dropdown for folding-pasting process
        else if (process.toLowerCase().includes('pasting') ||
                 process.toLowerCase().includes('folding') ||
                 process.toLowerCase().includes('fold')) {

            // SHOW Folding/Pasting Dropdown
            foldingContainer.style.display = 'flex';

            // HIDE Static Badge
            processNameEl.style.display = 'none';

            // Allow user to select sub-process
            foldingSelect.onchange = function () {
                machineInfo.subProcess = this.value;
                console.log('Sub-process selected:', machineInfo.subProcess);
                // Save state when sub-process changes
                saveStateToStorage();
            };

            // Restore saved sub-process or use default
            if (machineInfo.subProcess && Array.from(foldingSelect.options).some(opt => opt.value === machineInfo.subProcess)) {
                foldingSelect.value = machineInfo.subProcess;
                console.log('📋 Restored Folding sub-process:', machineInfo.subProcess);
            } else {
            machineInfo.subProcess = foldingSelect.value;
            }
        }
        // For Lamination - default process name is "Lamination"
        else if (process.toLowerCase().includes('lamination')) {
            machineInfo.subProcess = 'Lamination';
        }
        // Unit 1 - Holographic processes
        else if (
            process.toLowerCase().includes('embossing') ||
            process.toLowerCase().includes('rewinding') ||
            process.toLowerCase().includes('slitting') ||
            process.toLowerCase().includes('metallisation') ||
            process.toLowerCase().includes('metallization')
        ) {
            machineInfo.subProcess = formatProcessName(process);
        }
        // For Foiling - show dropdown with Foiling + DieCutting options
        else if (process.toLowerCase().includes('foiling')) {
            // SHOW Foiling Dropdown
            foilingContainer.style.display = 'flex';

            // HIDE Static Badge
            processNameEl.style.display = 'none';

            // Allow user to select sub-process
            foilingSelect.onchange = function () {
                machineInfo.subProcess = this.value;
                console.log('Sub-process selected:', machineInfo.subProcess);
                // Save state when sub-process changes
                saveStateToStorage();
            };

            // Restore saved sub-process or use default
            if (machineInfo.subProcess && Array.from(foilingSelect.options).some(opt => opt.value === machineInfo.subProcess)) {
                foilingSelect.value = machineInfo.subProcess;
                console.log('📋 Restored Foiling sub-process:', machineInfo.subProcess);
            } else {
                machineInfo.subProcess = foilingSelect.value;
            }
        }
        else {
            machineInfo.subProcess = null;
        }

        // Toggle Running Pause buttons based on machine type
        const stickyBtn = document.getElementById('state-sticky_sheets');
        const sortingBtn = document.getElementById('state-sorting_waiting');

        if (process.toLowerCase().includes('pasting') ||
            process.toLowerCase().includes('folding') ||
            process.toLowerCase().includes('fold')) {
            // For Pasting/Folding machines: hide Sticky Sheets, show Sorting Waiting
            if (stickyBtn) stickyBtn.style.display = 'none';
            if (sortingBtn) sortingBtn.style.display = 'flex';
        } else {
            // For other machines: show Sticky Sheets, hide Sorting Waiting
            if (stickyBtn) stickyBtn.style.display = 'flex';
            if (sortingBtn) sortingBtn.style.display = 'none';
        }
    } else {
        machineNameEl.textContent = 'Machine Dashboard';
        processNameEl.textContent = 'Production';
        if (diecuttingContainer) diecuttingContainer.style.display = 'none';
        if (foldingContainer) foldingContainer.style.display = 'none';
        if (foilingContainer) foilingContainer.style.display = 'none';
    }
    } catch (error) {
        console.error('Error in updateMachineInfo:', error);
    }
}

function formatMachineName(machine) {
    return machine.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function formatProcessName(process) {
    return process.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' & ');
}

// Render job queue
function renderJobQueue(jobs) {
    const jobQueueEl = document.getElementById('job-queue');
    const jobCountEl = document.getElementById('job-count');

    // Check if elements exist before using them
    if (jobCountEl) {
        jobCountEl.textContent = jobs.length;
    }

    if (jobQueueEl) {
        jobQueueEl.innerHTML = '';
        jobs.forEach((job, index) => {
            const jobCard = createJobCard(job, index);
            jobQueueEl.appendChild(jobCard);
        });
    }

    console.log(`Job queue updated: ${jobs.length} jobs`);
}

// Create job card
function createJobCard(job, index) {
    const card = document.createElement('div');
    card.className = `job-card status-${job.state.toLowerCase().replace(' ', '')}`;
    card.style.animationDelay = `${index * 0.1}s`;
    card.dataset.jobNumber = job.jobNumber;

    const statusClass = getStatusClass(job.state);
    
    // Build estimates HTML if available
    let estimatesHtml = '';
    if (job.estimates && job.estimates.bestMakeReadyMinutes !== null) {
        const bestMakeReadyMins = Math.round(job.estimates.bestMakeReadyMinutes);
        const estRunningMins = job.estimates.estimatedRunningMinutes 
            ? Math.round(job.estimates.estimatedRunningMinutes) 
            : '--';
        const totalEstimateMins = Math.round(job.estimates.bestMakeReadyMinutes + (job.estimates.estimatedRunningMinutes || 0));
        
        // Machine names for best records
        const bestMRMachine = job.estimates.bestMakeReadyMachine || 'N/A';
        const bestRunMachine = job.estimates.bestRunningMachine || 'N/A';
        
        estimatesHtml = `
            <div class="job-estimates" style="background: linear-gradient(135deg, #f0fdf4 0%, #ecfeff 100%); border: 1px solid #86efac; border-radius: 6px; padding: 8px; margin-top: 8px; font-size: 11px;">
                <div style="color: #166534; font-weight: 600; margin-bottom: 4px;">📊 Est. (${job.estimates.jobCount} jobs)</div>
                <div style="display: flex; gap: 8px; color: #475569;">
                    <span>MR: <strong style="color: #059669;">${bestMakeReadyMins} min</strong></span>
                    <span>Run: <strong style="color: #2563eb;">${estRunningMins} min</strong></span>
                    <span>Total: <strong>${totalEstimateMins} min</strong></span>
                </div>
                <div style="font-size: 10px; color: #94a3b8; margin-top: 2px;">Best on: ${bestMRMachine}</div>
            </div>
        `;
    }

    card.innerHTML = `
        <div class="job-card-header">
            <div class="job-number">${job.jobNumber}</div>
            <span class="job-status ${statusClass}">${job.state}</span>
        </div>
        <div class="job-name">${job.jobName}</div>
        <div class="job-details">
            <div class="job-detail-item">
                <span class="job-detail-label">Quantity</span>
                <span class="job-detail-value">${job.plannedQuantity.toLocaleString()}</span>
            </div>
            <div class="job-detail-item">
                <span class="job-detail-label">Ups</span>
                <span class="job-detail-value">${job.numOfUps}</span>
            </div>
        </div>
        ${estimatesHtml}
    `;

    card.addEventListener('click', () => selectJob(job));
    return card;
}

function getStatusClass(state) {
    const stateMap = {
        'Running': 'running',
        'running': 'running',
        'Make Ready': 'makeready',
        'MakeReady': 'makeready',
        'makeready': 'makeready',
        'In Queue': 'queue',
        'queue': 'queue',
        'On Hold': 'queue',
        'Idle': 'idle',
        'idle': 'idle',
        'Lunch Break': 'lunch',
        'lunch': 'lunch',
        'Cleaning': 'cleaning',
        'cleaning': 'cleaning',
        'Waiting QC': 'waiting',
        'waiting_qc': 'waiting',
        'Waiting Die': 'waiting',
        'waiting_die': 'waiting',
        'Waiting Input': 'waiting',
        'waiting_input': 'waiting',
        'Line Clearance': 'waiting',
        'line_clearance': 'waiting',
        'Downtime (Electrical)': 'downtime',
        'downtime_elec': 'downtime',
        'Downtime (Mechanical)': 'downtime',
        'downtime_mech': 'downtime',
        'downtime': 'downtime',
        'Feeder Trip': 'running-pause',
        'feeder_trip': 'running-pause',
        'Sticky Sheets': 'running-pause',
        'sticky_sheets': 'running-pause',
        'Sorting Waiting': 'running-pause',
        'sorting_waiting': 'running-pause'
    };
    return stateMap[state] || 'queue';
}

// FIX #3: Allow viewing any job card, but disable state buttons if another job is active
function selectJob(job) {
    selectedJob = job;
    currentJobId = job.dbJobId || null; // Set database job ID

    console.log('Job selected:', job.jobNumber, 'DB ID:', currentJobId);

    // Update active state on cards if they exist
    const jobCards = document.querySelectorAll('.job-card');
    if (jobCards.length > 0) {
        jobCards.forEach(card => {
            card.classList.remove('active');
            if (card.dataset.jobNumber === job.jobNumber) {
                card.classList.add('active');
            }
        });
    }

    showJobDetails(job);

    // Disable state buttons if another job is active and this is not that job
    const isAnotherJobActive = activeJobNumber && activeJobNumber !== job.jobNumber &&
        (activeJobState === 'running' || activeJobState === 'makeready');

    document.querySelectorAll('.state-button').forEach(btn => {
        if (isAnotherJobActive) {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
            btn.title = `Job ${activeJobNumber} is currently ${activeJobState === 'running' ? 'Running' : 'in Make Ready'}. Finish or cancel that job first.`;
        } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.title = '';
        }
    });

    // Show process selection reminder for DieCutting and Folding/Pasting machines (non-blocking)
    if (requiresProcessSelection()) {
        // Use setTimeout to ensure UI updates first, then show modal
        setTimeout(() => {
            showProcessSelectionReminder().catch(err => {
                console.error('Error showing process reminder:', err);
            });
        }, 100);
    }
}

// Show job details
function showJobDetails(job) {
    // Update job details in the card
    const jobNumberEl = document.getElementById('selected-job-number');
    if (jobNumberEl) {
        jobNumberEl.textContent = job.jobNumber;
    }

    const jobNameEl = document.getElementById('selected-job-name');
    if (jobNameEl) {
        jobNameEl.textContent = job.jobName;
    }

    const jobQuantityEl = document.getElementById('selected-job-quantity');
    if (jobQuantityEl) {
        jobQuantityEl.textContent = job.plannedQuantity ? job.plannedQuantity.toLocaleString() : '-';
    }

    const jobItemNoEl = document.getElementById('selected-job-itemno');
    if (jobItemNoEl) {
        jobItemNoEl.textContent = job.itemNo || '-';
    }

    // Check if this job requires base quantity division (U_PCode starts with DIE, or EMB+P)
    // For these jobs, issued quantity is in SHEETS but we display in CARTONS (only when planned qty > 0)
    const uPCode = (job.uPCode || '').toUpperCase();
    const plannedPositive = (job.plannedQuantity || 0) > 0;
    const needsDivision = plannedPositive &&
                          isDieProcessCodeForBaseQty(uPCode) &&
                          job.baseQuantities && job.baseQuantities.length > 0;
    
    // Get raw issued quantity from SAP (in sheets for DIE/EMB+P)
    let issuedQty = job.issuedQuantity || 0;
    let completedQty = job.completedQuantity || 0;
    
    console.log(`📊 showJobDetails - Raw values from job object:`);
    console.log(`   job.issuedQuantity: ${job.issuedQuantity}`);
    console.log(`   job.completedQuantity: ${job.completedQuantity}`);
    
    // For DIE/EMB+P jobs, convert sheets to cartons for display
    // Note: completedQuantity from SAP is already in cartons (SAP stores completion in cartons)
    // But issuedQuantity is in sheets, so we need to convert it
    if (needsDivision && issuedQty > 0) {
        // Calculate total base quantity divisor (sum of absolute base quantities)
        const totalBaseQty = job.baseQuantities.reduce((sum, bq) => sum + Math.abs(bq), 0);
        if (totalBaseQty > 0) {
            // Convert issued sheets to cartons
            issuedQty = Math.round(issuedQty / totalBaseQty * job.baseQuantities.length);
            console.log(`📊 Display conversion (U_PCode: ${uPCode}): Issued ${job.issuedQuantity} sheets → ${issuedQty} cartons`);
        }
    }
    
    // Display issued quantity (now in cartons for DIE/EMB+P)
    const jobIssuedEl = document.getElementById('selected-job-issued');
    if (jobIssuedEl) {
        jobIssuedEl.textContent = issuedQty > 0 ? issuedQty.toLocaleString() : '-';
    }

    // Display completed quantity and remaining quantity
    const remainingQty = issuedQty > 0 ? (issuedQty - completedQty) : 0;
    
    const jobCompletedEl = document.getElementById('selected-job-completed');
    if (jobCompletedEl) {
        if (issuedQty > 0) {
            jobCompletedEl.textContent = completedQty.toLocaleString();
        } else {
            jobCompletedEl.textContent = '-';
        }
    }
    
    const jobRemainingEl = document.getElementById('selected-job-remaining');
    if (jobRemainingEl) {
        if (issuedQty > 0) {
            jobRemainingEl.textContent = remainingQty.toLocaleString();
        } else {
            jobRemainingEl.textContent = '-';
        }
    }

    const statusBadge = document.getElementById('selected-job-status');
    if (statusBadge) {
        const displayState = job.isActive ? (job.state || 'Active') : 'In Queue';
        statusBadge.textContent = displayState;
        statusBadge.className = `status-badge ${getStatusClass(displayState)}`;
    }
    
    // Display historical performance estimates
    const estimatesContainer = document.getElementById('job-estimates-container');
    if (estimatesContainer) {
        if (job.estimates && job.estimates.bestMakeReadyMinutes !== null) {
            const bestMakeReadyMins = Math.round(job.estimates.bestMakeReadyMinutes);
            const estRunningMins = job.estimates.estimatedRunningMinutes 
                ? Math.round(job.estimates.estimatedRunningMinutes) 
                : '--';
            const totalEstimateMins = Math.round(job.estimates.bestMakeReadyMinutes + (job.estimates.estimatedRunningMinutes || 0));
            
            // Machine names for best records
            const bestMRMachine = job.estimates.bestMakeReadyMachine || 'N/A';
            const bestRunMachine = job.estimates.bestRunningMachine || 'N/A';
            
            // Calculate estimated completion time
            const totalEstimateMs = (job.estimates.bestMakeReadyMinutes + (job.estimates.estimatedRunningMinutes || 0)) * 60 * 1000;
            let estCompletionTime = '';
            if (job.jobStartTime) {
                const startTime = new Date(job.jobStartTime);
                const estCompletionDateTime = new Date(startTime.getTime() + totalEstimateMs);
                estCompletionTime = estCompletionDateTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            } else {
                // If job hasn't started, calculate from current time
                const now = new Date();
                const estCompletionDateTime = new Date(now.getTime() + totalEstimateMs);
                estCompletionTime = estCompletionDateTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            }
            
            // Check if portrait mode
            const isPortrait = window.matchMedia("(orientation: portrait)").matches;
            
            if (isPortrait) {
                // Compact horizontal layout for portrait mode
                estimatesContainer.innerHTML = `
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="font-size: 9px; color: #6b7280; text-transform: uppercase;">📊</span>
                            <div style="display: flex; gap: 10px;">
                                <div>
                                    <span style="font-size: 9px; color: #6b7280;">MR:</span>
                                    <span style="font-size: 13px; font-weight: 700; color: #10b981; margin-left: 2px;">${bestMakeReadyMins}m</span>
                                </div>
                                <div>
                                    <span style="font-size: 9px; color: #6b7280;">Run:</span>
                                    <span style="font-size: 13px; font-weight: 700; color: #3b82f6; margin-left: 2px;">${estRunningMins}m</span>
                                </div>
                                <div>
                                    <span style="font-size: 9px; color: #6b7280;">Total:</span>
                                    <span style="font-size: 13px; font-weight: 700; color: #a78bfa; margin-left: 2px;">${totalEstimateMins}m</span>
                                </div>
                            </div>
                        </div>
                        <div style="text-align: right; border-left: 1px solid rgba(255,255,255,0.1); padding-left: 10px;">
                            <div style="font-size: 9px; color: #6b7280;">🕐 Done by</div>
                            <div style="font-size: 14px; font-weight: 700; color: #fbbf24;">${estCompletionTime}</div>
                        </div>
                    </div>
                `;
            } else {
                // Full detailed layout for landscape mode
                estimatesContainer.innerHTML = `
                    <div style="text-align: center; margin-bottom: 10px;">
                        <span style="font-size: 10px; color: #10b981; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;">
                            📊 Historical Best Performance
                        </span>
                        <span style="font-size: 9px; color: #6b7280; margin-left: 6px;">(${job.estimates.jobCount} jobs)</span>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
                        <div style="text-align: center; padding: 10px 8px; background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(16, 185, 129, 0.05) 100%); border-radius: 10px; border: 1px solid rgba(16, 185, 129, 0.2);">
                            <div style="font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">MakeReady</div>
                            <div style="font-size: 22px; font-weight: 800; color: #10b981; line-height: 1;">${bestMakeReadyMins}</div>
                            <div style="font-size: 10px; color: #10b981; opacity: 0.8;">minutes</div>
                            <div style="font-size: 9px; color: #4b5563; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(16, 185, 129, 0.15);">Best: ${bestMRMachine}</div>
                        </div>
                        <div style="text-align: center; padding: 10px 8px; background: linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0.05) 100%); border-radius: 10px; border: 1px solid rgba(59, 130, 246, 0.2);">
                            <div style="font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Running</div>
                            <div style="font-size: 22px; font-weight: 800; color: #3b82f6; line-height: 1;">${estRunningMins}</div>
                            <div style="font-size: 10px; color: #3b82f6; opacity: 0.8;">minutes</div>
                            <div style="font-size: 9px; color: #4b5563; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(59, 130, 246, 0.15);">Best: ${bestRunMachine}</div>
                        </div>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: rgba(0,0,0,0.2); border-radius: 8px;">
                        <div>
                            <div style="font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Total Estimate</div>
                            <div style="font-size: 20px; font-weight: 800; color: #a78bfa;">${totalEstimateMins} <span style="font-size: 12px; font-weight: 400;">min</span></div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">🕐 Est. Completion</div>
                            <div style="font-size: 18px; font-weight: 700; color: #fbbf24;">${estCompletionTime}</div>
                        </div>
                    </div>
                `;
            }
            estimatesContainer.style.display = 'block';
        } else {
            estimatesContainer.innerHTML = `
                <div style="text-align: center; padding: 12px;">
                    <span style="font-size: 10px; color: #6b7280;">📊 No historical data available</span>
                </div>
            `;
            estimatesContainer.style.display = 'block';
        }
    }

    // Don't reset timers - they should persist across jobs until shift change
    // if (!job.isActive) {
    //     resetAllStateTimers();
    // }

    const currentStateLabel = document.getElementById('current-state-label');
    if (currentStateLabel) {
        if (job.isActive && currentMachineState) {
            const stateLabels = {
                'makeready': 'Make Ready',
                'running': 'Running',
                'lunch': 'Lunch Break',
                'cleaning': 'Cleaning',
                'waiting_qc': 'Waiting QC',
                'waiting_die': 'Waiting Die',
                'waiting_input': 'Waiting Input',
                'line_clearance': 'Line Clearance',
                'downtime_elec': 'Downtime (Electrical)',
                'downtime_mech': 'Downtime (Mechanical)',
                'downtime': 'Downtime',
                'idle': 'Idle',
                'feeder_trip': 'Feeder Trip',
                'sticky_sheets': 'Sticky Sheets',
                'sorting_waiting': 'Sorting Waiting'
            };
            currentStateLabel.textContent = stateLabels[currentMachineState] || currentMachineState;
        } else {
            currentStateLabel.textContent = 'Select a state to start tracking';
        }
    }

    console.log('Job details displayed:', job.jobNumber);
}

// API Configuration - uses current host for network access
const API_CONFIG = {
    BASE_URL: `${window.location.protocol}//${window.location.host}/api`,
    ENDPOINTS: {
        productionOrder: (docNumber) => `/production-order/${docNumber}`,
        itemAvailability: (itemCode) => `/item-availability/${itemCode}`,
        itemBatchManaged: (itemCode) => `/item-batch-managed/${encodeURIComponent(itemCode)}`,
        itemUom: (itemCode) => `/item-uom/${encodeURIComponent(itemCode)}`,
        releaseProductionOrder: '/release-production-order',
        issueMaterial: '/issue-material'
    }
};

/** SAP Inventory UoM for an item (shared by all issue popups). */
async function fetchItemInventoryUOM(itemCode) {
    const code = (itemCode || '').toString().trim();
    if (!code) return '';
    try {
        const resp = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.itemUom(code)}`);
        const json = await resp.json().catch(() => ({}));
        if (resp.ok && json.success && json.inventoryUOM) return String(json.inventoryUOM).trim();
    } catch {
        /* ignore */
    }
    return '';
}

function isProductionOrderNotReleasedError(resp, json) {
    if (!resp) return false;
    if (resp.status !== 400) return false;
    const msg = String(json?.message || json?.error || '').toLowerCase();
    return (
        json?.error === 'Production order not released' ||
        msg.includes('production order not released') ||
        msg.includes('must be released') ||
        msg.includes('referenced production order status should be') ||
        (msg.includes('production order') && msg.includes('released')) ||
        msg.includes('current status: bopos')
    );
}

async function releaseProductionOrderFromClient(absoluteEntry, documentNumber) {
    const resp = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.releaseProductionOrder}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ absoluteEntry, documentNumber })
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.success) throw new Error(json.message || json.error || 'Failed to release Production Order');
    return json;
}

async function fetchJsonWithAutoRelease(url, options, { absoluteEntry, documentNumber }) {
    const resp1 = await fetch(url, options);
    const json1 = await resp1.json().catch(() => ({}));
    if (isProductionOrderNotReleasedError(resp1, json1) && absoluteEntry) {
        await releaseProductionOrderFromClient(absoluteEntry, documentNumber);
        const resp2 = await fetch(url, options);
        const json2 = await resp2.json().catch(() => ({}));
        return { resp: resp2, json: json2, didRelease: true };
    }
    return { resp: resp1, json: json1, didRelease: false };
}

// Cache ManBtchNum lookups to avoid repeated SQL calls
const _batchManagedCache = new Map();

async function isBatchManagedItem(itemCode) {
    const code = (itemCode || '').toString().trim();
    if (!code) return false;
    if (_batchManagedCache.has(code)) return _batchManagedCache.get(code);
    try {
        const resp = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.itemBatchManaged(code)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        const json = await resp.json().catch(() => ({}));
        const ok = !!(resp.ok && json && json.success);
        const batchManaged = ok ? !!json.batchManaged : false;
        _batchManagedCache.set(code, batchManaged);
        return batchManaged;
    } catch {
        _batchManagedCache.set(code, false);
        return false;
    }
}

// Fetch fresh PMT material status from SAP
async function fetchFreshPMTMaterialStatus(documentNumber) {
    try {
        console.log(`🔄 Fetching fresh PMT material status for PO ${documentNumber}...`);
        
        const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.productionOrder(documentNumber)}?materialOnly=1`);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch PO: ${response.status}`);
        }
        
        const result = await response.json();
        const data = result.data || result;
        
        if (data.pmtMaterialsNeedIssue && data.pmtMaterialsNeedIssue.length > 0) {
            console.log(`📦 Found ${data.pmtMaterialsNeedIssue.length} PMT materials still needing issue`);
            return data.pmtMaterialsNeedIssue;
        } else {
            console.log('✅ All PMT materials already issued');
            return [];
        }
    } catch (error) {
        console.error('Error fetching fresh PMT status:', error);
        throw error;
    }
}

// Fetch fresh RMC material status from SAP (for FOI jobs)
async function fetchFreshRMCMaterialStatus(documentNumber) {
    try {
        console.log(`🔄 Fetching fresh RMC material status for PO ${documentNumber}...`);
        
        const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.productionOrder(documentNumber)}?materialOnly=1`);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch PO: ${response.status}`);
        }
        
        const result = await response.json();
        const data = result.data || result;
        
        if (data.rmcMaterialsNeedIssue && data.rmcMaterialsNeedIssue.length > 0) {
            console.log(`📦 Found ${data.rmcMaterialsNeedIssue.length} RMC materials still needing issue`);
            return data.rmcMaterialsNeedIssue;
        } else {
            console.log('✅ All RMC materials already issued');
            return [];
        }
    } catch (error) {
        console.error('Error fetching fresh RMC status:', error);
        throw error;
    }
}

// Fetch fresh LAM material status from SAP (for LAM/Lamination jobs)
// LAM materials include FIL (Film) and ADH (Adhesive)
async function fetchFreshLAMMaterialStatus(documentNumber) {
    try {
        console.log(`🔄 Fetching fresh LAM material status for PO ${documentNumber}...`);
        
        const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.productionOrder(documentNumber)}?materialOnly=1`);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch PO: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.lamMaterialsNeedIssue && data.lamMaterialsNeedIssue.length > 0) {
            console.log(`📦 Found ${data.lamMaterialsNeedIssue.length} LAM materials (Film/Adhesive) still needing issue`);
            return data.lamMaterialsNeedIssue;
        } else {
            console.log('✅ All LAM materials already issued');
            return [];
        }
    } catch (error) {
        console.error('Error fetching fresh LAM status:', error);
        throw error;
    }
}

// PMT Material Issue Dialog - Professional UI
async function showPMTMaterialIssueDialog(pmtMaterials, absoluteEntry, jobPlannedQty, documentNumber) {
    return new Promise(async (resolve) => {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pmt-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(4px);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
            animation: fadeIn 0.2s ease-out;
            overscroll-behavior: contain;
            touch-action: none;
        `;
        
        // Add keyframe animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes slideUp {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .pmt-btn:hover {
                transform: translateY(-2px) !important;
                box-shadow: 0 6px 20px rgba(0,0,0,0.25) !important;
            }
            .pmt-btn:active {
                transform: translateY(0) !important;
            }
            .pmt-input:focus {
                outline: none;
                box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3);
            }
        `;
        document.head.appendChild(style);
        
        // Create modal content
        const modal = document.createElement('div');
        modal.className = 'pmt-modal';
        modal.style.cssText = `
            background: #ffffff;
            border-radius: 20px;
            padding: 0;
            max-width: 480px;
            width: 94%;
            max-height: 90vh;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            animation: slideUp 0.3s ease-out;
            overscroll-behavior: contain;
        `;
        
        // Build material list HTML
        const material = pmtMaterials[0]; // Handle first PMT material
        const itemCodePrefix = material.itemNo.substring(0, material.itemNo.length - 4);
        const itemCodeSuffix = material.itemNo.substring(material.itemNo.length - 4);
        const supportsNumericSuffixEdit = /^\d{4}$/.test(itemCodeSuffix);
        
        modal.innerHTML = `
            <!-- Header -->
            <div style="background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); padding: 24px 28px; color: white;">
                <div style="display: flex; align-items: center; gap: 14px;">
                    <div style="background: rgba(255,255,255,0.2); border-radius: 12px; padding: 12px; display: flex; align-items: center; justify-content: center;">
                        <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                        </svg>
                    </div>
                    <div>
                        <h2 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Material Not Issued</h2>
                        <p style="margin: 4px 0 0 0; font-size: 14px; opacity: 0.9;">Packing material requires attention</p>
                    </div>
                </div>
            </div>
            
            <!-- Content -->
            <div id="pmt-content-area" style="padding: 24px 28px; overflow-y: auto; max-height: calc(90vh - 200px); overscroll-behavior: contain; -webkit-overflow-scrolling: touch;">
                <!-- Material Info Card -->
                <div style="background: #fef3c7; border: 1px solid #fbbf24; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
                    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #92400e; font-weight: 600; margin-bottom: 8px;">Material Details</div>
                    <div style="font-weight: 600; color: #78350f; font-size: 15px; line-height: 1.5; margin-bottom: 14px;">${material.itemName}</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <div style="background: white; padding: 12px 14px; border-radius: 8px; border: 1px solid #fde68a;">
                            <div style="color: #a16207; font-size: 11px; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Item Code</div>
                            <div style="color: #1e293b; font-size: 16px; font-weight: 700; font-family: 'SF Mono', 'Consolas', monospace;">${material.itemNo}</div>
                        </div>
                        <div style="background: white; padding: 12px 14px; border-radius: 8px; border: 1px solid #fde68a;">
                            <div style="color: #a16207; font-size: 11px; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Planned Qty</div>
                            <div style="color: #0369a1; font-size: 22px; font-weight: 700;">${material.plannedQuantity}</div>
                        </div>
                        <div style="background: white; padding: 12px 14px; border-radius: 8px; border: 1px solid #fde68a; grid-column: 1 / -1;">
                            <div style="color: #a16207; font-size: 11px; text-transform: uppercase; font-weight: 600; margin-bottom: 4px;">Inventory UoM</div>
                            <div id="pmt-uom-value" style="color: #1e293b; font-size: 16px; font-weight: 700; font-family: 'SF Mono', 'Consolas', monospace;">—</div>
                        </div>
                    </div>
                </div>
                
                <!-- Issue Form -->
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px;">
                    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; font-weight: 600; margin-bottom: 16px;">Issue Configuration</div>
                    
                    <!-- Item Code Input -->
                    <div style="margin-bottom: 18px;">
                        <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #334155; font-size: 14px;">Item Code</label>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="font-family: 'SF Mono', 'Consolas', monospace; background: #e2e8f0; padding: 12px 14px; border-radius: 8px; font-size: 16px; font-weight: 600; color: #475569;">${itemCodePrefix}</span>
                            <input type="text" id="pmt-suffix-input" value="${itemCodeSuffix}" maxlength="4" 
                                class="pmt-input"
                                data-original-suffix="${itemCodeSuffix}"
                                style="width: 80px; padding: 12px; font-family: 'SF Mono', 'Consolas', monospace; font-size: 18px; font-weight: 700; text-align: center; border: 2px solid #cbd5e1; border-radius: 8px; background: white; color: #1e293b; transition: all 0.2s;"
                                pattern="[0-9]{4}">
                        </div>
                        <div style="color: #64748b; font-size: 12px; margin-top: 6px;">${supportsNumericSuffixEdit ? 'Edit last 4 digits if needed' : 'Item code suffix is fixed because it is not numeric'}</div>
                    </div>
                    
                    <!-- Pcs Per Carton Input (shown when item code is changed) -->
                    <div id="pmt-pcs-per-carton-section" style="margin-bottom: 18px; display: none;">
                        <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #334155; font-size: 14px;">
                            Pcs per Carton <span style="color: #dc2626;">*</span>
                        </label>
                        <input type="number" id="pmt-pcs-per-carton" value="" min="1" placeholder="Enter pcs per carton"
                            class="pmt-input"
                            style="width: 100%; padding: 14px; font-size: 18px; font-weight: 600; border: 2px solid #f59e0b; border-radius: 8px; background: #fffbeb; color: #1e293b; text-align: center; transition: all 0.2s;">
                        <div style="color: #92400e; font-size: 12px; margin-top: 6px; background: #fef3c7; padding: 8px 12px; border-radius: 6px;">
                            ⚠️ Item code changed. Enter packaging details to calculate quantity.
                        </div>
                    </div>
                    
                    <!-- Availability Display -->
                    <div id="pmt-availability" style="margin-bottom: 18px; padding: 14px 16px; background: white; border-radius: 8px; display: none; border: 1px solid #e2e8f0;">
                        <span id="pmt-avail-text" style="font-size: 15px; font-weight: 500;">Checking availability...</span>
                    </div>
                    
                    <!-- Quantity Input -->
                    <div>
                        <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #334155; font-size: 14px;">Quantity to Issue</label>
                        <input type="number" id="pmt-quantity-input" value="${material.plannedQuantity}" min="1" 
                            class="pmt-input"
                            style="width: 100%; padding: 14px; font-size: 20px; font-weight: 700; border: 2px solid #cbd5e1; border-radius: 8px; background: white; color: #1e293b; text-align: center; transition: all 0.2s;">
                        <div id="pmt-qty-calculation" style="display: none; color: #059669; font-size: 12px; margin-top: 6px; background: #f0fdf4; padding: 8px 12px; border-radius: 6px;">
                            Calculated: <span id="pmt-calc-formula"></span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Footer Actions -->
            <div style="padding: 20px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; gap: 10px; justify-content: flex-end;">
                <button id="pmt-cancel-btn" class="pmt-btn" style="padding: 12px 20px; background: white; color: #64748b; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s;">
                    Cancel
                </button>
                <button id="pmt-issue-btn" class="pmt-btn" style="padding: 12px 24px; background: #059669; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s;">
                    Issue Material
                </button>
            </div>
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Get elements
        const suffixInput = modal.querySelector('#pmt-suffix-input');
        const quantityInput = modal.querySelector('#pmt-quantity-input');
        const availabilityDiv = modal.querySelector('#pmt-availability');
        const availText = modal.querySelector('#pmt-avail-text');
        const cancelBtn = modal.querySelector('#pmt-cancel-btn');
        const issueBtn = modal.querySelector('#pmt-issue-btn');
        const pcsPerCartonSection = modal.querySelector('#pmt-pcs-per-carton-section');
        const pcsPerCartonInput = modal.querySelector('#pmt-pcs-per-carton');
        const qtyCalculationDiv = modal.querySelector('#pmt-qty-calculation');
        const calcFormulaSpan = modal.querySelector('#pmt-calc-formula');
        const contentDiv = modal.querySelector('#pmt-content-area');
        const pmtUomEl = modal.querySelector('#pmt-uom-value');
        
        async function refreshPmtUom(itemCode) {
            const u = await fetchItemInventoryUOM(itemCode);
            if (pmtUomEl) pmtUomEl.textContent = u || '—';
        }
        
        let currentItemCode = material.itemNo;
        let availableQuantity = 0;
        const originalSuffix = itemCodeSuffix;
        const plannedQty = jobPlannedQty || material.plannedQuantity;  // Use job's header planned qty for calculation
        let isItemCodeChanged = false;

        if (!supportsNumericSuffixEdit) {
            suffixInput.readOnly = true;
            suffixInput.title = 'This item code does not end with a 4-digit editable suffix';
            suffixInput.style.background = '#f1f5f9';
            suffixInput.style.cursor = 'not-allowed';
        }
        
        // Prevent pull-to-refresh on the content area
        if (contentDiv) {
            let startY = 0;
            contentDiv.addEventListener('touchstart', (e) => {
                startY = e.touches[0].pageY;
            }, { passive: true });
            
            contentDiv.addEventListener('touchmove', (e) => {
                const currentY = e.touches[0].pageY;
                const scrollTop = contentDiv.scrollTop;
                
                // If at top of scroll and trying to pull down, prevent default
                if (scrollTop <= 0 && currentY > startY) {
                    e.preventDefault();
                }
            }, { passive: false });
        }
        
        // Prevent scroll on overlay (only allow scroll inside content area)
        overlay.addEventListener('touchmove', (e) => {
            if (!contentDiv.contains(e.target)) {
                e.preventDefault();
            }
        }, { passive: false });
        
        // Function to check availability
        // PMT materials must ALWAYS be issued from II-PST warehouse
        const PMT_WAREHOUSE = 'II-PST';
        
        async function checkAvailability(itemCode) {
            availabilityDiv.style.display = 'block';
            availabilityDiv.style.border = '1px solid #e2e8f0';
            availabilityDiv.style.background = '#f1f5f9';
            availText.innerHTML = '<span style="color: #64748b; font-size: 14px;">⏳ Checking availability...</span>';
            
            try {
                // Always use II-PST warehouse for PMT materials
                const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.itemAvailability(itemCode)}?warehouse=${PMT_WAREHOUSE}`);
                const result = await response.json();
                
                if (result.success) {
                    availableQuantity = result.availableQuantity;
                    availabilityDiv.style.border = '1px solid #86efac';
                    availabilityDiv.style.background = '#f0fdf4';
                    availText.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <span style="color: #166534; font-size: 14px; font-weight: 500;">Available Stock</span>
                            <span style="color: #15803d; font-size: 22px; font-weight: 700;">${availableQuantity}</span>
                        </div>
                        <div style="color: #6b7280; font-size: 12px; margin-top: 4px;">Warehouse: ${PMT_WAREHOUSE}</div>
                    `;
                    
                    quantityInput.max = availableQuantity;
                    
                    const requestedQty = parseInt(quantityInput.value) || 0;
                    if (requestedQty > availableQuantity) {
                        availabilityDiv.style.border = '1px solid #fca5a5';
                        availabilityDiv.style.background = '#fef2f2';
                        availText.innerHTML = `
                            <div style="display: flex; align-items: center; justify-content: space-between;">
                                <span style="color: #166534; font-size: 14px; font-weight: 500;">Available Stock</span>
                                <span style="color: #15803d; font-size: 22px; font-weight: 700;">${availableQuantity}</span>
                            </div>
                            <div style="color: #dc2626; font-size: 13px; margin-top: 8px; font-weight: 600; display: flex; align-items: center; gap: 6px;">
                                <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                                Requested quantity exceeds available stock
                            </div>
                        `;
                    }
                } else {
                    availabilityDiv.style.border = '1px solid #fca5a5';
                    availabilityDiv.style.background = '#fef2f2';
                    availText.innerHTML = `<span style="color: #dc2626; font-size: 14px; font-weight: 500;">❌ Item not found: ${itemCode}</span>`;
                    availableQuantity = 0;
                }
            } catch (error) {
                availabilityDiv.style.border = '1px solid #fca5a5';
                availabilityDiv.style.background = '#fef2f2';
                availText.innerHTML = `<span style="color: #dc2626; font-size: 14px; font-weight: 500;">❌ Error checking availability</span>`;
                availableQuantity = 0;
            }
        }
        
        // Check availability on load
        await refreshPmtUom(currentItemCode);
        await checkAvailability(currentItemCode);
        
        // Function to calculate and update quantity
        function updateCalculatedQuantity() {
            const pcsPerCarton = parseInt(pcsPerCartonInput.value) || 0;
            if (pcsPerCarton > 0 && isItemCodeChanged) {
                // Calculate: Planned Qty / Pcs per Carton, rounded UP
                const calculatedQty = Math.ceil(plannedQty / pcsPerCarton);
                quantityInput.value = calculatedQty;
                
                // Show calculation formula
                qtyCalculationDiv.style.display = 'block';
                calcFormulaSpan.textContent = `${plannedQty} ÷ ${pcsPerCarton} = ${(plannedQty / pcsPerCarton).toFixed(2)} → ${calculatedQty} (rounded up)`;
                
                // Trigger quantity validation
                quantityInput.dispatchEvent(new Event('input'));
            }
        }
        
        // Check availability when suffix changes
        suffixInput.addEventListener('input', async () => {
            if (!supportsNumericSuffixEdit) {
                suffixInput.value = originalSuffix;
                currentItemCode = material.itemNo;
                isItemCodeChanged = false;
                return;
            }
            const newSuffix = suffixInput.value.padStart(4, '0');
            if (newSuffix.length === 4 && /^\d{4}$/.test(newSuffix)) {
                currentItemCode = itemCodePrefix + newSuffix;
                await refreshPmtUom(currentItemCode);
                await checkAvailability(currentItemCode);
                
                // Check if item code was changed from original
                isItemCodeChanged = (newSuffix !== originalSuffix);
                
                if (isItemCodeChanged) {
                    // Show pcs per carton input (don't auto-focus to let operator finish typing)
                    pcsPerCartonSection.style.display = 'block';
                    // Reset quantity until pcs per carton is entered
                    quantityInput.value = '';
                    qtyCalculationDiv.style.display = 'none';
                } else {
                    // Hide pcs per carton input and reset to planned qty
                    pcsPerCartonSection.style.display = 'none';
                    quantityInput.value = plannedQty;
                    qtyCalculationDiv.style.display = 'none';
                }
            }
        });
        
        // Calculate quantity when pcs per carton changes
        pcsPerCartonInput.addEventListener('input', updateCalculatedQuantity);
        
        // Validate quantity on change
        quantityInput.addEventListener('input', () => {
            const requestedQty = parseInt(quantityInput.value) || 0;
            if (requestedQty > availableQuantity && availableQuantity > 0) {
                availabilityDiv.style.border = '1px solid #fca5a5';
                availabilityDiv.style.background = '#fef2f2';
                availText.innerHTML = `
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <span style="color: #166534; font-size: 14px; font-weight: 500;">Available Stock</span>
                        <span style="color: #15803d; font-size: 22px; font-weight: 700;">${availableQuantity}</span>
                    </div>
                    <div style="color: #dc2626; font-size: 13px; margin-top: 8px; font-weight: 600; display: flex; align-items: center; gap: 6px;">
                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
                        Requested quantity exceeds available stock
                    </div>
                `;
            } else if (availableQuantity > 0) {
                availabilityDiv.style.border = '1px solid #86efac';
                availabilityDiv.style.background = '#f0fdf4';
                availText.innerHTML = `
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <span style="color: #166534; font-size: 14px; font-weight: 500;">Available Stock</span>
                        <span style="color: #15803d; font-size: 22px; font-weight: 700;">${availableQuantity}</span>
                    </div>
                    <div style="color: #6b7280; font-size: 12px; margin-top: 4px;">Warehouse: ${PMT_WAREHOUSE}</div>
                `;
            }
        });
        
        // Cancel button
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve({ success: false, message: 'Material issue cancelled by user' });
        });
        
        // Issue button
        issueBtn.addEventListener('click', async () => {
            // Validate pcs per carton if item code was changed
            if (isItemCodeChanged) {
                const pcsPerCarton = parseInt(pcsPerCartonInput.value) || 0;
                if (pcsPerCarton <= 0) {
                    alert('Please enter Pcs per Carton to calculate quantity');
                    pcsPerCartonInput.focus();
                    return;
                }
            }
            
            const quantityToIssue = parseInt(quantityInput.value) || 0;
            
            if (quantityToIssue <= 0) {
                alert('Please enter a valid quantity');
                return;
            }
            
            if (quantityToIssue > availableQuantity) {
                alert(`Cannot issue ${quantityToIssue} units. Only ${availableQuantity} available.`);
                return;
            }
            
            // Disable button and show loading
            issueBtn.disabled = true;
            issueBtn.textContent = 'Issuing...';
            issueBtn.style.background = '#9ca3af';
            
            try {
                const { resp: response, json: result } = await fetchJsonWithAutoRelease(
                    `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.issueMaterial}`,
                    {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        absoluteEntry: absoluteEntry,
                        documentNumber: documentNumber,  // PO number for tracking in comments
                        itemCode: currentItemCode,
                        quantity: quantityToIssue,
                        warehouse: PMT_WAREHOUSE,
                        lineNumber: material.lineNumber,
                        remarks: 'PMT material issued via Data Entry WebApp',
                        itemCodeChanged: isItemCodeChanged,  // Flag to indicate item code was changed
                        originalItemCode: isItemCodeChanged ? material.itemNo : undefined  // Original item code for PO line update
                    })
                    },
                    { absoluteEntry, documentNumber }
                );
                
                if (result.success) {
                    document.body.removeChild(overlay);
                    alert(`✅ Material issued successfully!\n\nItem: ${currentItemCode}\nQuantity: ${quantityToIssue}\nBatch: ${result.batchUsed || 'Auto-selected'}`);
                    resolve({ success: true, issued: true, quantity: quantityToIssue, itemCode: currentItemCode });
                } else {
                    throw new Error(result.message || result.error || 'Failed to issue material');
                }
            } catch (error) {
                console.error('Issue material error:', error);
                alert(`❌ Failed to issue material:\n\n${error.message}`);
                
                // Re-enable button
                issueBtn.disabled = false;
                issueBtn.textContent = 'Issue Material';
                issueBtn.style.background = '#059669';
            }
        });
    });
}

// Non-batch material issue dialog — REMOVED (non-batch items are skipped)
async function __REMOVED_showNonBatchMaterialIssueDialog(material, absoluteEntry, jobPlannedQty, documentNumber) {
    return new Promise(async (resolve) => {
        try {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                inset: 0;
                background: rgba(15, 23, 42, 0.85);
                backdrop-filter: blur(4px);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                animation: fadeIn 0.2s ease-out;
                overscroll-behavior: contain;
                touch-action: none;
            `;

            const modal = document.createElement('div');
            modal.style.cssText = `
                background: #ffffff;
                border-radius: 16px;
                width: 94%;
                max-width: 520px;
                max-height: 90vh;
                overflow: hidden;
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                animation: slideUp 0.3s ease-out;
                display: flex;
                flex-direction: column;
            `;

            function isSpotUVMachine() {
                const n = (machineInfo?.name || '').toString().toLowerCase();
                return n.startsWith('spotuv');
            }

            function isRigidMachineContext() {
                const p = (machineInfo?.process || '').toString().toLowerCase();
                const n = (machineInfo?.name || '').toString().toLowerCase();
                return p.includes('rigid') || n.includes('emmeci') || n.includes('fuchu') || n.includes('assembly');
            }

            function isHolographicMachineContext() {
                const p = (machineInfo?.process || '').toString().toLowerCase();
                return p.includes('embossing') ||
                    p.includes('rewinding') ||
                    p.includes('slitting') ||
                    p.includes('metallisation') ||
                    p.includes('metallization');
            }

            function getHolographicWarehouseList() {
                const p = (machineInfo?.process || '').toString().toLowerCase();
                if (p.includes('embossing')) return ['II-EMB'];
                if (p.includes('rewinding')) return ['II-RWD'];
                if (p.includes('slitting')) return ['II-SLT'];
                if (p.includes('metallisation') || p.includes('metallization')) return ['II-MLT'];
                return ['II-EMB', 'II-RWD', 'II-SLT', 'II-MLT'];
            }

            function getSmartWarehouseSearchList() {
                // NOTE: Order matters — we’ll search in priority order for this machine type.
                if (isSpotUVMachine()) return ['II-SPUV', 'II-PST'];
                if (isDieCuttingMachine() || (isFoilingMachine && isFoilingMachine() && isDieCuttingSubProcess && isDieCuttingSubProcess())) return ['II-DIE', 'II-EMB'];
                if (isLaminationMachine()) return ['II-LAM', 'II-MPET'];
                if (isFoldingPastingMachine()) return ['II-PST'];
                if (isHolographicMachineContext()) return getHolographicWarehouseList();
                if (isRigidMachineContext()) return ['II-MKG', 'II-ASS'];
                // Fallbacks: try material's suggested warehouse first, then common stores
                const hinted = (material && material.warehouse) ? String(material.warehouse) : '';
                const base = [hinted, 'II-PST', 'II-LAM', 'II-FOI', 'II-DIE', 'II-EMB', 'II-MPET', 'II-MKG', 'II-ASS', 'II-SPUV']
                    .filter(Boolean);
                // unique
                return Array.from(new Set(base));
            }

            const warehouseCandidates = getSmartWarehouseSearchList();
            // Start with the hinted warehouse if present and part of candidates; else first candidate
            let chosenWarehouse = (material && material.warehouse) ? String(material.warehouse) : '';
            if (!chosenWarehouse || !warehouseCandidates.includes(chosenWarehouse)) {
                chosenWarehouse = warehouseCandidates[0] || '';
            }
            const planned = Number(material?.plannedQuantity ?? jobPlannedQty ?? 0) || 0;

            modal.innerHTML = `
                <div style="background: linear-gradient(135deg, #0f766e 0%, #0b4f48 100%); padding: 16px 20px; color: white;">
                    <div style="font-size: 18px; font-weight: 800;">Material Issue</div>
                    <div style="font-size: 12px; opacity: 0.9; margin-top: 4px;">Non-batch item requires issue before Running</div>
                </div>
                <div style="padding: 18px 20px; overflow: auto;">
                    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 14px;margin-bottom:14px;">
                        <div style="font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color:#64748b; font-weight: 700;">Material</div>
                        <div style="margin-top:6px; font-size: 15px; font-weight: 800; color:#0f172a; font-family: 'SF Mono','Consolas',monospace;">${material?.itemNo || ''}</div>
                        <div style="margin-top:4px; font-size: 13px; color:#334155; font-weight: 600;">${material?.itemName || ''}</div>
                        <div id="nb-warehouse-line" style="margin-top:6px; font-size: 12px; color:#475569;">
                            Warehouse: <strong>${chosenWarehouse || '-'}</strong>
                        </div>
                    </div>

                    <div id="nb-avail" style="display:none; margin-bottom: 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid #e2e8f0; background: #f1f5f9; color: #334155; font-size: 13px;">
                        Checking availability…
                    </div>

                    <label style="display:block; font-weight: 700; color:#334155; font-size: 13px; margin-bottom: 8px;">Quantity to Issue</label>
                    <input id="nb-qty" type="number" min="1" value="${planned > 0 ? planned : ''}"
                        style="width:100%; padding: 12px 12px; font-size: 18px; font-weight: 800; border: 2px solid #cbd5e1; border-radius: 10px; background: white; text-align: center;">
                    <div style="margin-top:8px; font-size: 12px; color:#64748b;">Enter the quantity to issue for this line.</div>
                </div>
                <div style="padding: 14px 20px; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; gap: 10px; justify-content: flex-end;">
                    <button id="nb-cancel" style="padding:10px 16px; background:white; border:1px solid #e2e8f0; border-radius:10px; cursor:pointer; font-weight:700; color:#64748b;">Cancel</button>
                    <button id="nb-issue" style="padding:10px 18px; background:#059669; border:none; border-radius:10px; cursor:pointer; font-weight:800; color:white;">Issue</button>
                </div>
            `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            const availEl = modal.querySelector('#nb-avail');
            const qtyEl = modal.querySelector('#nb-qty');
            const cancelBtn = modal.querySelector('#nb-cancel');
            const issueBtn = modal.querySelector('#nb-issue');
            const whLineEl = modal.querySelector('#nb-warehouse-line');

            let availableQty = null;
            const itemCode = (material?.itemNo || '').toString().trim();

            async function fetchAvailabilityForWarehouse(warehouse) {
                try {
                    if (!itemCode) return;
                    if (!API_CONFIG?.ENDPOINTS?.itemAvailability) return;
                    const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.itemAvailability(itemCode)}${warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : ''}`;
                    const resp = await fetch(url);
                    const json = await resp.json().catch(() => ({}));
                    if (json?.success) {
                        return Number(json.availableQuantity ?? 0) || 0;
                    } else {
                        return null;
                    }
                } catch (e) {
                    return null;
                }
            }

            async function checkAvailabilitySmart() {
                availEl.style.display = 'block';
                availEl.style.background = '#f1f5f9';
                availEl.style.borderColor = '#e2e8f0';
                availEl.textContent = `Checking availability in ${warehouseCandidates.join(', ')}…`;

                let bestWh = chosenWarehouse || '';
                let bestQty = null;

                for (const wh of warehouseCandidates) {
                    const qty = await fetchAvailabilityForWarehouse(wh);
                    if (qty === null) continue;
                    if (bestQty === null || qty > bestQty) {
                        bestQty = qty;
                        bestWh = wh;
                    }
                    // If we found some stock, we still keep scanning in case another WH has more.
                }

                if (bestQty === null) {
                    availableQty = null;
                    availEl.style.background = '#fef2f2';
                    availEl.style.borderColor = '#fca5a5';
                    availEl.textContent = 'Availability check failed (continuing anyway).';
                    return;
                }

                availableQty = bestQty;
                chosenWarehouse = bestWh;
                if (whLineEl) whLineEl.innerHTML = `Warehouse: <strong>${chosenWarehouse || '-'}</strong>`;

                if (availableQty > 0) {
                    availEl.style.background = '#f0fdf4';
                    availEl.style.borderColor = '#86efac';
                    availEl.innerHTML = `Available: <strong style="color:#15803d;">${availableQty}</strong> <span style="color:#6b7280;">(WH: ${chosenWarehouse})</span>`;
                } else {
                    availEl.style.background = '#fff7ed';
                    availEl.style.borderColor = '#fdba74';
                    availEl.innerHTML = `Available: <strong style="color:#c2410c;">0</strong> <span style="color:#6b7280;">(WH: ${chosenWarehouse})</span>`;
                }
            }

            // Best-effort availability (do not block if endpoint fails)
            await checkAvailabilitySmart();

            cancelBtn.addEventListener('click', () => {
                try { document.body.removeChild(overlay); } catch {}
                resolve({ success: false, message: 'Material issue cancelled by user' });
            });

            issueBtn.addEventListener('click', async () => {
                const qty = Number(qtyEl.value);
                if (!Number.isFinite(qty) || qty <= 0) {
                    alert('Please enter a valid quantity to issue');
                    qtyEl.focus();
                    return;
                }
                if (availableQty !== null && qty > availableQty) {
                    alert(`Cannot issue ${qty}. Only ${availableQty} available${chosenWarehouse ? ` in ${chosenWarehouse}` : ''}.`);
                    return;
                }

                issueBtn.disabled = true;
                issueBtn.textContent = 'Issuing...';
                try {
                    const resp = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.issueMaterial}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            absoluteEntry,
                            documentNumber,
                            itemCode,
                            quantity: qty,
                            warehouse: chosenWarehouse || undefined,
                            lineNumber: material?.lineNumber,
                            remarks: 'Material issued via Data Entry WebApp (non-batch)',
                        })
                    });
                    const json = await resp.json().catch(() => ({}));
                    if (!resp.ok || !json.success) {
                        throw new Error(json.message || json.error || 'Failed to issue material');
                    }
                    try { document.body.removeChild(overlay); } catch {}
                    resolve({ success: true, issued: true, quantity: qty, itemCode });
                } catch (e) {
                    console.error('Non-batch issue error:', e);
                    alert(`❌ Failed to issue material:\n\n${e.message || e}`);
                    issueBtn.disabled = false;
                    issueBtn.textContent = 'Issue';
                }
            });
        } catch (e) {
            console.error('Error in showNonBatchMaterialIssueDialog:', e);
            resolve({ success: false, message: e?.message || 'Failed to show issue dialog' });
        }
    });
}

// ==================== RMC Material Issue Dialog (Batch-Based) ====================

/**
 * Process multiple RMC materials sequentially
 * Shows popup for each RMC material one by one with Next/Continue navigation
 */
async function processRMCMaterialsSequentially(rmcMaterials, absoluteEntry, jobPlannedQty, documentNumber) {
    for (let i = 0; i < rmcMaterials.length; i++) {
        const material = rmcMaterials[i];
        const isLast = (i === rmcMaterials.length - 1);
        
        const result = await showRMCBatchIssueDialog(
            material,
            absoluteEntry,
            jobPlannedQty,
            documentNumber,
            i + 1,
            rmcMaterials.length,
            isLast
        );
        
        if (!result.success) {
            return { success: false, message: 'RMC material issue cancelled' };
        }
    }
    return { success: true, message: 'All RMC materials issued successfully' };
}

/**
 * Show dialog for RMC material batch selection and issue (FOI jobs only)
 * Displays all available batches with details for user selection
 * Supports filtering by batch number or width, and auto-allocation
 */
async function showRMCBatchIssueDialog(material, absoluteEntry, jobPlannedQty, documentNumber, currentIndex, totalCount, isLast) {
    return new Promise(async (resolve) => {
        try {
        const overlay = document.createElement('div');
        overlay.className = 'rmc-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(4px);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
            animation: fadeIn 0.2s ease-out;
            overscroll-behavior: contain;
            touch-action: none;
        `;
        
        const itemCodePrefix = material.itemNo.substring(0, material.itemNo.length - 4);
        const itemCodeSuffix = material.itemNo.substring(material.itemNo.length - 4);
        const originalSuffix = itemCodeSuffix;
        const supportsNumericSuffixEdit = /^\d{4}$/.test(itemCodeSuffix);
        
        const modal = document.createElement('div');
        modal.className = 'rmc-modal';
        modal.style.cssText = `
            background: white;
            border-radius: 16px;
            width: 95%;
            max-width: 700px;
            max-height: 90vh;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
            animation: slideUp 0.3s ease-out;
            display: flex;
            flex-direction: column;
        `;
        
        const progressText = totalCount > 1 ? ` (${currentIndex} of ${totalCount})` : '';
        
        modal.innerHTML = `
            <div style="background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%); padding: 16px 20px; color: white; flex-shrink: 0;">
                <h2 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
                    <svg width="22" height="22" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l4.59-4.58L18 11l-6 6z"/></svg>
                    Material Issue${progressText}
                </h2>
                <p style="margin: 0; font-size: 12px; opacity: 0.9;">Select batches and quantities to issue</p>
            </div>
            
            <div style="padding: 12px 16px; background: #faf5ff; border-bottom: 1px solid #e9d5ff; flex-shrink: 0;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <span style="font-size: 13px; color: #7c3aed; font-weight: 600;">Material:</span>
                    <span style="font-size: 15px; color: #1e293b; font-weight: 700; font-family: monospace;">${itemCodePrefix}</span>
                    <input type="text" id="rmc-suffix-input" value="${itemCodeSuffix}" maxlength="4" 
                        style="width: 60px; padding: 6px 8px; border: 2px solid #c4b5fd; border-radius: 6px; font-size: 15px; font-weight: 700; text-align: center; font-family: monospace; background: white;">
                    <span style="font-size: 12px; color: #64748b; margin-left: 8px;">${material.itemName || ''}</span>
                    <span id="rmc-uom-badge" style="font-size: 11px; color: #fff; background: #7c3aed; padding: 2px 8px; border-radius: 10px; margin-left: 6px; font-weight: 700; display: none;"></span>
                </div>
            </div>
            
            <div style="padding: 12px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; flex-shrink: 0;">
                <input type="text" id="rmc-search-input" placeholder="Search by Batch # or Width..." 
                    style="flex: 1; min-width: 180px; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px;">
                <button id="rmc-clear-btn" style="padding: 8px 14px; background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">
                    Clear
                </button>
            </div>
            
            <div id="rmc-content-area" style="flex: 1; overflow-y: auto; overflow-x: auto; -webkit-overflow-scrolling: touch; padding: 0;">
                <div id="rmc-loading" style="padding: 40px; text-align: center; color: #64748b;">
                    <div style="font-size: 14px;">Loading batches...</div>
                </div>
                <table id="rmc-batch-table" style="width: 100%; min-width: 720px; border-collapse: collapse; display: none;">
                    <thead style="background: #f1f5f9; position: sticky; top: 0;">
                        <tr>
                            <th style="padding: 10px 8px; text-align: center; font-size: 11px; font-weight: 600; color: #64748b; width: 40px;"></th>
                            <th style="padding: 10px 8px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b;">Batch #</th>
                            <th style="padding: 10px 8px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b;">Grade</th>
                            <th style="padding: 10px 8px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b;">Length (m)</th>
                            <th style="padding: 10px 8px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b;">Width (mm)</th>
                            <th style="padding: 10px 8px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b;">Available</th>
                            <th style="padding: 10px 8px; text-align: center; font-size: 11px; font-weight: 600; color: #64748b; width: 90px;">Issue Qty</th>
                        </tr>
                    </thead>
                    <tbody id="rmc-batch-tbody"></tbody>
                </table>
                <div id="rmc-no-batches" style="padding: 40px; text-align: center; color: #dc2626; display: none;">
                    <div style="font-size: 14px; font-weight: 600;">No batches found</div>
                    <div style="font-size: 12px; margin-top: 4px;">No stock available for this item</div>
                </div>
            </div>
            
            <div style="padding: 12px 16px; background: #f0fdf4; border-top: 1px solid #bbf7d0; flex-shrink: 0;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <span style="font-size: 12px; color: #64748b;">Total to Issue:</span>
                        <span id="rmc-total-issue" style="font-size: 18px; font-weight: 700; color: #16a34a; margin-left: 8px;">0</span>
                        <span id="rmc-uom-issue" style="font-size: 12px; color: #64748b; margin-left: 4px;"></span>
                    </div>
                    <div>
                        <span style="font-size: 12px; color: #64748b;">Total Available:</span>
                        <span id="rmc-total-available" style="font-size: 16px; font-weight: 600; color: #7c3aed; margin-left: 8px;">0</span>
                        <span id="rmc-uom-avail" style="font-size: 12px; color: #64748b; margin-left: 4px;"></span>
                    </div>
                </div>
            </div>
            
            <div style="padding: 14px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; gap: 10px; justify-content: flex-end; flex-shrink: 0;">
                <button id="rmc-cancel-btn" style="padding: 10px 18px; background: white; color: #64748b; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;">
                    Cancel
                </button>
                <button id="rmc-issue-btn" style="padding: 10px 20px; background: #7c3aed; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;">
                    Issue Material
                </button>
                <button id="rmc-next-btn" style="padding: 10px 20px; background: #10b981; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; display: none;">
                    ${isLast ? 'Finish' : 'Next'} →
                </button>
            </div>
        `;
        
        // Append modal to overlay and overlay to body
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Get elements
        const suffixInput = modal.querySelector('#rmc-suffix-input');
        const searchInput = modal.querySelector('#rmc-search-input');
        const clearBtn = modal.querySelector('#rmc-clear-btn');
        const loadingDiv = modal.querySelector('#rmc-loading');
        const batchTable = modal.querySelector('#rmc-batch-table');
        const batchTbody = modal.querySelector('#rmc-batch-tbody');
        const noBatchesDiv = modal.querySelector('#rmc-no-batches');
        const totalIssueSpan = modal.querySelector('#rmc-total-issue');
        const totalAvailableSpan = modal.querySelector('#rmc-total-available');
        const cancelBtn = modal.querySelector('#rmc-cancel-btn');
        const issueBtn = modal.querySelector('#rmc-issue-btn');
        const nextBtn = modal.querySelector('#rmc-next-btn');
        const contentDiv = modal.querySelector('#rmc-content-area');
        
        let currentItemCode = material.itemNo;
        let allBatches = [];
        let filteredBatches = [];
        let isItemCodeChanged = false;
        let materialIssued = false;
        let currentUOM = '';

        if (!supportsNumericSuffixEdit) {
            suffixInput.readOnly = true;
            suffixInput.title = 'This item code does not end with a 4-digit editable suffix';
            suffixInput.style.background = '#f1f5f9';
            suffixInput.style.cursor = 'not-allowed';
        }

        const uomBadge = modal.querySelector('#rmc-uom-badge');
        const uomIssueSpan = modal.querySelector('#rmc-uom-issue');
        const uomAvailSpan = modal.querySelector('#rmc-uom-avail');

        async function fetchAndSetUOM(itemCode) {
            try {
                currentUOM = await fetchItemInventoryUOM(itemCode);
            } catch (e) {
                console.warn('UoM fetch failed:', e);
                currentUOM = '';
            }
            if (uomBadge) {
                if (currentUOM) {
                    uomBadge.textContent = currentUOM;
                    uomBadge.style.display = 'inline';
                } else {
                    uomBadge.style.display = 'none';
                }
            }
            if (uomIssueSpan) uomIssueSpan.textContent = currentUOM || '';
            if (uomAvailSpan) uomAvailSpan.textContent = currentUOM || '';
        }

        fetchAndSetUOM(currentItemCode);
        
        // Prevent pull-to-refresh
        if (contentDiv) {
            let startY = 0;
            contentDiv.addEventListener('touchstart', (e) => { startY = e.touches[0].pageY; }, { passive: true });
            contentDiv.addEventListener('touchmove', (e) => {
                if (contentDiv.scrollTop <= 0 && e.touches[0].pageY > startY) e.preventDefault();
            }, { passive: false });
        }
        overlay.addEventListener('touchmove', (e) => {
            if (contentDiv && !contentDiv.contains(e.target)) e.preventDefault();
        }, { passive: false });
        
        // Function to update total issue quantity
        function updateTotals() {
            let total = 0;
            const qtyInputs = batchTbody.querySelectorAll('.batch-qty-input');
            qtyInputs.forEach(input => {
                const qty = parseFloat(input.value) || 0;
                total += qty;
            });
            totalIssueSpan.textContent = total.toFixed(0);
            totalIssueSpan.style.color = total > 0 ? '#16a34a' : '#64748b';
        }
        
        // Function to render batch rows
        function renderBatches(batches) {
            const dim = (b, key) => {
                const raw = key === 'len'
                    ? (b.length ?? b.Length ?? b.u_length ?? b.U_Length ?? b.U_LENGTH)
                    : (b.width ?? b.Width ?? b.u_width ?? b.U_Width ?? b.U_WIDTH);
                const n = Number(raw);
                return Number.isFinite(n) ? n : 0;
            };
            const gradeStr = (b) => {
                const g = b.grade ?? b.Grade ?? b.U_GRADE ?? b.u_grade;
                return (g != null && String(g).trim() !== '') ? String(g) : 'N/A';
            };
            batchTbody.innerHTML = '';
            batches.forEach((batch, idx) => {
                const row = document.createElement('tr');
                row.style.cssText = 'border-bottom: 1px solid #f1f5f9;';
                row.innerHTML = `
                    <td style="padding: 8px; text-align: center;">
                        <input type="checkbox" class="batch-checkbox" data-idx="${idx}" 
                            style="width: 18px; height: 18px; cursor: pointer;">
                    </td>
                    <td style="padding: 8px; font-size: 14px; font-weight: 700; font-family: monospace; color: #1e293b;">${batch.batchNumber}${batch._warehouse ? `<div style="font-size:10px;color:#7c3aed;font-weight:600;margin-top:2px;">${batch._warehouse}</div>` : ''}</td>
                    <td style="padding: 8px; font-size: 13px; color: #374151; font-weight: 500;">${gradeStr(batch)}</td>
                    <td style="padding: 8px; font-size: 13px; text-align: right; color: #374151;">${dim(batch, 'len')}</td>
                    <td style="padding: 8px; font-size: 13px; text-align: right; color: #374151;">${dim(batch, 'wid')}</td>
                    <td style="padding: 8px; font-size: 14px; text-align: right; font-weight: 700; color: #7c3aed;">${batch.available || 0}</td>
                    <td style="padding: 8px; text-align: center;">
                        <input type="number" class="batch-qty-input" data-idx="${idx}" data-batch="${batch.batchNumber}" 
                            data-available="${batch.available}" value="" min="0" max="${batch.available}" step="1"
                            style="width: 70px; padding: 6px; border: 1px solid #e2e8f0; border-radius: 4px; font-size: 13px; text-align: center; font-weight: 600;"
                            disabled>
                    </td>
                `;
                batchTbody.appendChild(row);
            });
            
            // Add checkbox event listeners
            batchTbody.querySelectorAll('.batch-checkbox').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const idx = e.target.dataset.idx;
                    const qtyInput = batchTbody.querySelector(`.batch-qty-input[data-idx="${idx}"]`);
                    if (e.target.checked) {
                        qtyInput.disabled = false;
                        qtyInput.focus();
                    } else {
                        qtyInput.disabled = true;
                        qtyInput.value = '';
                        updateTotals();
                    }
                });
            });
            
            // Add qty input event listeners
            batchTbody.querySelectorAll('.batch-qty-input').forEach(input => {
                input.addEventListener('input', () => {
                    const max = parseFloat(input.dataset.available) || 0;
                    const val = parseFloat(input.value) || 0;
                    if (val > max) input.value = max;
                    if (val < 0) input.value = 0;
                    updateTotals();
                });
            });
        }
        
        // Smart warehouse list per machine category
        function _isSpotUV() { return (machineInfo?.name || '').toLowerCase().startsWith('spotuv'); }
        function _isRigid() {
            const p = (machineInfo?.process || '').toLowerCase();
            const n = (machineInfo?.name || '').toLowerCase();
            return p.includes('rigid') || n.includes('emmeci') || n.includes('fuchu') || n.includes('assembly');
        }
        function _isHolographic() {
            const p = (machineInfo?.process || '').toLowerCase();
            return p.includes('embossing') ||
                p.includes('rewinding') ||
                p.includes('slitting') ||
                p.includes('metallisation') ||
                p.includes('metallization');
        }
        function _getHolographicWarehouseList() {
            const p = (machineInfo?.process || '').toLowerCase();
            if (p.includes('embossing')) return ['II-EMB'];
            if (p.includes('rewinding')) return ['II-RWD'];
            if (p.includes('slitting')) return ['II-SLT'];
            if (p.includes('metallisation') || p.includes('metallization')) return ['II-MLT'];
            return ['II-EMB', 'II-RWD', 'II-SLT', 'II-MLT'];
        }
        function getWarehouseSearchList() {
            // Prefer warehouse from the Production Order line (one API call — fastest, correct for SAP).
            const lineWh = (material && material.warehouse) ? String(material.warehouse).trim() : '';
            if (lineWh) return [lineWh];

            if (_isSpotUV()) return ['II-SPUV', 'II-PST'];
            if (typeof isDieCuttingMachine === 'function' && isDieCuttingMachine()) return ['II-DIE', 'II-EMB'];
            if (typeof isFoilingMachine === 'function' && isFoilingMachine() &&
                typeof isDieCuttingSubProcess === 'function' && isDieCuttingSubProcess()) return ['II-DIE', 'II-EMB'];
            if (typeof isLaminationMachine === 'function' && isLaminationMachine()) return ['II-LAM', 'II-MPET'];
            if (typeof isFoldingPastingMachine === 'function' && isFoldingPastingMachine()) return ['II-PST'];
            if (_isHolographic()) return _getHolographicWarehouseList();
            if (_isRigid()) return ['II-MKG', 'II-ASS'];
            return ['II-FOI'];
        }

        let activeWarehouse = (material && material.warehouse) ? String(material.warehouse).trim() : '';

        // Function to fetch batches — searches smart warehouse list, merges results
        async function fetchBatches(itemCode) {
            loadingDiv.style.display = 'block';
            batchTable.style.display = 'none';
            noBatchesDiv.style.display = 'none';
            
            try {
                const whList = getWarehouseSearchList();
                let combinedBatches = [];
                let combinedTotal = 0;

                const fetchOneWh = async (wh) => {
                    try {
                        const response = await fetch(`${API_CONFIG.BASE_URL}/rmc-batches/${encodeURIComponent(itemCode)}?warehouse=${encodeURIComponent(wh)}`);
                        const result = await response.json();
                        if (result.success && result.batches && result.batches.length > 0) {
                            const tagged = result.batches.map(b => ({ ...b, _warehouse: wh }));
                            return {
                                tagged,
                                total: result.totalAvailable || 0,
                                wh
                            };
                        }
                    } catch (e) {
                        console.warn(`Batch fetch for WH ${wh} failed:`, e);
                    }
                    return { tagged: [], total: 0, wh };
                };

                const results = await Promise.all(whList.map(fetchOneWh));
                for (const r of results) {
                    if (r.tagged.length > 0) {
                        combinedBatches = combinedBatches.concat(r.tagged);
                        combinedTotal += r.total;
                        if (!activeWarehouse) activeWarehouse = r.wh;
                    }
                }

                if (combinedBatches.length > 0) {
                    allBatches = combinedBatches;
                    filteredBatches = [...allBatches];
                    totalAvailableSpan.textContent = combinedTotal;
                    
                    loadingDiv.style.display = 'none';
                    batchTable.style.display = 'table';
                    renderBatches(filteredBatches);
                } else {
                    loadingDiv.style.display = 'none';
                    noBatchesDiv.style.display = 'block';
                    noBatchesDiv.querySelector('div:first-child').textContent = 'No batches found';
                    noBatchesDiv.querySelector('div:last-child').textContent = `Searched warehouses: ${whList.join(', ')}`;
                    allBatches = [];
                    filteredBatches = [];
                    totalAvailableSpan.textContent = '0';
                }
            } catch (error) {
                console.error('Error fetching batches:', error);
                loadingDiv.style.display = 'none';
                noBatchesDiv.style.display = 'block';
                noBatchesDiv.querySelector('div:first-child').textContent = 'Error loading batches';
                noBatchesDiv.querySelector('div:last-child').textContent = error.message;
            }
        }
        
        // Fetch batches on load
        await fetchBatches(currentItemCode);
        
        // Search/filter functionality
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            if (!query) {
                filteredBatches = [...allBatches];
            } else {
                filteredBatches = allBatches.filter(b => 
                    (b.batchNumber && b.batchNumber.toLowerCase().includes(query)) ||
                    (b.width && b.width.toString().includes(query))
                );
            }
            renderBatches(filteredBatches);
        });
        
        // Item code suffix change
        suffixInput.addEventListener('input', async () => {
            if (!supportsNumericSuffixEdit) {
                currentItemCode = material.itemNo;
                isItemCodeChanged = false;
                return;
            }
            let rawValue = suffixInput.value.replace(/\D/g, '');
            if (rawValue.length > 4) rawValue = rawValue.substring(0, 4);
            suffixInput.value = rawValue;
            const newSuffix = rawValue.padStart(4, '0');
            currentItemCode = itemCodePrefix + newSuffix;
            isItemCodeChanged = (newSuffix !== originalSuffix);
            if (rawValue.length >= 2) {
                await fetchBatches(currentItemCode);
                fetchAndSetUOM(currentItemCode);
            }
        });
        
        suffixInput.addEventListener('blur', () => {
            if (!supportsNumericSuffixEdit) {
                suffixInput.value = originalSuffix;
                currentItemCode = material.itemNo;
                isItemCodeChanged = false;
                return;
            }
            let rawValue = suffixInput.value.replace(/\D/g, '');
            if (rawValue.length > 4) rawValue = rawValue.substring(0, 4);
            const paddedValue = rawValue.padStart(4, '0');
            suffixInput.value = paddedValue;
            currentItemCode = itemCodePrefix + paddedValue;
            isItemCodeChanged = (paddedValue !== originalSuffix);
        });
        
        // Clear button
        clearBtn.addEventListener('click', () => {
            const checkboxes = batchTbody.querySelectorAll('.batch-checkbox');
            const qtyInputs = batchTbody.querySelectorAll('.batch-qty-input');
            
            checkboxes.forEach((cb, i) => {
                cb.checked = false;
                qtyInputs[i].disabled = true;
                qtyInputs[i].value = '';
            });
            updateTotals();
        });
        
        // Cancel button
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve({ success: false, message: 'Material issue cancelled by user' });
        });
        
        // Issue button
        issueBtn.addEventListener('click', async () => {
            const batchAllocations = [];
            const qtyInputs = batchTbody.querySelectorAll('.batch-qty-input');
            
            qtyInputs.forEach(input => {
                if (!input.disabled) {
                    const qty = parseFloat(input.value) || 0;
                    if (qty > 0) {
                        batchAllocations.push({
                            batchNumber: input.dataset.batch,
                            quantity: qty
                        });
                    }
                }
            });
            
            if (batchAllocations.length === 0) {
                alert('Please select at least one batch and enter quantity to issue');
                return;
            }
            
            const totalQty = batchAllocations.reduce((sum, b) => sum + b.quantity, 0);
            
            issueBtn.disabled = true;
            issueBtn.textContent = 'Issuing...';
            
            const currentSuffix = supportsNumericSuffixEdit ? suffixInput.value.replace(/\D/g, '').padStart(4, '0') : originalSuffix;
            const finalItemCode = supportsNumericSuffixEdit ? itemCodePrefix + currentSuffix : material.itemNo;
            const itemCodeWasChanged = supportsNumericSuffixEdit && (currentSuffix !== originalSuffix);

            // Pick the best warehouse: use the tagged warehouse from the first selected batch,
            // or fall back to the material's warehouse, or the first smart-search WH.
            const firstSelectedBatch = allBatches.find(b =>
                batchAllocations.some(a => a.batchNumber === b.batchNumber));
            const issueWarehouse = firstSelectedBatch?._warehouse || activeWarehouse || material?.warehouse || getWarehouseSearchList()[0] || '';
            
            try {
                const { resp: response, json: result } = await fetchJsonWithAutoRelease(
                    `${API_CONFIG.BASE_URL}/issue-rmc-batches`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            absoluteEntry: absoluteEntry,
                            documentNumber: documentNumber,
                            itemCode: finalItemCode,
                            lineNumber: material.lineNumber,
                            batchAllocations: batchAllocations,
                            warehouse: issueWarehouse || undefined,
                            remarks: `Material issued via Data Entry WebApp - ${batchAllocations.length} batch(es), total ${totalQty}`,
                            itemCodeChanged: itemCodeWasChanged,
                            originalItemCode: itemCodeWasChanged ? material.itemNo : undefined
                        })
                    },
                    { absoluteEntry, documentNumber }
                );
                
                if (result.success) {
                    materialIssued = true;
                    issueBtn.style.display = 'none';
                    nextBtn.style.display = 'block';
                    
                    // Disable all inputs after successful issue
                    suffixInput.disabled = true;
                    searchInput.disabled = true;
                    clearBtn.disabled = true;
                    batchTbody.querySelectorAll('input').forEach(inp => inp.disabled = true);
                    
                    // Show success message in the summary area
                    totalIssueSpan.parentElement.innerHTML = `
                        <span style="color: #16a34a; font-weight: 600;">✓ Issued ${totalQty} sq m successfully</span>
                    `;
                } else {
                    alert(`Failed to issue material:\n${result.message || result.error || 'Unknown error'}`);
                    issueBtn.disabled = false;
                    issueBtn.textContent = 'Issue Material';
                }
            } catch (error) {
                alert(`Error issuing material:\n${error.message}`);
                issueBtn.disabled = false;
                issueBtn.textContent = 'Issue Material';
            }
        });
        
        // Next button
        nextBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve({ success: true, message: 'Material issued successfully' });
        });
        } catch (error) {
            console.error('Error in showRMCBatchIssueDialog:', error);
            resolve({ success: false, message: 'Error showing RMC dialog: ' + error.message });
        }
    });
}

// Legacy wrapper for backward compatibility
async function showRMCMaterialIssueDialog(rmcMaterials, absoluteEntry, jobPlannedQty, documentNumber) {
    return processRMCMaterialsSequentially(rmcMaterials, absoluteEntry, jobPlannedQty, documentNumber);
}

// ==================== LAM Material Confirmation Dialog ====================

/**
 * Show dialog for LAM material confirmation (Lamination jobs only)
 * At Running state: Shows Film (FIL) and Adhesive (ADH) codes - operator can edit last 4 digits
 * Materials are NOT issued here - they are issued when job is FINISHED based on actual qty processed
 * 
 * Flow:
 * 1. Running state -> Show this dialog to capture/confirm material codes
 * 2. Store codes in job object (lamMaterialCodes)
 * 3. Finish job -> Calculate proportional qty based on sheets processed vs planned
 * 4. Issue materials with calculated quantities
 * 5. Post report completion to SAP
 */
async function showLAMMaterialConfirmDialog(lamMaterials, absoluteEntry, jobPlannedQty, documentNumber) {
    return new Promise(async (resolve) => {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'lam-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(4px);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
            animation: fadeIn 0.2s ease-out;
            overscroll-behavior: contain;
            touch-action: none;
        `;
        
        // LAM materials are issued from II-LAM warehouse
        const LAM_WAREHOUSE = 'II-LAM';
        
        // Separate Film and Adhesive materials
        const filmMaterial = lamMaterials.find(m => m.itemNo.toUpperCase().startsWith('FIL'));
        const adhMaterial = lamMaterials.find(m => m.itemNo.toUpperCase().startsWith('ADH'));
        
        // Extract prefixes and suffixes
        const filmPrefix = filmMaterial ? filmMaterial.itemNo.substring(0, filmMaterial.itemNo.length - 4) : '';
        const filmSuffix = filmMaterial ? filmMaterial.itemNo.substring(filmMaterial.itemNo.length - 4) : '';
        const adhPrefix = adhMaterial ? adhMaterial.itemNo.substring(0, adhMaterial.itemNo.length - 4) : '';
        const adhSuffix = adhMaterial ? adhMaterial.itemNo.substring(adhMaterial.itemNo.length - 4) : '';
        const filmSupportsNumericSuffixEdit = /^\d{4}$/.test(filmSuffix);
        const adhSupportsNumericSuffixEdit = /^\d{4}$/.test(adhSuffix);
        
        // Create modal content
        const modal = document.createElement('div');
        modal.className = 'lam-modal';
        modal.style.cssText = `
            background: white;
            border-radius: 16px;
            width: 90%;
            max-width: 450px;
            max-height: 90vh;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
            animation: slideUp 0.3s ease-out;
        `;
        
        // Build material cards HTML
        let materialsHTML = '';
        
        if (filmMaterial) {
            materialsHTML += `
                <div style="background: #ecfeff; border: 1px solid #a5f3fc; border-radius: 10px; padding: 14px; margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 20px;">🎞️</span>
                        <span style="font-size: 14px; color: #0891b2; font-weight: 700;">FILM</span>
                        <span style="font-size: 12px; color: #64748b; margin-left: auto;">Planned: ${filmMaterial.plannedQuantity}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <span style="font-size: 16px; color: #1e293b; font-weight: 700; font-family: monospace;">${filmPrefix}</span>
                        <input type="text" id="lam-film-suffix" value="${filmSuffix}" maxlength="4" 
                            data-prefix="${filmPrefix}"
                            data-original="${filmMaterial.itemNo}"
                            data-planned="${filmMaterial.plannedQuantity}"
                            data-line="${filmMaterial.lineNumber}"
                            data-editable="${filmSupportsNumericSuffixEdit ? 'true' : 'false'}"
                            ${filmSupportsNumericSuffixEdit ? '' : 'readonly'}
                            style="width: 65px; padding: 6px 8px; border: 2px solid #67e8f9; border-radius: 6px; font-size: 16px; font-weight: 700; text-align: center; font-family: monospace; background: ${filmSupportsNumericSuffixEdit ? 'white' : '#f1f5f9'}; ${filmSupportsNumericSuffixEdit ? '' : 'cursor: not-allowed;'}">
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 4px;">${filmSupportsNumericSuffixEdit ? 'Last 4 digits can be changed' : 'Code is fixed because the last 4 characters are not numeric'}</div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 6px;">${filmMaterial.itemName || ''}</div>
                    <div id="lam-uom-film" style="font-size: 11px; color: #64748b; margin-top: 4px;">UoM: —</div>
                </div>
            `;
        }
        
        if (adhMaterial) {
            materialsHTML += `
                <div style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 10px; padding: 14px; margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 20px;">🧴</span>
                        <span style="font-size: 14px; color: #b45309; font-weight: 700;">ADHESIVE</span>
                        <span style="font-size: 12px; color: #64748b; margin-left: auto;">Planned: ${adhMaterial.plannedQuantity}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <span style="font-size: 16px; color: #1e293b; font-weight: 700; font-family: monospace;">${adhPrefix}</span>
                        <input type="text" id="lam-adh-suffix" value="${adhSuffix}" maxlength="4" 
                            data-prefix="${adhPrefix}"
                            data-original="${adhMaterial.itemNo}"
                            data-planned="${adhMaterial.plannedQuantity}"
                            data-line="${adhMaterial.lineNumber}"
                            data-editable="${adhSupportsNumericSuffixEdit ? 'true' : 'false'}"
                            ${adhSupportsNumericSuffixEdit ? '' : 'readonly'}
                            style="width: 65px; padding: 6px 8px; border: 2px solid #fcd34d; border-radius: 6px; font-size: 16px; font-weight: 700; text-align: center; font-family: monospace; background: ${adhSupportsNumericSuffixEdit ? 'white' : '#f1f5f9'}; ${adhSupportsNumericSuffixEdit ? '' : 'cursor: not-allowed;'}">
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 4px;">${adhSupportsNumericSuffixEdit ? 'Last 4 digits can be changed' : 'Code is fixed because the last 4 characters are not numeric'}</div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 6px;">${adhMaterial.itemName || ''}</div>
                    <div id="lam-uom-adh" style="font-size: 11px; color: #64748b; margin-top: 4px;">UoM: —</div>
                </div>
            `;
        }
        
        modal.innerHTML = `
            <div style="background: linear-gradient(135deg, #0891b2 0%, #0e7490 100%); padding: 20px 24px; color: white;">
                <h2 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 10px;">
                    🎞️ Lamination Materials
                </h2>
                <p style="margin: 0; font-size: 12px; opacity: 0.9;">Confirm material codes before starting job</p>
            </div>
            
            <div id="lam-content-area" style="padding: 20px 24px; max-height: 55vh; overflow-y: auto;">
                <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                    <div style="font-size: 12px; color: #166534; font-weight: 600;">
                        ℹ️ Materials will be issued when you FINISH the job, based on actual sheets processed.
                    </div>
                </div>
                
                <div style="font-size: 13px; color: #374151; font-weight: 600; margin-bottom: 10px;">
                    Planned Quantity: <span style="color: #0891b2;">${jobPlannedQty.toLocaleString()} sheets</span>
                </div>
                
                ${materialsHTML}
                
                <div style="font-size: 11px; color: #6b7280; margin-top: 8px;">
                    💡 Edit last 4 digits if you need to use different material codes
                </div>
            </div>
            
            <div style="padding: 16px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; gap: 10px; justify-content: flex-end;">
                <button id="lam-cancel-btn" style="padding: 12px 20px; background: white; color: #64748b; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;">
                    Cancel
                </button>
                <button id="lam-confirm-btn" style="padding: 12px 24px; background: linear-gradient(135deg, #0891b2 0%, #0e7490 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600;">
                    ✓ Confirm & Start
                </button>
            </div>
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Get elements
        const filmSuffixInput = modal.querySelector('#lam-film-suffix');
        const adhSuffixInput = modal.querySelector('#lam-adh-suffix');
        const cancelBtn = modal.querySelector('#lam-cancel-btn');
        const confirmBtn = modal.querySelector('#lam-confirm-btn');
        const contentDiv = modal.querySelector('#lam-content-area');
        
        if (filmMaterial) {
            fetchItemInventoryUOM(filmMaterial.itemNo).then((u) => {
                const el = modal.querySelector('#lam-uom-film');
                if (el) el.textContent = u ? `UoM: ${u}` : 'UoM: —';
            });
        }
        if (adhMaterial) {
            fetchItemInventoryUOM(adhMaterial.itemNo).then((u) => {
                const el = modal.querySelector('#lam-uom-adh');
                if (el) el.textContent = u ? `UoM: ${u}` : 'UoM: —';
            });
        }
        
        // Prevent pull-to-refresh
        if (contentDiv) {
            let startY = 0;
            contentDiv.addEventListener('touchstart', (e) => {
                startY = e.touches[0].pageY;
            }, { passive: true });
            
            contentDiv.addEventListener('touchmove', (e) => {
                const currentY = e.touches[0].pageY;
                const scrollTop = contentDiv.scrollTop;
                if (scrollTop <= 0 && currentY > startY) {
                    e.preventDefault();
                }
            }, { passive: false });
        }
        
        overlay.addEventListener('touchmove', (e) => {
            if (!contentDiv.contains(e.target)) {
                e.preventDefault();
            }
        }, { passive: false });
        
        // Cancel button
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve({ success: false, message: 'LAM material confirmation cancelled' });
        });
        
        // Confirm button - capture codes and proceed (NO ISSUE YET)
        confirmBtn.addEventListener('click', () => {
            const getConfirmedMaterialCode = (input) => {
                const originalCode = input.dataset.original || '';
                if (input.dataset.editable !== 'true') {
                    return { itemCode: originalCode, codeChanged: false };
                }
                const suffix = input.value.padStart(4, '0');
                const prefix = input.dataset.prefix || '';
                const itemCode = prefix + suffix;
                return { itemCode, codeChanged: itemCode !== originalCode };
            };

            // Build material codes object to store in job
            const lamMaterialCodes = {
                plannedQty: jobPlannedQty,
                absoluteEntry: absoluteEntry,
                documentNumber: documentNumber,
                warehouse: LAM_WAREHOUSE,
                film: null,
                adhesive: null
            };
            
            // Capture Film code
            if (filmSuffixInput) {
                const confirmed = getConfirmedMaterialCode(filmSuffixInput);
                lamMaterialCodes.film = {
                    itemCode: confirmed.itemCode,
                    originalCode: filmSuffixInput.dataset.original,
                    plannedQty: parseFloat(filmSuffixInput.dataset.planned) || 0,
                    lineNumber: parseInt(filmSuffixInput.dataset.line) || 0,
                    codeChanged: confirmed.codeChanged
                };
            }
            
            // Capture Adhesive code
            if (adhSuffixInput) {
                const confirmed = getConfirmedMaterialCode(adhSuffixInput);
                lamMaterialCodes.adhesive = {
                    itemCode: confirmed.itemCode,
                    originalCode: adhSuffixInput.dataset.original,
                    plannedQty: parseFloat(adhSuffixInput.dataset.planned) || 0,
                    lineNumber: parseInt(adhSuffixInput.dataset.line) || 0,
                    codeChanged: confirmed.codeChanged
                };
            }
            
            console.log('📦 LAM material codes captured (will issue at job finish):', lamMaterialCodes);
            
            document.body.removeChild(overlay);
            resolve({ 
                success: true, 
                message: 'LAM material codes confirmed', 
                lamMaterialCodes: lamMaterialCodes 
            });
        });
        
        // Focus on first input
        if (filmSuffixInput) {
            filmSuffixInput.focus();
            filmSuffixInput.select();
        } else if (adhSuffixInput) {
            adhSuffixInput.focus();
            adhSuffixInput.select();
        }
    });
}

// Fetch job details from SAP via backend
async function fetchJobDetailsFromSAP(poNumber) {
    try {
        // Build URL with machine and process query params for validation
        const baseUrl = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.productionOrder(poNumber)}`;
        const urlParams = new URLSearchParams();
        
        // Lightweight mode for faster job load:
        // - materialOnly=1 skips optional enrichment/slow lookups on backend
        // - enrich=0 forces enrichment off even if enabled in .env
        urlParams.append('materialOnly', '1');
        urlParams.append('enrich', '0');
        
        if (machineInfo.name) {
            urlParams.append('machine', machineInfo.name);
        }
        if (machineInfo.process) {
            urlParams.append('process', machineInfo.process);
            
            // For lamination machines, also allow MPET process code jobs
            if (machineInfo.process.toLowerCase().includes('lamination')) {
                urlParams.append('allowedProcessCodes', 'LAM,MPET');
            }
        }
        
        const url = urlParams.toString() ? `${baseUrl}?${urlParams.toString()}` : baseUrl;
        console.log('Fetching from:', url);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));

            // Check if this is a process code mismatch error
            if (errorData.error === 'Process code mismatch') {
                throw new Error(`❌ Cannot add job - Wrong Machine!\n\n${errorData.message}\n\n${errorData.details}\n\nPlease search this job on the correct machine.`);
            }

            throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log('SAP Response:', result);
        
        // Debug: Log issued and completed quantities from API
        if (result && result.data) {
            console.log(`📊 API returned - issuedQuantity: ${result.data.issuedQuantity}, completedQuantity: ${result.data.completedQuantity}`);
        }

        // Backend wraps data in { success: true, data: {...} }
        if (!result || !result.success || !result.data) {
            throw new Error('Invalid response from server');
        }

        const data = result.data;

        if (!data.jobNumber) {
            throw new Error('Job number missing in response');
        }

        // Debug: Log absoluteEntry from SAP
        console.log('📋 SAP Job Data - AbsoluteEntry:', data.absoluteEntry);

        // Note: PMT materials check is now done when operator tries to start Running state
        // This allows PST jobs to be loaded even if PMT materials are not issued
        if (data.pmtMaterialsNeedIssue && data.pmtMaterialsNeedIssue.length > 0) {
            console.log('📦 PMT materials pending issue (will be checked on Running state):', data.pmtMaterialsNeedIssue);
        }
        
        // Note: RMC materials for FOI jobs must be issued BEFORE job loads
        // This is handled in the calling function (displayFetchedJob)
        if (data.rmcMaterialsNeedIssue && data.rmcMaterialsNeedIssue.length > 0) {
            console.log('📦 RMC materials need issue before job load (FOI job):', data.rmcMaterialsNeedIssue);
        }

        return data;
    } catch (error) {
        console.error('SAP Fetch Error:', error);
        throw error;
    }
}

// Display fetched job
async function displayFetchedJob(jobData) {
    // For FOI jobs: RMC materials will be checked when switching to Running state
    // (similar to PMT materials for PST jobs)
    // The rmcMaterialsNeedIssue array is preserved in jobData for later use
    
    // Fetch best historical performance for this FG number
    let estimates = null;
    if (jobData.itemNo) {
        try {
            console.log(`📊 Fetching best performance for FG: ${jobData.itemNo}`);
            const machineName = machineInfo?.name || null;
            const response = await fetch(`/api/best-performance/${encodeURIComponent(jobData.itemNo)}${machineName ? `?machineName=${encodeURIComponent(machineName)}` : ''}`);
            
            if (response.ok) {
                const data = await response.json();
                if (data.success && data.estimates) {
                    estimates = data.estimates;
                    estimates.jobCount = data.performance?.jobCount || 0;
                    // Machine names are already in data.estimates from server
                    // Only override if not present
                    if (!estimates.bestMakeReadyMachine) {
                        estimates.bestMakeReadyMachine = data.performance?.bestMakeReadyMachine || null;
                    }
                    if (!estimates.bestRunningMachine) {
                        estimates.bestRunningMachine = data.performance?.bestRunningMachine || null;
                    }
                    
                    // Calculate estimated running time based on planned quantity
                    // For DIE/EMB+P processes: historical data is in sheets, but plannedQuantity is in cartons
                    // Need to convert cartons to sheets: sheets = cartons × baseQuantity
                    // BaseQuantity = sheets per carton (e.g., 0.1 means 10 ups, so 1 sheet = 10 cartons)
                    // Example: 50,000 cartons × 0.1 baseQty = 5,000 sheets
                    if (estimates.bestRunningPerUnit && jobData.plannedQuantity) {
                        const dieCutCode = (jobData.uPCode || jobData.processCode || '').toUpperCase();
                        const baseQuantities = jobData.baseQuantities || [];
                        const isDieCuttingProcess = (jobData.plannedQuantity || 0) > 0 &&
                            isDieProcessCodeForBaseQty(dieCutCode) && baseQuantities.length > 0;
                        
                        if (isDieCuttingProcess) {
                            // For die-cutting: convert cartons to sheets
                            // plannedQuantity is in cartons, historical data is per sheet
                            // sheets = cartons × baseQuantity (or cartons / ups)
                            const avgBaseQuantity = Math.abs(baseQuantities[0]) || 1;
                            const sheetsQuantity = jobData.plannedQuantity * avgBaseQuantity;
                            estimates.estimatedRunningMinutes = estimates.bestRunningPerUnit * sheetsQuantity;
                            estimates._calculatedForSheets = sheetsQuantity;
                            console.log(`   📐 DIE/EMB+P conversion: ${jobData.plannedQuantity} cartons × ${avgBaseQuantity} baseQty = ${sheetsQuantity} sheets`);
                        } else {
                            // Standard calculation for non-die-cutting processes
                            estimates.estimatedRunningMinutes = estimates.bestRunningPerUnit * jobData.plannedQuantity;
                        }
                    }
                    
                    console.log(`   ✅ Found ${estimates.jobCount} historical jobs`);
                    console.log(`   Best MakeReady: ${estimates.bestMakeReadyMinutes} min (${estimates.bestMakeReadyMachine || 'unknown'})`);
                    console.log(`   Best Running/Unit: ${estimates.bestRunningPerUnit?.toFixed(4)} min/unit (${estimates.bestRunningMachine || 'unknown'})`);
                    if (estimates.estimatedRunningMinutes) {
                        const unitLabel = estimates._calculatedForSheets ? 'sheets' : 'units';
                        const quantity = estimates._calculatedForSheets || jobData.plannedQuantity;
                        console.log(`   Estimated Running: ${estimates.estimatedRunningMinutes.toFixed(1)} min for ${quantity} ${unitLabel}`);
                    }
                } else {
                    console.log(`   ℹ️ No historical data found for this FG`);
                }
            }
        } catch (error) {
            console.error('Error fetching best performance:', error);
        }
    }
    
    // Check for duplicate PO using validation module
    if (typeof ProductionValidation !== 'undefined') {
        const duplicateCheck = ProductionValidation.validateDuplicatePO(jobData.jobNumber, currentJobs);
        
        if (duplicateCheck.hasWarnings) {
            if (!confirm('⚠️ ' + duplicateCheck.getWarningMessages().join('\n'))) {
                console.log('Job addition cancelled by user - duplicate PO');
                return;
            }
        }
    } else {
        // Fallback duplicate check
        const existingJob = currentJobs.find(job => job.jobNumber === jobData.jobNumber);
        if (existingJob) {
            if (!confirm(`PO ${jobData.jobNumber} is already in the queue. Add another instance?`)) {
                return;
            }
        }
    }

    // Add to current jobs
    const newJob = {
        jobNumber: jobData.jobNumber,
        jobName: jobData.jobName,
        itemNo: jobData.itemNo,
        plannedQuantity: jobData.plannedQuantity,
        completedQuantity: jobData.completedQuantity || 0,  // Already completed before this batch
        issuedQuantity: jobData.issuedQuantity || 0,        // Total issued quantity from first line
        processCode: jobData.processCode,
        poNumber: jobData.poNumber || jobData.jobNumber,
        uPCode: jobData.uPCode || '',
        uJobEnt: jobData.uJobEnt ?? null,  // For job-complete auto-issue (skip SAP GET)
        absoluteEntry: jobData.absoluteEntry || null,  // SAP AbsoluteEntry for posting
        baseQuantities: jobData.baseQuantities || [],  // Array of base quantities from SAP
        fgLines: jobData.fgLines || [],  // Multi-output (jumbled) FG lines from SAP
        isJumbledJob: jobData.isJumbledJob === true || (jobData.fgLines && jobData.fgLines.length > 1),
        pmtMaterialsNeedIssue: jobData.pmtMaterialsNeedIssue || [],  // PMT materials pending issue (PST jobs)
        rmcMaterialsNeedIssue: jobData.rmcMaterialsNeedIssue || [],  // RMC materials pending issue (FOI jobs)
        lamMaterialsNeedIssue: jobData.lamMaterialsNeedIssue || [],  // LAM materials (FIL/ADH) pending issue (LAM jobs)
        unissuedMaterialsNeedIssue: jobData.unissuedMaterialsNeedIssue || [],  // Other unissued materials
        estimates: estimates,  // Historical best performance estimates
        state: 'In Queue',
        isActive: false,
        jobStartTime: null,  // Will be set when Make Ready or Running is first clicked
        jobEndTime: null,    // Will be set when job is finished
        timeBreakdown: {
            makeready: 0,
            running: 0,
            lunch: 0,
            downtime: 0,
            idle: 0,
            waiting_qc: 0,
            waiting_die: 0,
            waiting_input: 0,
            line_clearance: 0,
            cleaning: 0,
            downtime_elec: 0,
            downtime_mech: 0
        }
    };

    currentJobs.push(newJob);
    renderJobQueue(currentJobs);

    // Save job to database
    const jobId = await createJobInDatabase(newJob);
    if (jobId) {
        newJob.dbJobId = jobId; // Store database ID in job object
    }

    // Auto-select the new job
    selectJob(newJob);

    console.log('Job added to queue and saved to database:', newJob);
}

// Handle PO Search
async function handlePOSearch() {
    const poInput = document.getElementById('po-search-input');
    if (!poInput) {
        console.error('PO search input not found');
        return;
    }

    if (!requireClockedIn('loading a job')) {
        return;
    }

    const poNumber = poInput.value.trim();
    console.log('PO Number entered:', poNumber);

    if (!poNumber) {
        alert('Please enter a Production Order Number');
        return;
    }

    // RESTRICTION: Block new PO entry if a job is currently running or in make ready
    if (activeJobNumber && (activeJobState === 'running' || activeJobState === 'makeready')) {
        const stateLabel = activeJobState === 'running' ? 'Running' : 'Make Ready';
        alert(`⚠️ Cannot add new job!\n\nJob ${activeJobNumber} is currently in "${stateLabel}" state.\n\nPlease finish or cancel the current job before adding a new one.`);
        poInput.value = '';
        return;
    }

    // Show loading state
    const searchBtn = document.getElementById('po-search-btn');
    const originalText = searchBtn.textContent;
    searchBtn.textContent = 'Searching...';
    searchBtn.disabled = true;

    try {
        // Fetch job details from SAP
        const jobData = await fetchJobDetailsFromSAP(poNumber);

        // Display the job
        displayFetchedJob(jobData);

        // Clear input
        poInput.value = '';

        alert(`✅ Job loaded successfully!\n\nJob: ${jobData.jobNumber}\nItem: ${jobData.itemNo}\nDescription: ${jobData.jobName}\nQuantity: ${jobData.plannedQuantity}\nOperator: ${currentOperator || 'Not selected'}`);

    } catch (error) {
        console.error('PO Search Error:', error);
        console.error('Error stack:', error.stack);

        // Show detailed error message
        let errorMsg = `❌ Error fetching job details:\n\n${error.message}`;

        if (error.message.includes('file://')) {
            errorMsg += '\n\n💡 Solution: Use a local web server instead of opening the file directly.';
        } else if (error.message.includes('Cannot connect')) {
            errorMsg += '\n\n💡 Solution: Make sure the backend server is running (npm start)';
        } else {
            errorMsg += '\n\nPlease check:\n1. Backend server is running (npm start)\n2. SAP connection is working\n3. Production Order Number is correct';
        }

        alert(errorMsg);
    } finally {
        // Restore button state
        searchBtn.textContent = originalText;
        searchBtn.disabled = false;
    }
}

// FIX #1: Setup event listeners (NO HOLD BUTTON)
function setupEventListeners() {
    // Search (optional element)
    const searchInput = document.getElementById('job-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', handleSearch);
    }

    // State buttons
    document.querySelectorAll('.control-btn').forEach(button => {
        if (button.dataset.state) {
            button.addEventListener('click', () => handleStateChange(button.dataset.state));
        }
    });

    // PO Search button
    const poSearchBtn = document.getElementById('po-search-btn');
    if (poSearchBtn) {
        poSearchBtn.addEventListener('click', handlePOSearch);
    }

    // Shift Changeover button (now in action grid)
    const changeoverBtnMain = document.getElementById('shift-changeover-btn-main');
    if (changeoverBtnMain) {
        changeoverBtnMain.addEventListener('click', handleShiftChangeover);
    }

    // Action buttons (NO HOLD BUTTON)
    const finishBtn = document.getElementById('finish-job-btn');
    if (finishBtn) {
        finishBtn.addEventListener('click', showFinishJobModal);
    }

    // Cancel button removed - replaced with Shift Changeover in action grid

    // View summary button (shift summary)
    const summaryBtn = document.getElementById('view-summary-btn');
    if (summaryBtn) {
        summaryBtn.addEventListener('click', () => {
            if (!isShiftClockedIn()) {
                alert('Please clock in to view shift summary.');
                return;
            }
            showShiftSummary();
        });
    }

    // Reset Memory button
    const resetMemoryBtn = document.getElementById('reset-memory-btn');
    if (resetMemoryBtn) {
        resetMemoryBtn.addEventListener('click', showResetMemoryModal);
    }

    const shiftClockBtn = document.getElementById('shift-clock-btn');
    if (shiftClockBtn) {
        shiftClockBtn.addEventListener('click', () => {
            if (isShiftClockedIn()) {
                handleClockOut();
            } else {
                handleClockIn().catch(err => console.error('Clock in failed:', err));
            }
        });
    }

    // Reset Memory modal event listeners
    const resetMemoryModalClose = document.getElementById('reset-memory-modal-close');
    if (resetMemoryModalClose) {
        resetMemoryModalClose.addEventListener('click', closeResetMemoryModal);
    }

    const resetMemoryCancel = document.getElementById('reset-memory-cancel');
    if (resetMemoryCancel) {
        resetMemoryCancel.addEventListener('click', closeResetMemoryModal);
    }

    const resetMemoryConfirm = document.getElementById('reset-memory-confirm');
    if (resetMemoryConfirm) {
        resetMemoryConfirm.addEventListener('click', confirmResetMemory);
    }

    // PIN input - allow only numbers and handle Enter key
    const resetPinInput = document.getElementById('reset-pin-input');
    if (resetPinInput) {
        resetPinInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
            document.getElementById('pin-error-message').textContent = '';
        });
        resetPinInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                confirmResetMemory();
            }
        });
    }

    // Modal close buttons
    const finishModalClose = document.getElementById('finish-modal-close');
    if (finishModalClose) {
        finishModalClose.addEventListener('click', () => closeModal('finish-modal-overlay'));
    }

    const cancelModalClose = document.getElementById('cancel-modal-close');
    if (cancelModalClose) {
        cancelModalClose.addEventListener('click', () => closeModal('cancel-modal-overlay'));
    }

    const summaryModalClose = document.getElementById('summary-modal-close');
    if (summaryModalClose) {
        summaryModalClose.addEventListener('click', () => closeModal('summary-modal-overlay'));
    }

    // Job summary modal event listeners
    const jobSummaryModalClose = document.getElementById('job-summary-modal-close');
    if (jobSummaryModalClose) {
        jobSummaryModalClose.addEventListener('click', () => closeModal('job-summary-modal-overlay'));
    }

    const summaryConfirmBtn = document.getElementById('summary-confirm-btn');
    if (summaryConfirmBtn) {
        summaryConfirmBtn.addEventListener('click', confirmJobFinish);
    }

    const summaryBackBtn = document.getElementById('summary-back-btn');
    if (summaryBackBtn) {
        summaryBackBtn.addEventListener('click', () => {
            // Close the summary modal and go back to the finish job modal
            closeModal('job-summary-modal-overlay');
            showModal('finish-modal-overlay');
        });
    }

    const summarySheetsInput = document.getElementById('summary-sheets-processed');
    if (summarySheetsInput && typeof window.updateJumbledSummaryFGQuantities === 'function') {
        summarySheetsInput.addEventListener('input', window.updateJumbledSummaryFGQuantities);
    }

    const finishCancelBtn = document.getElementById('finish-cancel-btn');
    if (finishCancelBtn) {
        finishCancelBtn.addEventListener('click', () => closeModal('finish-modal-overlay'));
    }

    const cancelCancelBtn = document.getElementById('cancel-cancel-btn');
    if (cancelCancelBtn) {
        cancelCancelBtn.addEventListener('click', () => closeModal('cancel-modal-overlay'));
    }

    // Breakdown reason modal event listeners
    const breakdownModalClose = document.getElementById('breakdown-modal-close');
    if (breakdownModalClose) {
        breakdownModalClose.addEventListener('click', () => closeModal('breakdown-reason-modal-overlay'));
    }

    const breakdownCancelBtn = document.getElementById('breakdown-cancel-btn');
    if (breakdownCancelBtn) {
        breakdownCancelBtn.addEventListener('click', () => closeModal('breakdown-reason-modal-overlay'));
    }

    const breakdownForm = document.getElementById('breakdown-reason-form');
    if (breakdownForm) {
        breakdownForm.addEventListener('submit', handleBreakdownReasonSubmit);
    }

    // Speech-to-text for breakdown reason
    const micBtn = document.getElementById('breakdown-mic-btn');
    if (micBtn) {
        micBtn.addEventListener('click', toggleSpeechToText);
    }

    // Form submissions
    const finishForm = document.getElementById('finish-job-form');
    if (finishForm) {
        finishForm.addEventListener('submit', handleFinishJob);
    }

    const cancelForm = document.getElementById('cancel-job-form');
    if (cancelForm) {
        cancelForm.addEventListener('submit', handleCancelJob);
    }

    // Close modal on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeModal(overlay.id);
            }
        });
    });
    
    // Setup makeready type modal listeners
    setupMakereadyTypeModalListeners();
}

// Handle search
function handleSearch(event) {
    const searchTerm = event.target.value.toLowerCase().trim();

    if (searchTerm === '') {
        renderJobQueue(currentJobs);
    } else {
        const filteredJobs = currentJobs.filter(job =>
            job.jobNumber.toLowerCase().includes(searchTerm)
        );
        renderJobQueue(filteredJobs);
    }
}

// Handle state change with validation
function handleStateChange(state) {
    console.log(`🔄 State change requested: ${state}`);

    // Use validation module if available
    if (typeof ProductionValidation !== 'undefined') {
        const validationResult = ProductionValidation.validateStateChange({
            newState: state,
            selectedJob: selectedJob,
            activeJobNumber: activeJobNumber,
            activeJobState: activeJobState
        });

        if (validationResult.hasErrors) {
            alert('❌ ' + validationResult.getErrorMessages().join('\n'));
            console.log('❌ Blocked by validation:', validationResult.errors);
            return;
        }

        if (validationResult.hasWarnings) {
            if (!confirm('⚠️ Warning:\n' + validationResult.getWarningMessages().join('\n') + '\n\nContinue?')) {
                console.log('❌ Cancelled by user after warning');
                return;
            }
        }
    } else {
        // Fallback validation if module not loaded
        // makeready, running, feeder_trip, sticky_sheets, and sorting_waiting require a job selection
        const jobRequiredStates = ['running', 'makeready', 'feeder_trip', 'sticky_sheets', 'sorting_waiting'];
        if (jobRequiredStates.includes(state) && !selectedJob) {
            if (state === 'feeder_trip' || state === 'sticky_sheets' || state === 'sorting_waiting') {
                alert('Please select a job first to track Feeder Trip, Sticky Sheets, or Sorting Waiting time');
            } else {
            alert('Please select a job first to track Make Ready or Running time');
            }
            console.log('❌ Blocked: No job selected for production state');
            return;
        }

        // Validate state change for Running/MakeReady - only one job can be in these states
        if ((state === 'running' || state === 'makeready') &&
            activeJobNumber && activeJobNumber !== selectedJob.jobNumber) {
            alert(`Cannot start this job. Job ${activeJobNumber} is already ${activeJobState === 'running' ? 'Running' : 'in Make Ready'}.\n\nPlease finish or cancel the current job first.`);
            console.log(`❌ Blocked: Another job is active (${activeJobNumber})`);
            return;
        }

        // Must be clocked in before starting work
        if (state === 'running' || state === 'makeready') {
            if (!requireClockedIn('starting a job')) {
                return;
            }
        }
    }

    // Material issue checks before allowing Running state — FIRST TIME ONLY.
    // Once materials have been checked/issued for this job, subsequent Running presses
    // (e.g. resuming from lunch/breakdown) skip straight to proceedWithStateChange.
    if (state === 'running' && selectedJob && machineInfo.name !== 'wity' && !selectedJob._materialIssueChecked) {
        // Show an instant blocking overlay so the operator gets immediate feedback.
        // This makes the "Running" click feel responsive even if SAP fetch takes time.
        const _materialCheckOverlayId = 'material-check-overlay';
        const showMaterialCheckOverlay = () => {
            try {
                if (document.getElementById(_materialCheckOverlayId)) return;
                const overlay = document.createElement('div');
                overlay.id = _materialCheckOverlayId;
                overlay.style.cssText = `
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(15, 23, 42, 0.70);
                    backdrop-filter: blur(3px);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 20000;
                `;
                const card = document.createElement('div');
                card.style.cssText = `
                    background: #0b1220;
                    color: #e2e8f0;
                    border: 1px solid rgba(148, 163, 184, 0.25);
                    border-radius: 12px;
                    padding: 16px 18px;
                    width: min(420px, calc(100vw - 32px));
                    box-shadow: 0 18px 50px rgba(0,0,0,0.35);
                    font-size: 14px;
                `;
                card.innerHTML = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:10px;height:10px;border-radius:50%;background:#38bdf8; box-shadow: 0 0 0 6px rgba(56,189,248,0.18);"></div>
                        <div style="font-weight:600;">Checking materials…</div>
                    </div>
                    <div style="margin-top:6px; opacity:0.85;">Please wait. If anything needs issuing, the popup will open next.</div>
                `;
                overlay.appendChild(card);
                document.body.appendChild(overlay);
            } catch (e) {
                console.warn('Failed to show material overlay:', e);
            }
        };
        const hideMaterialCheckOverlay = () => {
            const el = document.getElementById(_materialCheckOverlayId);
            if (el) el.remove();
        };

        showMaterialCheckOverlay();
        (async () => {
            try {
                // Fresh fetch from SAP to ensure material arrays reflect current state
                try {
                    const freshUrl = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.productionOrder(selectedJob.jobNumber)}?materialOnly=1&machine=${encodeURIComponent(machineInfo.name || '')}&process=${encodeURIComponent(machineInfo.process || '')}`;
                    const freshResp = await fetch(freshUrl, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
                    const freshJson = await freshResp.json();
                    const freshData = freshJson?.data || freshJson;
                    if (freshData) {
                        selectedJob.pmtMaterialsNeedIssue = freshData.pmtMaterialsNeedIssue || [];
                        selectedJob.rmcMaterialsNeedIssue = freshData.rmcMaterialsNeedIssue || [];
                        selectedJob.lamMaterialsNeedIssue = freshData.lamMaterialsNeedIssue || [];
                        selectedJob.unissuedMaterialsNeedIssue = freshData.unissuedMaterialsNeedIssue || [];
                        console.log('📦 Fresh material data from SAP:', {
                            pmt: selectedJob.pmtMaterialsNeedIssue.length,
                            rmc: selectedJob.rmcMaterialsNeedIssue.length,
                            lam: selectedJob.lamMaterialsNeedIssue.length,
                            other: selectedJob.unissuedMaterialsNeedIssue.length
                        });
                    }
                } catch (err) {
                    console.error('Fresh material fetch failed, using cached data:', err);
                }

            // --- Step 1: PMT — dedicated issue dialog (PST jobs) ---
            // Issue PMT materials (batch-managed or not). Dialog auto-issues via /issue-material.
            const pmtPending = (selectedJob.pmtMaterialsNeedIssue || []).filter(m => m?.itemNo);
            if (pmtPending.length > 0) {
                for (let i = 0; i < pmtPending.length; i++) {
                    hideMaterialCheckOverlay();
                    console.log('📦 PMT material needs issue:', pmtPending[i]);
                    const pmtResult = await showPMTMaterialIssueDialog(
                        [pmtPending[i]],
                        selectedJob.absoluteEntry,
                        selectedJob.plannedQuantity,
                        selectedJob.jobNumber
                    );
                    if (!pmtResult || !pmtResult.success) {
                        console.log('❌ PMT issue cancelled');
                        return;
                    }
                }
                selectedJob.pmtMaterialsNeedIssue = [];
                console.log('✅ PMT materials issued successfully');
            }

            // --- Step 2: ADH — code capture dialog (LAM jobs) ---
            // Capture ADH codes regardless of batchManaged (material will be issued on FINISH).
            const adhPending = (selectedJob.lamMaterialsNeedIssue || [])
                .filter(m => (m?.itemNo || '').toUpperCase().startsWith('ADH'));
            if (adhPending.length > 0 && !selectedJob.lamMaterialCodes) {
                hideMaterialCheckOverlay();
                console.log('📦 ADH materials need code capture:', adhPending);
                const confirmResult = await showLAMMaterialConfirmDialog(
                    adhPending,
                    selectedJob.absoluteEntry,
                    selectedJob.plannedQuantity,
                    selectedJob.jobNumber
                );
                if (!confirmResult || !confirmResult.success) {
                    console.log('❌ ADH code capture cancelled');
                    return;
                }
                selectedJob.lamMaterialCodes = confirmResult.lamMaterialCodes;
                console.log('✅ ADH codes stored for job finish:', selectedJob.lamMaterialCodes);
            }

            // --- Step 3: Batch issue modal for remaining batch-managed materials ---
            // Non-batch materials are skipped entirely (issued automatically by SAP or handled elsewhere).
            const batchCandidates = [
                ...(selectedJob.unissuedMaterialsNeedIssue || []),
                ...(selectedJob.rmcMaterialsNeedIssue || []),
                ...((selectedJob.lamMaterialsNeedIssue || []).filter(m =>
                    !(m?.itemNo || '').toUpperCase().startsWith('ADH'))),
            ].filter(m => {
                const code = (m?.itemNo || '').toUpperCase();
                if (!code) return false;
                if (code.startsWith('ADH')) return false;
                if (code.startsWith('PMT')) return false;
                if (!m.batchManaged) return false;
                return true;
            });

            for (let i = 0; i < batchCandidates.length; i++) {
                const mat = batchCandidates[i];
                hideMaterialCheckOverlay();
                const result = await showRMCBatchIssueDialog(
                    mat,
                    selectedJob.absoluteEntry,
                    selectedJob.plannedQuantity,
                    selectedJob.jobNumber,
                    i + 1,
                    batchCandidates.length,
                    i === batchCandidates.length - 1
                );
                if (!result || result.success !== true) return;
            }

            // Clear all material arrays after successful processing
            selectedJob.unissuedMaterialsNeedIssue = [];
            selectedJob.pmtMaterialsNeedIssue = [];
            selectedJob.rmcMaterialsNeedIssue = [];
            selectedJob.lamMaterialsNeedIssue = [];

            // Mark material issue as done so subsequent Running presses skip this block
            selectedJob._materialIssueChecked = true;
            proceedWithStateChange(state);
            } finally {
                hideMaterialCheckOverlay();
            }
        })().catch(err => {
            const el = document.getElementById('material-check-overlay');
            if (el) el.remove();
            console.error('Error in material issue check:', err);
            alert(`Error handling material issue.\n\n${err?.message || err}`);
        });

        return;
    }

    // Check if switching to makeready state - show type selection modal
    if (state === 'makeready') {
        showMakereadyTypeModal();
        return; // Exit here, state change will happen after type is selected
    }

    // Check if switching to a breakdown state (electrical or mechanical)
    // Show popup to collect breakdown reason
    if (state === 'downtime_elec' || state === 'downtime_mech') {
        showBreakdownReasonModal(state);
        return; // Exit here, state change will happen after reason is submitted
    }

    // Proceed with state change
    proceedWithStateChange(state);
}

// Continue with state change after validations pass
function proceedWithStateChange(state) {
    // Save current state's time before switching (calculate from timestamp)
    if (currentMachineState) {
        timerSeconds = calculateCurrentTimerSeconds();
        stateTimers[currentMachineState] = timerSeconds;

        // Also save to selected job's time breakdown
        if (selectedJob) {
            if (!selectedJob.timeBreakdown) {
                selectedJob.timeBreakdown = {
                    makeready: 0,
                    running: 0,
                    lunch: 0,
                    cleaning: 0,
                    waiting_qc: 0,
                    waiting_die: 0,
                    waiting_input: 0,
                    line_clearance: 0,
                    downtime_elec: 0,
                    downtime_mech: 0,
                    downtime: 0,
                    idle: 0
                };
            }
            selectedJob.timeBreakdown[currentMachineState] = timerSeconds;
        }

        console.log(`⏸️ Paused ${currentMachineState}: ${formatTime(timerSeconds)}`);
    }

    // Stop current timer
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    // Log state change to database if there was a previous state
    if (currentMachineState && timerSeconds > 0) {
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - (timerSeconds * 1000));
        logStateChange(currentMachineState, startTime, endTime, timerSeconds);
    }

    // Update active state on buttons
    document.querySelectorAll('.control-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.state === state) {
            btn.classList.add('active');
        }
    });

    // Update current machine state
    currentMachineState = state;

    // Live tracking: record state change (start time captured server-side)
    if (typeof LiveTracking !== 'undefined') {
        LiveTracking.setState(state);
    }

    // Track active job for Running/MakeReady states
    if (state === 'running' || state === 'makeready') {
        if (selectedJob) {
            activeJobNumber = selectedJob.jobNumber;
            activeJobState = state;
            selectedJob.isActive = true;
            selectedJob.state = state === 'running' ? 'Running' : 'Make Ready';
            
            // Capture job start time when Make Ready or Running is FIRST clicked
            if (!selectedJob.jobStartTime) {
                selectedJob.jobStartTime = getISTTimestamp();
                console.log(`📍 Job ${selectedJob.jobNumber} started at: ${selectedJob.jobStartTime} (IST)`);

                // Live tracking: record loaded job + load time for the dashboard
                if (typeof LiveTracking !== 'undefined') {
                    LiveTracking.jobLoad({
                        po: selectedJob.jobNumber,
                        jobName: selectedJob.jobName || selectedJob.itemName || selectedJob.fgItemCode,
                        fgNum: selectedJob.fgItemCode || selectedJob.itemNo,
                        plannedQty: selectedJob.plannedQuantity
                    });
                }
            }
            
            // Update PO input state (disable when job is running)
            updatePOInputState();
        }
    }

    // Update job card status badge only if a job is selected
    const statusBadge = document.getElementById('selected-job-status');
    if (statusBadge && selectedJob) {
        const stateLabels = {
            'makeready': 'Make Ready',
            'running': 'Running',
            'lunch': 'Lunch Break',
            'cleaning': 'Cleaning',
            'waiting_qc': 'Waiting QC',
            'waiting_die': 'Waiting Die',
            'waiting_input': 'Waiting Input',
            'line_clearance': 'Line Clearance',
            'downtime_elec': 'Downtime (Electrical)',
            'downtime_mech': 'Downtime (Mechanical)',
            'feeder_trip': 'Feeder Trip',
            'sticky_sheets': 'Sticky Sheets',
            'sorting_waiting': 'Sorting Waiting'
        };
        statusBadge.textContent = stateLabels[state] || state;
        statusBadge.className = `status-badge ${getStatusClass(state)}`;
    }

    // Update state label
    const stateLabels = {
        'makeready': 'Make Ready',
        'running': 'Running',
        'lunch': 'Lunch Break',
        'cleaning': 'Cleaning',
        'waiting_qc': 'Waiting QC',
        'waiting_die': 'Waiting Die',
        'waiting_input': 'Waiting Input',
        'line_clearance': 'Line Clearance',
        'downtime_elec': 'Downtime (Electrical)',
        'downtime_mech': 'Downtime (Mechanical)',
        'downtime': 'Downtime',
        'idle': 'Idle',
        'feeder_trip': 'Feeder Trip',
        'sticky_sheets': 'Sticky Sheets',
        'sorting_waiting': 'Sorting Waiting'
    };

    const currentStateLabel = document.getElementById('current-state-label');
    if (currentStateLabel) {
        currentStateLabel.textContent = stateLabels[state] || state;
    }

    // Resume timer from saved time using timestamp-based tracking
    // ALL states now resume from the job's timeBreakdown (if a job is selected)
    if (selectedJob) {
        // Use job's time breakdown if it exists for ANY state
        accumulatedStateTime = selectedJob.timeBreakdown?.[state] || 0;
        console.log(`▶️ Starting ${state} from job time: ${formatTime(accumulatedStateTime)}`);
    } else {
        // No job selected - start from 0
        accumulatedStateTime = 0;
        console.log(`▶️ Starting ${state} from: 00:00:00 (no job selected)`);
    }

    // Set new start timestamp for this state
    stateStartTimestamp = Date.now();
    timerSeconds = accumulatedStateTime;
    
    updateTimerDisplay();
    startTimer();
    
    // Save state immediately
    saveStateToStorage();

    console.log(`✅ State changed to: ${state}${selectedJob ? ' for job: ' + selectedJob.jobNumber : ' (no job selected)'}`);
}

// Timer functions - Timestamp-based (survives screen off)
function startTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
    }

    // Set start timestamp if not already set
    if (!stateStartTimestamp) {
        stateStartTimestamp = Date.now();
    }

    // Update display immediately
    timerSeconds = calculateCurrentTimerSeconds();
    updateTimerDisplay();

    // Update display every second (but actual time is calculated from timestamp)
    timerInterval = setInterval(() => {
        timerSeconds = calculateCurrentTimerSeconds();
        stateTimers[currentMachineState] = timerSeconds;
        updateTimerDisplay();
        
        // Auto-save every 10 seconds
        if (timerSeconds % 10 === 0) {
            saveStateToStorage();
        }
    }, 1000);
}

function resetTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    timerSeconds = 0;
    stateStartTimestamp = null;
    accumulatedStateTime = 0;
    updateTimerDisplay();
}

function resetAllStateTimers() {
    stateTimers = {
        makeready: 0,
        running: 0,
        lunch: 0,
        cleaning: 0,
        waiting_qc: 0,
        waiting_die: 0,
        waiting_input: 0,
        line_clearance: 0,
        downtime_elec: 0,
        downtime_mech: 0,
        downtime: 0,
        idle: 0,
        feeder_trip: 0,
        sticky_sheets: 0,
        sorting_waiting: 0
    };

    resetTimer();
    currentMachineState = null;
    stateStartTimestamp = null;
    accumulatedStateTime = 0;

    document.querySelectorAll('.state-button').forEach(btn => {
        btn.classList.remove('active');
    });
    
    saveStateToStorage();
}

function updateTimerDisplay() {
    const displaySeconds = timerSeconds;
    const hours = Math.floor(displaySeconds / 3600);
    const minutes = Math.floor((displaySeconds % 3600) / 60);
    const seconds = displaySeconds % 60;

    const display = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    const timerDisplay = document.getElementById('timer-display');
    if (timerDisplay) {
        timerDisplay.textContent = display;
    }
}

// Legacy alias — footer now shows operator + shift timer only
function updateFooterStats() {
    updateShiftFooterDisplay();
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Modal functions
function showModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// ==================== Makeready Type Selection Modal ====================

// Variable to store pending makeready state change
let pendingMakereadyStateChange = null;

/**
 * Show makeready type selection modal
 * Called when user clicks Make Ready button
 */
function showMakereadyTypeModal() {
    pendingMakereadyStateChange = 'makeready';
    showModal('makeready-type-modal-overlay');
    console.log('📋 Showing makeready type selection modal');
}

/**
 * Handle makeready type selection
 * @param {string} type - 'new' or 'repeat'
 */
function handleMakereadyTypeSelection(type) {
    currentMakereadyType = type;
    
    // Store makeready type in selected job
    if (selectedJob) {
        selectedJob.makereadyType = type;
    }
    
    console.log(`🔧 Makeready type selected: ${type === 'new' ? 'New Makeready' : 'Repeat Makeready'}`);
    
    // Close the modal
    closeModal('makeready-type-modal-overlay');
    
    // Proceed with the state change
    if (pendingMakereadyStateChange) {
        proceedWithStateChange(pendingMakereadyStateChange);
        pendingMakereadyStateChange = null;
    }
}

/**
 * Setup makeready type modal event listeners
 */
function setupMakereadyTypeModalListeners() {
    // Close button
    const closeBtn = document.getElementById('makeready-type-modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            closeModal('makeready-type-modal-overlay');
            pendingMakereadyStateChange = null;
        });
    }
    
    // Type selection buttons
    const typeButtons = document.querySelectorAll('.makeready-type-btn');
    typeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            handleMakereadyTypeSelection(type);
        });
    });
    
    // Close on overlay click
    const overlay = document.getElementById('makeready-type-modal-overlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeModal('makeready-type-modal-overlay');
                pendingMakereadyStateChange = null;
            }
        });
    }
}

// ==================== End Makeready Type Modal ====================

// Variable to store pending breakdown state
let pendingBreakdownState = null;

// Show breakdown reason modal
function showBreakdownReasonModal(state) {
    pendingBreakdownState = state;
    
    // Set the breakdown type display
    const typeDisplay = document.getElementById('breakdown-type-display');
    const stateInput = document.getElementById('breakdown-state');
    const modalTitle = document.getElementById('breakdown-modal-title');
    const reasonTextarea = document.getElementById('breakdown-reason');
    
    const breakdownTypeNames = {
        'downtime_elec': 'Electrical Breakdown',
        'downtime_mech': 'Mechanical Breakdown'
    };
    
    const displayName = breakdownTypeNames[state] || 'Breakdown';
    
    if (typeDisplay) typeDisplay.value = displayName;
    if (stateInput) stateInput.value = state;
    if (modalTitle) modalTitle.textContent = `${displayName} - Enter Reason`;
    if (reasonTextarea) reasonTextarea.value = ''; // Clear previous reason
    
    showModal('breakdown-reason-modal-overlay');
    
    // Focus on the reason textarea
    if (reasonTextarea) {
        setTimeout(() => reasonTextarea.focus(), 100);
    }
    
    console.log(`📋 Showing breakdown reason modal for: ${displayName}`);
}

// Handle breakdown reason form submission
function handleBreakdownReasonSubmit(event) {
    event.preventDefault();
    
    const reason = document.getElementById('breakdown-reason').value.trim();
    const state = document.getElementById('breakdown-state').value;
    
    if (!reason) {
        alert('Please enter a reason for the breakdown.');
        return;
    }
    
    // Store the breakdown reason (can be used for logging/reporting)
    const breakdownData = {
        state: state,
        reason: reason,
        timestamp: new Date().toISOString(),
        jobNumber: selectedJob?.jobNumber || null,
        machineId: machineInfo.id || null,
        machineName: machineInfo.name || null,
        operatorName: currentOperator || 'Unknown'
    };
    
    console.log('📝 Breakdown reason recorded:', breakdownData);
    
    // Store breakdown reasons in localStorage for persistence
    saveBreakdownReason(breakdownData);
    
    // Close the modal
    closeModal('breakdown-reason-modal-overlay');
    
    // Stop speech recognition if active
    stopSpeechRecognition();
    
    // Proceed with the state change
    if (pendingBreakdownState) {
        proceedWithStateChange(pendingBreakdownState);
        pendingBreakdownState = null;
    }
}

// Speech-to-Text functionality
let speechRecognition = null;
let isListening = false;

// Initialize speech recognition
function initSpeechRecognition() {
    if ('webkitSpeechRecognition' in window) {
        speechRecognition = new webkitSpeechRecognition();
    } else if ('SpeechRecognition' in window) {
        speechRecognition = new SpeechRecognition();
    } else {
        console.log('Speech recognition not supported');
        return null;
    }
    
    // Improved settings for better accuracy
    speechRecognition.continuous = false;        // Single utterance mode for better accuracy
    speechRecognition.interimResults = true;     // Show interim results
    speechRecognition.maxAlternatives = 3;       // Get multiple alternatives for better matching
    speechRecognition.lang = 'en-IN';            // English (India)
    
    let finalText = '';
    
    speechRecognition.onstart = () => {
        isListening = true;
        finalText = '';
        updateMicUI(true);
        console.log('🎤 Speech recognition started');
    };
    
    speechRecognition.onend = () => {
        isListening = false;
        updateMicUI(false);
        console.log('🎤 Speech recognition ended');
    };
    
    speechRecognition.onresult = (event) => {
        const textarea = document.getElementById('breakdown-reason');
        let interimTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript;
            const confidence = result[0].confidence;
            
            if (result.isFinal) {
                // Use the result with highest confidence
                let bestTranscript = transcript;
                let bestConfidence = confidence;
                
                // Check alternatives for better match
                for (let j = 1; j < result.length; j++) {
                    if (result[j].confidence > bestConfidence) {
                        bestTranscript = result[j].transcript;
                        bestConfidence = result[j].confidence;
                    }
                }
                
                finalText = bestTranscript;
                console.log(`🎤 Final: "${finalText}" (confidence: ${(bestConfidence * 100).toFixed(1)}%)`);
                
                // Append to existing text
                const currentText = textarea.value.trim();
                textarea.value = currentText + (currentText ? ' ' : '') + finalText.trim();
                updateMicStatus('success', `Added! (${(bestConfidence * 100).toFixed(0)}% confident)`);
            } else {
                interimTranscript = transcript;
                updateMicStatus('listening', '🎤 ' + interimTranscript);
            }
        }
    };
    
    speechRecognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        isListening = false;
        updateMicUI(false);
        
        switch(event.error) {
            case 'no-speech':
                updateMicStatus('error', 'No speech detected. Tap mic and speak clearly.');
                break;
            case 'not-allowed':
                updateMicStatus('error', 'Microphone blocked. Allow access in browser settings.');
                break;
            case 'network':
                updateMicStatus('error', 'Network error. Check internet connection.');
                break;
            case 'audio-capture':
                updateMicStatus('error', 'No microphone found.');
                break;
            default:
                updateMicStatus('error', 'Error: ' + event.error);
        }
    };
    
    return speechRecognition;
}

// Toggle speech recognition
function toggleSpeechToText() {
    if (!speechRecognition) {
        speechRecognition = initSpeechRecognition();
    }
    
    if (!speechRecognition) {
        alert('Speech recognition is not supported in your browser.\n\nPlease use:\n• Chrome (recommended)\n• Edge\n• Safari on iOS');
        return;
    }
    
    if (isListening) {
        stopSpeechRecognition();
    } else {
        startSpeechRecognition();
    }
}

// Start speech recognition
function startSpeechRecognition() {
    if (speechRecognition && !isListening) {
        // Get selected language
        const langSelect = document.getElementById('speech-language');
        if (langSelect) {
            speechRecognition.lang = langSelect.value;
        }
        
        try {
            speechRecognition.start();
            updateMicStatus('listening', '🎤 Listening... Speak clearly');
        } catch (e) {
            console.error('Error starting speech recognition:', e);
            // If already started, stop and restart
            if (e.message.includes('already started')) {
                speechRecognition.stop();
                setTimeout(() => {
                    speechRecognition.start();
                }, 100);
            } else {
                updateMicStatus('error', 'Could not start. Try again.');
            }
        }
    }
}

// Stop speech recognition
function stopSpeechRecognition() {
    if (speechRecognition && isListening) {
        speechRecognition.stop();
        isListening = false;
        updateMicUI(false);
        updateMicStatus('', '');
    }
}

// Update microphone button UI
function updateMicUI(listening) {
    const micBtn = document.getElementById('breakdown-mic-btn');
    if (micBtn) {
        if (listening) {
            micBtn.classList.add('listening');
            micBtn.innerHTML = '⏹️';
            micBtn.title = 'Click to stop';
        } else {
            micBtn.classList.remove('listening');
            micBtn.innerHTML = '🎤';
            micBtn.title = 'Click to speak';
        }
    }
}

// Update mic status text
function updateMicStatus(type, message) {
    const statusEl = document.getElementById('mic-status');
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.className = 'mic-status';
        if (type) {
            statusEl.classList.add(type);
        }
    }
}

// Save breakdown reason to localStorage and optionally to server
function saveBreakdownReason(breakdownData) {
    // Get existing breakdown reasons from localStorage
    const storageKey = `breakdownReasons_${machineInfo.id || 'unknown'}`;
    let breakdownReasons = [];
    
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
            breakdownReasons = JSON.parse(stored);
        }
    } catch (e) {
        console.error('Error reading breakdown reasons from localStorage:', e);
    }
    
    // Add new breakdown reason
    breakdownReasons.push(breakdownData);
    
    // Keep only last 100 entries to prevent localStorage overflow
    if (breakdownReasons.length > 100) {
        breakdownReasons = breakdownReasons.slice(-100);
    }
    
    // Save back to localStorage
    try {
        localStorage.setItem(storageKey, JSON.stringify(breakdownReasons));
        console.log('✅ Breakdown reason saved to localStorage');
    } catch (e) {
        console.error('Error saving breakdown reason to localStorage:', e);
    }
    
    // Raise ticket in AppSheet
    raiseAppSheetBreakdownTicket(breakdownData);
}

// AppSheet API Configuration (via server proxy to avoid CORS)
const APPSHEET_PROXY_URL = `${API_BASE_URL}/appsheet/breakdown-ticket`;

// Get 3-letter machine code from machine name
function getMachineCode(machineName) {
    if (!machineName) return 'UNK';
    
    const name = machineName.toLowerCase();
    
    // Define machine code mappings
    const machineCodeMap = {
        'nova-cut-1': 'NC1',
        'nova-cut-2': 'NC2',
        'nova-cut-3': 'NC3',
        'ambition': 'AMB',
        'bobst': 'BOB',
        'heidelberg': 'HDB',
        'komori': 'KMR',
        'narendra': 'NAR',
        'polar': 'POL',
        'stahl': 'STL',
        'wohlenberg': 'WHL',
        'mk-foiling': 'MKF',
        'manual-mf': 'MMF',
        'manual-mdc-1': 'MM1',
        'manual-mdc-2': 'MM2',
        'manual-mdc-3': 'MM3',
        'manual-mdc-4': 'MM4',
        'visionfold': 'VIS',
        'nova-fold': 'NOV',
        'yilee': 'YIL',
        'yong-shun': 'YON',
        'wity': 'WIT',
        'embossing-1': 'EM1',
        'embossing-2': 'EM2',
        'embossing-3': 'EM3',
        'rewinding-1': 'RW1',
        'rewinding-2': 'RW2',
        'slitting-1': 'SL1',
        'slitting-2': 'SL2',
        'metallisation-1': 'ML1'
    };
    
    // Check for exact match first
    if (machineCodeMap[name]) {
        return machineCodeMap[name];
    }
    
    // Try partial match
    for (const [key, code] of Object.entries(machineCodeMap)) {
        if (name.includes(key.split('-')[0])) {
            // For machines like nova-cut-X, append the number
            const match = name.match(/(\d+)$/);
            if (match) {
                return code.slice(0, 2) + match[1];
            }
            return code;
        }
    }
    
    // Fallback: take first 3 characters and uppercase
    return name.replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase() || 'UNK';
}

// Get next ticket counter (common across all machines)
function getNextTicketCounter() {
    const counterKey = 'breakdownTicketCounter';
    let counter = 1;
    
    try {
        const stored = localStorage.getItem(counterKey);
        if (stored) {
            counter = parseInt(stored, 10) + 1;
        }
    } catch (e) {
        console.error('Error reading ticket counter:', e);
    }
    
    // Save the new counter
    try {
        localStorage.setItem(counterKey, counter.toString());
    } catch (e) {
        console.error('Error saving ticket counter:', e);
    }
    
    return counter;
}

// Generate ticket ID in format: MachineCode + 4-digit counter
// e.g., NC10001, AMB0002, NC20003
function generateTicketId(machineName) {
    const machineCode = getMachineCode(machineName);
    const counter = getNextTicketCounter();
    const paddedCounter = counter.toString().padStart(4, '0');
    
    return `${machineCode}${paddedCounter}`;
}

// Raise breakdown ticket in AppSheet (via server proxy)
async function raiseAppSheetBreakdownTicket(breakdownData) {
    const breakdownType = breakdownData.state === 'downtime_elec' ? 'Electrical' : 'Mechanical';
    
    // Generate ticket ID in format: XXX0001
    const ticketId = generateTicketId(breakdownData.machineName);
    
    // Format timestamp for AppSheet DateTime format
    const createdAt = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    // Prepare the row data for AppSheet
    // Description format: [Type]-[Machine]\nDescription\n[Operator- name]
    const description = `[${breakdownType}]-[${breakdownData.machineName || 'Unknown'}]
${breakdownData.reason}
[Operator- ${breakdownData.operatorName || 'Unknown'}]`;

    const ticketData = {
        'Id': ticketId,
        'Issue': 'Breakdown',
        'Description': description,
        'Status': 'Open',
        'Created At': createdAt,
        'Department': 'Post Press'
    };
    
    console.log('🎫 Raising AppSheet breakdown ticket via server:', ticketData);
    
    try {
        const response = await fetch(APPSHEET_PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ticketData })
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            console.log('✅ AppSheet ticket raised successfully:', result);
            showTicketSuccessNotification(ticketId, breakdownType);
        } else {
            console.error('❌ AppSheet API error:', result);
            showTicketErrorNotification(result.message || 'Failed to raise ticket in AppSheet');
        }
    } catch (error) {
        console.error('❌ Error raising AppSheet ticket:', error);
        showTicketErrorNotification('Network error - ticket saved locally');
    }
}

// Show success notification for ticket creation
function showTicketSuccessNotification(ticketId, issueType) {
    // Create a toast notification
    const toast = document.createElement('div');
    toast.className = 'ticket-toast ticket-toast-success';
    toast.innerHTML = `
        <div class="ticket-toast-icon">✅</div>
        <div class="ticket-toast-content">
            <div class="ticket-toast-title">Maintenance Ticket Raised</div>
            <div class="ticket-toast-message">Ticket ID: ${ticketId}<br>${issueType} breakdown reported</div>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 100);
    
    // Remove after 5 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Show error notification for ticket creation
function showTicketErrorNotification(message) {
    const toast = document.createElement('div');
    toast.className = 'ticket-toast ticket-toast-error';
    toast.innerHTML = `
        <div class="ticket-toast-icon">⚠️</div>
        <div class="ticket-toast-content">
            <div class="ticket-toast-title">Ticket Warning</div>
            <div class="ticket-toast-message">${message}</div>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 100);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Check if current machine is a Lamination machine
function isLaminationMachine() {
    return machineInfo.process && machineInfo.process.toLowerCase().includes('lamination');
}

// Check if current machine is Narendra (special lamination machine)
function isNarendraMachine() {
    return machineInfo.name && machineInfo.name.toLowerCase() === 'narendra';
}

// Check if current machine is a Folding & Pasting machine
function isFoldingPastingMachine() {
    return machineInfo.process && machineInfo.process.toLowerCase().includes('pasting-folding');
}

// Check if current machine is a DieCutting machine
function isDieCuttingMachine() {
    const process = machineInfo.process?.toLowerCase() || '';
    return process.includes('diecutting') || process.includes('die-cutting') || process.includes('die cutting');
}

// Check if current machine is a Foiling machine
function isFoilingMachine() {
    const process = machineInfo.process?.toLowerCase() || '';
    return process.includes('foiling');
}

// Check if the current sub-process is a DieCutting type process
// This is used when Foiling machines run DIE/EMB jobs
function isDieCuttingSubProcess() {
    const subProcess = machineInfo.subProcess?.toLowerCase() || '';
    return subProcess.includes('diecutting') || 
           subProcess.includes('die cutting') || 
           subProcess === 'embossing' ||
           subProcess.includes('embossing') ||
           subProcess.includes('striping');
}

// Sheet→carton base-qty logic applies when U_PCode starts with DIE (e.g. DIE, DIE-TOP) or is EMB+P
function isDieProcessCodeForBaseQty(uPCode) {
    const u = String(uPCode || '').toUpperCase();
    return u.startsWith('DIE') || u === 'EMB+P';
}

// Check if the current sub-process requires base quantity division
// Returns true for DieCutting processes where U_PCode starts with DIE or is EMB+P
// This is needed because previous process issues in SHEETS but completion report is in CARTONS
// Also applies to Foiling machines running DieCutting sub-processes
// @param {string} uPCodeOverride - Optional U_PCode to use instead of selectedJob.uPCode
function shouldApplyBaseQuantityDivision(uPCodeOverride) {
    // Check if it's a DieCutting machine OR a Foiling machine running DieCutting sub-process
    const isDieCuttingContext = isDieCuttingMachine() || (isFoilingMachine() && isDieCuttingSubProcess());
    
    if (!isDieCuttingContext) {
        return false;
    }
    
    // Get the U_PCode - use override if provided, otherwise from selectedJob
    const uPCode = (uPCodeOverride || selectedJob?.uPCode || '').toUpperCase();
    
    // For U_PCode starting with DIE or EMB+P, we need to divide by base quantity
    // Because: Previous process issues in SHEETS, but we complete in CARTONS
    // For U_PCode = 'EMB' (embossing only), no division needed (same unit)
    if (isDieProcessCodeForBaseQty(uPCode)) {
        console.log(`📊 Base quantity division ENABLED for U_PCode: ${uPCode}`);
        return true;
    }
    
    // For 'EMB' (embossing only) or other codes, no division
    console.log(`📊 Base quantity division DISABLED for U_PCode: ${uPCode}`);
    return false;
}

// Calculate quantity for SAP for DieCutting machines
// For multiple base quantities: sum of (quantityProcessed / |baseQuantity|) for each
function calculateDieCuttingQuantityForSAP(quantityProcessed, baseQuantities) {
    if (!baseQuantities || !Array.isArray(baseQuantities) || baseQuantities.length === 0) {
        // No base quantities, return original quantity
        return quantityProcessed;
    }
    
    // Sum of (quantityProcessed / |baseQuantity|) for each base quantity
    let totalQuantity = 0;
    for (const bq of baseQuantities) {
        const absBq = Math.abs(bq);
        if (absBq > 0) {
            totalQuantity += quantityProcessed / absBq;
        }
    }
    
    // Round to nearest integer
    return Math.round(totalQuantity);
}

// Check if machine requires process selection (DieCutting, Folding/Pasting, or Foiling)
function requiresProcessSelection() {
    return isDieCuttingMachine() || isFoldingPastingMachine() || isFoilingMachine();
}

// Show process selection reminder popup
function showProcessSelectionReminder() {
    return new Promise((resolve) => {
        if (!requiresProcessSelection()) {
            resolve();
            return;
        }

        // Remove any existing process reminder modal first
        const existingModal = document.getElementById('process-reminder-modal-overlay');
        if (existingModal) {
            existingModal.remove();
        }

        let processType, dropdownId;
        if (isDieCuttingMachine()) {
            processType = 'DieCutting';
            dropdownId = 'diecutting-process-select';
        } else if (isFoilingMachine()) {
            processType = 'Foiling';
            dropdownId = 'foiling-process-select';
        } else {
            processType = 'Folding & Pasting';
            dropdownId = 'folding-process-select';
        }
        const dropdown = document.getElementById(dropdownId);
        const currentProcess = dropdown?.value || 'Not Selected';

        let resolved = false; // Prevent double resolution

        const modalHTML = `
            <div class="modal-overlay active" id="process-reminder-modal-overlay" style="z-index: 10000; position: fixed; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.7);">
                <div class="modal-content" style="max-width: 400px; width: 90%; text-align: center; background: linear-gradient(145deg, rgba(17, 24, 39, 0.98) 0%, rgba(10, 15, 26, 0.99) 100%); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 16px; padding: 0; margin: 20px;">
                    <div class="modal-header" style="border-bottom: none; padding: 20px 20px 0 20px;">
                        <h2 class="modal-title" style="width: 100%; text-align: center; margin: 0; font-size: 1.2rem; color: #fff;">⚠️ Process Selection</h2>
                    </div>
                    <div class="modal-body" style="padding: 20px;">
                        <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 12px; padding: 15px; margin-bottom: 15px;">
                            <p style="margin: 0 0 12px 0; color: #e5e7eb; font-size: 0.95rem;">
                                Please verify the <strong style="color: #3b82f6;">${processType}</strong> process is correctly selected before starting work.
                            </p>
                            <div style="background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px; margin-top: 10px;">
                                <div style="font-size: 0.75rem; color: #9ca3af; margin-bottom: 5px;">Current Selection:</div>
                                <div style="font-size: 1.1rem; font-weight: 600; color: #3b82f6;">${currentProcess}</div>
                            </div>
                        </div>
                        <p style="margin: 0; color: #9ca3af; font-size: 0.8rem;">
                            You can change the process using the dropdown in the header bar.
                        </p>
                        <div style="margin-top: 20px; display: flex; justify-content: center;">
                            <button type="button" id="process-reminder-ok" style="min-width: 140px; padding: 12px 24px; font-size: 1rem; font-weight: 600; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; border: none; border-radius: 8px; cursor: pointer;">
                                ✓ Got It
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        const modal = document.getElementById('process-reminder-modal-overlay');
        const okBtn = document.getElementById('process-reminder-ok');

        const closeModal = () => {
            if (resolved) return;
            resolved = true;
            if (modal) modal.remove();
            resolve();
        };

        if (okBtn) {
            okBtn.onclick = closeModal;
        }

        // Also close on clicking outside
        if (modal) {
            modal.onclick = (e) => {
                if (e.target === modal) {
                    closeModal();
                }
            };
        }
    });
}

// Configure finish modal fields based on machine type
function configureFinishModalFields() {
    const standardFields = document.getElementById('standard-fields');
    const narendraFields = document.getElementById('narendra-fields');
    const foldingRemarks = document.getElementById('folding-remarks');
    const standardRemarks = document.getElementById('standard-remarks');
    
    // Reset all fields
    if (standardFields) standardFields.style.display = 'block';
    if (narendraFields) narendraFields.style.display = 'none';
    if (foldingRemarks) foldingRemarks.style.display = 'none';
    if (standardRemarks) standardRemarks.style.display = 'block';
    
    // Clear required attributes first
    document.getElementById('sheets-processed')?.removeAttribute('required');
    document.getElementById('wasted-sheets')?.removeAttribute('required');
    document.getElementById('sheet-length')?.removeAttribute('required');
    document.getElementById('speed-mpm')?.removeAttribute('required');
    document.getElementById('fold-num-cartons')?.removeAttribute('required');
    
    if (isLaminationMachine()) {
        // Lamination details section removed: keep standard remarks visible
        if (isNarendraMachine()) {
            // Narendra: Show Sheet Length + MPM instead of standard fields
            if (standardFields) standardFields.style.display = 'none';
            if (narendraFields) narendraFields.style.display = 'block';
            
            // Set required for Narendra fields
            document.getElementById('sheets-processed')?.setAttribute('required', 'required');
            document.getElementById('wasted-sheets')?.setAttribute('required', 'required');
        } else {
            // Other lamination machines: Standard sheets (Machine Speed removed), but with lamination remarks
            document.getElementById('sheets-processed')?.setAttribute('required', 'required');
            document.getElementById('wasted-sheets')?.setAttribute('required', 'required');
        }
    } else if (isFoldingPastingMachine()) {
        // Show folding/pasting-specific remarks
        if (foldingRemarks) foldingRemarks.style.display = 'block';
        if (standardRemarks) standardRemarks.style.display = 'none';
        
        // Standard production fields for folding/pasting (Machine Speed removed)
        document.getElementById('sheets-processed')?.setAttribute('required', 'required');
        document.getElementById('wasted-sheets')?.setAttribute('required', 'required');
        // Folding-specific required field
        document.getElementById('fold-num-cartons')?.setAttribute('required', 'required');
    } else {
        // Non-lamination, non-folding: Standard fields
        document.getElementById('sheets-processed')?.setAttribute('required', 'required');
        document.getElementById('wasted-sheets')?.setAttribute('required', 'required');
    }
    
    console.log(`📋 Modal configured for: ${machineInfo.name} (Lamination: ${isLaminationMachine()}, Folding: ${isFoldingPastingMachine()}, Narendra: ${isNarendraMachine()})`);
}

// Finish Job
function showFinishJobModal() {
    if (!selectedJob) {
        alert('Please select a job first');
        return;
    }

    // Use validation module if available
    if (typeof ProductionValidation !== 'undefined') {
        const validationResult = ProductionValidation.validateJobState(selectedJob);
        
        if (validationResult.hasErrors) {
            alert('❌ Cannot finish job:\n\n' + validationResult.getErrorMessages().join('\n'));
            return;
        }
    } else {
        // Fallback validation
        if (!selectedJob.isActive) {
            alert('This job has not been started yet');
            return;
        }
    }

    // Configure modal fields based on machine type
    configureFinishModalFields();

    // Jumbled job: show FG breakdown when PO has multiple outputs
    const sheetsEl = document.getElementById('sheets-processed');
    const sheetsVal = parseInt(sheetsEl?.value, 10) || 0;
    if (typeof JumbledJob !== 'undefined') {
        JumbledJob.refreshJumbledFinishUI(selectedJob, sheetsVal, {
            applyDieDivision: shouldApplyBaseQuantityDivision()
        });
    }
    
    showModal('finish-modal-overlay');
}

/** Recalculate per-FG quantities when sheets processed changes (jumbled jobs). */
function updateJumbledFGQuantities() {
    if (!selectedJob || typeof JumbledJob === 'undefined') return;
    const sheets = parseInt(document.getElementById('sheets-processed')?.value, 10) || 0;
    JumbledJob.refreshJumbledFinishUI(selectedJob, sheets, {
        applyDieDivision: shouldApplyBaseQuantityDivision()
    });
}
window.updateJumbledFGQuantities = updateJumbledFGQuantities;

/** Recalculate jumbled FG breakdown on the final submission (summary) form. */
function updateJumbledSummaryFGQuantities() {
    if (!pendingJobData?.isJumbledJob || typeof JumbledJob === 'undefined') return;
    const sheets = parseInt(document.getElementById('summary-sheets-processed')?.value, 10) || 0;
    pendingJobData.sheetsProcessed = sheets;
    pendingJobData.fgLinesWithQty = JumbledJob.refreshJumbledSummaryFromJob(pendingJobData);
}
window.updateJumbledSummaryFGQuantities = updateJumbledSummaryFGQuantities;

// Store job data temporarily for summary modal
let pendingJobData = null;

// Build lamination remarks string from form fields
function buildLaminationRemarks(formData) {
    // Lamination details section removed from UI.
    // Keep function for backward compatibility with any older cached clients.
    return formData?.get?.('remarks') || '';
}

// Build folding/pasting remarks string from form fields
function buildFoldingRemarks(formData) {
    const parts = [];
    
    const pkd = formData.get('foldPKD');
    const numCartons = formData.get('foldNumCartons');
    const extraRemarks = formData.get('foldExtraRemarks');
    
    if (pkd) parts.push(`PKD: ${pkd}`);
    if (numCartons) parts.push(`Pcs/Carton: ${numCartons}`);
    
    let result = parts.join(' | ');
    
    // Add extra remarks at the end if provided
    if (extraRemarks && extraRemarks.trim()) {
        result = result ? `${result} | Notes: ${extraRemarks.trim()}` : `Notes: ${extraRemarks.trim()}`;
    }
    
    return result;
}

// Get number of cartons from folding form (for SAP U_nopkg field)
function getFoldingNumCartons(formData) {
    return formData.get('foldNumCartons') || '';
}

function handleFinishJob(e) {
    e.preventDefault();

    // Save current state time before finishing
    if (currentMachineState && timerInterval) {
        stateTimers[currentMachineState] = timerSeconds;

        if (selectedJob && selectedJob.timeBreakdown) {
            selectedJob.timeBreakdown[currentMachineState] = timerSeconds;
        }
    }

    const formData = new FormData(e.target);
    
    // Determine values based on machine type
    let sheetsProcessed, wastedSheets, machineSpeed, remarks;
    
    if (isLaminationMachine()) {
        if (isNarendraMachine()) {
            // Narendra: Use standard quantity/wastage fields, plus extra fields appended to remarks
            sheetsProcessed = parseInt(formData.get('sheetsProcessed')) || 0;
            wastedSheets = parseInt(formData.get('wastedSheets')) || 0;
            machineSpeed = 0;

            const nParts = [];
            const nAnilox = formData.get('narAnilox');
            const nRubber = formData.get('narRubberMm');
            const nTunnel = formData.get('narTunnelTemp');
            const nNip = formData.get('narNipTemp');

            if (nAnilox) nParts.push(`Anilox: ${nAnilox}`);
            if (nRubber) nParts.push(`Rubber: ${nRubber}mm`);
            if (nTunnel) nParts.push(`Tunnel Temp: ${nTunnel}`);
            if (nNip) nParts.push(`Nip Temp: ${nNip}`);

            const baseLam = formData.get('remarks') || '';
            const extra = nParts.length ? `Narendra: ${nParts.join(' | ')}` : '';
            remarks = [baseLam, extra].filter(Boolean).join(' || ');
        } else {
            // Other lamination machines: Standard fields
            sheetsProcessed = parseInt(formData.get('sheetsProcessed')) || 0;
            wastedSheets = parseInt(formData.get('wastedSheets')) || 0;
            machineSpeed = 0;
            remarks = formData.get('remarks') || '';
        }
    } else if (isFoldingPastingMachine()) {
        // Folding/Pasting: Standard fields with special remarks
        sheetsProcessed = parseInt(formData.get('sheetsProcessed')) || 0;
        wastedSheets = parseInt(formData.get('wastedSheets')) || 0;
        machineSpeed = 0;
        // Build folding remarks
        remarks = buildFoldingRemarks(formData);
        
        // Validate number of cartons for folding/pasting
        const numCartons = formData.get('foldNumCartons');
        if (!numCartons || parseInt(numCartons) <= 0) {
            alert('❌ Please enter Number of Pcs/Carton');
            return;
        }
    } else {
        // Other machines: Standard fields
        sheetsProcessed = parseInt(formData.get('sheetsProcessed')) || 0;
        wastedSheets = parseInt(formData.get('wastedSheets')) || 0;
        machineSpeed = 0;
        remarks = formData.get('remarks') || '';
    }

    // Add makeready type to remarks if available
    if (selectedJob && selectedJob.makereadyType) {
        const makereadyTypeText = selectedJob.makereadyType === 'new' ? 'New Makeready' : 'Repeat Makeready';
        remarks = remarks ? `${makereadyTypeText} | ${remarks}` : makereadyTypeText;
    }
    
    // Add shift end time to remarks if finishing during shift changeover window
    if (isShiftChangeoverTime()) {
        const currentShiftType = getCurrentShift();
        const shiftEndTime = currentShiftType === 'day' ? '8:00 PM' : '9:00 AM';
        remarks = remarks ? `${remarks} | Shift End: ${shiftEndTime}` : `Shift End: ${shiftEndTime}`;
    }
    
    // Add pending shift end time from previous shift changeover (if any)
    if (pendingShiftEndTime) {
        const prevShiftEndText = `Previous Shift End: ${pendingShiftEndTime.time}`;
        remarks = remarks ? `${prevShiftEndText} | ${remarks}` : prevShiftEndText;
        // Clear the pending shift end time after using it
        pendingShiftEndTime = null;
    }

    // Validate form data using validation module (skip for Narendra as it has different fields)
    if (!isNarendraMachine() && typeof ProductionValidation !== 'undefined') {
        const validationResult = ProductionValidation.validateFinishJobForm({
            sheetsProcessed: sheetsProcessed,
            wastedSheets: wastedSheets,
            machineSpeed: machineSpeed
        }, {
            plannedQuantity: selectedJob.plannedQuantity || 0,
            timeBreakdown: selectedJob.timeBreakdown || {}
        });

        if (validationResult.hasErrors) {
            alert('❌ Validation Errors:\n\n' + validationResult.getErrorMessages().join('\n'));
            return;
        }

        if (validationResult.hasWarnings) {
            if (!confirm('⚠️ Warnings:\n\n' + validationResult.getWarningMessages().join('\n') + '\n\nDo you want to continue?')) {
                return;
            }
        }
    }
    
    // Validate Narendra-specific fields (now quantity-based)
    if (isNarendraMachine()) {
        if (sheetsProcessed <= 0) {
            alert('❌ Please enter Quantity Processed');
            return;
        }
        if (wastedSheets < 0) {
            alert('❌ Please enter valid Wastage');
            return;
        }
    }

    // ========== QUANTITY VALIDATION AGAINST REMAINING ==========
    // Check that quantity processed doesn't exceed (issuedQuantity - completedQuantity)
    // For DieCutting (DIE/EMB+P), we need to:
    // 1. Convert issued quantity from sheets to cartons
    // 2. Calculate the final SAP quantity (sheets → cartons)
    // 3. Compare both in cartons
    
    const rawIssuedQtyForValidation = selectedJob.issuedQuantity || 0;
    // Wity: skip remaining/issue validations, only require IssuedQty > 0 for report completion.
    if (machineInfo.name === 'wity') {
        if (rawIssuedQtyForValidation <= 0) {
            alert('❌ Issued Quantity is 0 in SAP.\n\nPlease issue at least some quantity before report completion.');
            return;
        }
        // Skip remainingQty vs qtyProcessed validation for Wity.
    }

    let issuedQty = rawIssuedQtyForValidation;
    const completedQty = selectedJob.completedQuantity || 0;  // Already in cartons from SAP
    const baseQuantities = selectedJob.baseQuantities || [];
    const uPCode = (selectedJob.uPCode || '').toUpperCase();
    const plannedPositive = (selectedJob.plannedQuantity || 0) > 0;
    
    // Check if this job needs base quantity division (U_PCode starts with DIE, or EMB+P), only when planned qty > 0
    const needsDivision = plannedPositive &&
                          isDieProcessCodeForBaseQty(uPCode) &&
                          baseQuantities.length > 0;
    
    // For DIE/EMB+P jobs, convert issued quantity from sheets to cartons
    if (needsDivision && issuedQty > 0) {
        const totalBaseQty = baseQuantities.reduce((sum, bq) => sum + Math.abs(bq), 0);
        if (totalBaseQty > 0) {
            const originalIssued = issuedQty;
            issuedQty = Math.round(issuedQty / totalBaseQty * baseQuantities.length);
            console.log(`📊 Validation: Issued ${originalIssued} sheets → ${issuedQty} cartons (U_PCode: ${uPCode})`);
        }
    }
    
    const remainingQty = issuedQty - completedQty;
    
    // Calculate what the final SAP quantity will be (in cartons for DIE/EMB+P)
    let finalSAPQuantity = sheetsProcessed;
    
    if (shouldApplyBaseQuantityDivision() && baseQuantities.length > 0) {
        finalSAPQuantity = calculateDieCuttingQuantityForSAP(sheetsProcessed, baseQuantities);
        console.log(`📊 Quantity validation - DieCutting calculation: ${sheetsProcessed} sheets → ${finalSAPQuantity} cartons`);
    }

    // Jumbled (multi-output) job validation
    const isJumbled = typeof JumbledJob !== 'undefined' && JumbledJob.isJumbledJobFromData(selectedJob);
    let fgLinesWithQty = [];
    if (isJumbled) {
        const applyDie = shouldApplyBaseQuantityDivision();
        fgLinesWithQty = JumbledJob.calculateFgLinesQuantities(
            sheetsProcessed,
            JumbledJob.getFgLinesFromJob(selectedJob),
            { applyDieDivision: applyDie, baseQuantities }
        );
        const mainFgLine = fgLinesWithQty.find((l) => l && l.isByProduct !== true) || fgLinesWithQty[0];
        const jumbledValidation = JumbledJob.validateJumbledCompletion(sheetsProcessed, fgLinesWithQty, {
            applyDieDivision: applyDie,
            baseQuantities,
            issuedQuantity: rawIssuedQtyForValidation,
            completedQuantity: completedQty,
            skipRemainingCheck: machineInfo.name === 'wity',
            headerCompletionQty: mainFgLine?.quantity ?? finalSAPQuantity
        });
        if (!jumbledValidation.valid) {
            alert('❌ ' + jumbledValidation.message);
            return;
        }
        console.log('🧩 Jumbled FG quantities:', fgLinesWithQty.map((l) => `${l.itemNo}=${l.quantity}`).join(', '));
    }
    
    console.log(`📊 Quantity validation: IssuedQty=${issuedQty} (cartons), CompletedQty=${completedQty}, RemainingQty=${remainingQty}, FinalSAPQty=${finalSAPQuantity}`);
    
    // Only validate if we have issued quantity data (> 0) — skip for jumbled (validated above) and Wity
    // Wity: explicitly skips this remaining validation
    if (!isJumbled && machineInfo.name !== 'wity' && issuedQty > 0 && finalSAPQuantity > remainingQty) {
        const isDieCutting = shouldApplyBaseQuantityDivision() && baseQuantities.length > 0;
        let errorMsg = `❌ Quantity Exceeds Remaining!\n\n`;
        
        if (isDieCutting) {
            errorMsg += `Issued Quantity: ${issuedQty} cartons\n`;
            errorMsg += `Already Completed: ${completedQty} cartons\n`;
            errorMsg += `Remaining to Complete: ${remainingQty} cartons\n\n`;
            errorMsg += `Your Entry: ${sheetsProcessed} sheets\n`;
            errorMsg += `After UPs Calculation: ${finalSAPQuantity} cartons\n`;
            errorMsg += `(U_PCode: ${uPCode} - Sheets ÷ BaseQty = Cartons)\n\n`;
            errorMsg += `The calculated quantity (${finalSAPQuantity}) exceeds the remaining quantity (${remainingQty}).\n`;
            errorMsg += `Please reduce the sheets processed.`;
        } else {
            errorMsg += `Issued Quantity: ${issuedQty}\n`;
            errorMsg += `Already Completed: ${completedQty}\n`;
            errorMsg += `Remaining to Complete: ${remainingQty}\n\n`;
            errorMsg += `Your Entry: ${sheetsProcessed}\n\n`;
            errorMsg += `The quantity processed (${sheetsProcessed}) exceeds the remaining quantity (${remainingQty}).\n`;
            errorMsg += `Please reduce the quantity.`;
        }
        
        alert(errorMsg);
        return;
    }

    // Store job data for summary modal
    pendingJobData = {
        jobNumber: selectedJob.jobNumber,
        jobName: selectedJob.jobName,
        itemNo: selectedJob.itemNo || '',
        plannedQuantity: selectedJob.plannedQuantity || 0,
        completedQuantity: selectedJob.completedQuantity || 0,  // Already completed before this batch
        issuedQuantity: selectedJob.issuedQuantity || 0,        // Total issued quantity
        sheetsProcessed: sheetsProcessed,
        wastedSheets: wastedSheets,
        machineSpeed: machineSpeed,
        remarks: remarks,
        // Special flags for machine types
        isLamination: isLaminationMachine(),
        isNarendra: isNarendraMachine(),
        isFoldingPasting: isFoldingPastingMachine(),
        isDieCutting: isDieCuttingMachine() || (isFoilingMachine() && isDieCuttingSubProcess()),
        isFoiling: isFoilingMachine(),
        // Base quantities for DieCutting calculation
        baseQuantities: selectedJob.baseQuantities || [],
        // U_PCode for determining if base quantity division is needed (DIE, EMB+P need division)
        uPCode: selectedJob.uPCode || '',
        // Use the actual job start time captured when Make Ready/Running was first clicked
        jobStartTime: selectedJob.jobStartTime || getISTTimestamp(),
        completedAt: getISTTimestamp(),  // Use IST for completion time
        shift: getCurrentShift(),
        // SAP posting fields
        absoluteEntry: selectedJob.absoluteEntry || null,  // SAP AbsoluteEntry
        uJobEnt: selectedJob.uJobEnt ?? null,
        poNumber: selectedJob.poNumber || selectedJob.jobNumber,
        packingDetails: '',  // Will be populated from form if folding/pasting
        // LAM material codes (captured at Running state, issued at job finish)
        lamMaterialCodes: selectedJob.lamMaterialCodes || null,
        // Jumbled (multi-output) job
        isJumbledJob: isJumbled,
        applyDieDivision: shouldApplyBaseQuantityDivision(),
        fgLines: selectedJob.fgLines || [],
        fgLinesWithQty: isJumbled ? fgLinesWithQty : [],
        timeBreakdown: selectedJob.timeBreakdown ? { ...selectedJob.timeBreakdown } : {
            makeready: stateTimers.makeready || 0,
            running: stateTimers.running || 0,
            lunch: stateTimers.lunch || 0,
            cleaning: stateTimers.cleaning || 0,
            waiting_qc: stateTimers.waiting_qc || 0,
            waiting_die: stateTimers.waiting_die || 0,
            waiting_input: stateTimers.waiting_input || 0,
            line_clearance: stateTimers.line_clearance || 0,
            downtime_elec: stateTimers.downtime_elec || 0,
            downtime_mech: stateTimers.downtime_mech || 0,
            downtime: stateTimers.downtime || 0,
            idle: stateTimers.idle || 0
        }
    };
    
    // Extract packing details and number of cartons from folding form if applicable
    if (isFoldingPastingMachine()) {
        // Get number of cartons directly from form for SAP U_nopkg field
        const numCartons = formData.get('foldNumCartons');
        if (numCartons) {
            pendingJobData.packingDetails = numCartons;  // U_nopkg = number of pieces per carton
        }
    }

    console.log('📋 Job data prepared for summary:', pendingJobData);

    // Close finish modal and show summary modal
    closeModal('finish-modal-overlay');
    e.target.reset();

    // Show job summary modal for review
    showJobSummaryModal(pendingJobData);
}

// Helper functions for time conversion
function timeStringToSeconds(timeString) {
    const parts = timeString.split(':');
    if (parts.length !== 3) return 0;
    const hours = parseInt(parts[0]) || 0;
    const minutes = parseInt(parts[1]) || 0;
    const seconds = parseInt(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
}

function secondsToTimeString(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Show job summary modal
function showJobSummaryModal(data) {
    // Ensure timeBreakdown exists
    const timeBreakdown = data.timeBreakdown || {};

    // Get values with defaults
    const makereadyTime = timeBreakdown.makeready || 0;
    const runningTime = timeBreakdown.running || 0;

    // Calculate total session time
    const totalSessionTime = Object.values(timeBreakdown).reduce((a, b) => a + b, 0);

    console.log('📊 Summary Modal - Time Breakdown:', {
        makeready: makereadyTime,
        running: runningTime,
        total: totalSessionTime,
        fullBreakdown: timeBreakdown
    });

    // Update summary display
    const summaryJobNumber = document.getElementById('summary-job-number');
    if (summaryJobNumber) {
        summaryJobNumber.textContent = data.jobNumber;
    }

    // Populate time fields (editable)
    const makereadyInput = document.getElementById('summary-makeready-time');
    if (makereadyInput) {
        makereadyInput.value = secondsToTimeString(makereadyTime);
    }

    const runningInput = document.getElementById('summary-running-time');
    if (runningInput) {
        runningInput.value = secondsToTimeString(runningTime);
    }

    const totalTimeEl = document.getElementById('summary-job-total-time');
    if (totalTimeEl) {
        totalTimeEl.textContent = formatTime(totalSessionTime);
    }

    // Configure labels based on machine type (Narendra vs others)
    const sheetsLabel = document.getElementById('summary-sheets-label');
    const wastedGroup = document.getElementById('summary-wasted-group');
    
    if (data.isNarendra) {
        // Narendra: Sheet Length + MPM
        if (sheetsLabel) sheetsLabel.textContent = 'Sheet Length (meters) *';
        if (wastedGroup) wastedGroup.style.display = 'none';
    } else if (data.isFoldingPasting) {
        // Folding/Pasting: Quantity + cartons/hour
        if (sheetsLabel) sheetsLabel.textContent = 'Quantity Processed *';
        if (wastedGroup) wastedGroup.style.display = 'block';
    } else {
        // Standard: Sheets Processed + sheets/hour
        if (sheetsLabel) sheetsLabel.textContent = 'Quantity Processed *';
        if (wastedGroup) wastedGroup.style.display = 'block';
    }

    // Populate form fields
    const sheetsProcessedEl = document.getElementById('summary-sheets-processed');
    if (sheetsProcessedEl) {
        sheetsProcessedEl.value = data.sheetsProcessed;
    }

    const wastedSheetsEl = document.getElementById('summary-wasted-sheets');
    if (wastedSheetsEl) {
        wastedSheetsEl.value = data.wastedSheets;
    }

    const remarksEl = document.getElementById('summary-remarks');
    if (remarksEl) {
        remarksEl.value = data.remarks || '';
    }

    // Populate and show/hide Packing Details field (only for Folding/Pasting)
    const packingGroup = document.getElementById('summary-packing-group');
    const packingDetailsEl = document.getElementById('summary-packing-details');
    if (data.isFoldingPasting) {
        if (packingGroup) packingGroup.style.display = 'block';
        if (packingDetailsEl) {
            packingDetailsEl.value = data.packingDetails || '';
        }
    } else {
        if (packingGroup) packingGroup.style.display = 'none';
    }

    if (typeof JumbledJob !== 'undefined' && data.isJumbledJob) {
        data.fgLinesWithQty = JumbledJob.refreshJumbledSummaryFromJob(data);
    } else if (typeof JumbledJob !== 'undefined') {
        JumbledJob.refreshJumbledSummaryUI([]);
    }

    // Make fields DISABLED by default - only editable after clicking Edit button
    // MakeReady and Running time are NOT editable (read-only)
    const editableFields = [
        'summary-sheets-processed',
        'summary-wasted-sheets',
        'summary-remarks',
        'summary-packing-details'
    ];

    editableFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.disabled = true;
        }
    });

    // Update total time when time fields change
    const updateTotalTime = () => {
        const makereadyTime = timeStringToSeconds(document.getElementById('summary-makeready-time').value);
        const runningTime = timeStringToSeconds(document.getElementById('summary-running-time').value);
        // Include other states
        let otherTime = 0;
        for (const [state, time] of Object.entries(timeBreakdown)) {
            if (state !== 'makeready' && state !== 'running') {
                otherTime += time || 0;
            }
        }
        const newTotal = makereadyTime + runningTime + otherTime;
        const totalEl = document.getElementById('summary-job-total-time');
        if (totalEl) {
            totalEl.textContent = formatTime(newTotal);
        }
    };

    // Add listeners for time inputs
    if (makereadyInput) {
        makereadyInput.removeEventListener('input', updateTotalTime);
        makereadyInput.addEventListener('input', updateTotalTime);
    }
    if (runningInput) {
        runningInput.removeEventListener('input', updateTotalTime);
        runningInput.addEventListener('input', updateTotalTime);
    }

    // Show modal
    showModal('job-summary-modal-overlay');
}

// Confirm job finish
function confirmJobFinish() {
    if (!pendingJobData) {
        console.error('No pending job data');
        return;
    }

    // Get form values
    const makereadyTimeInput = document.getElementById('summary-makeready-time').value;
    const runningTimeInput = document.getElementById('summary-running-time').value;
    const sheetsProcessedInput = document.getElementById('summary-sheets-processed').value;
    const wastedSheetsInput = document.getElementById('summary-wasted-sheets').value;
    const machineSpeedInput = '0';

    // Use validation module if available
    if (typeof ProductionValidation !== 'undefined') {
        const validationResult = ProductionValidation.validateJobSummaryForm({
            makereadyTime: makereadyTimeInput,
            runningTime: runningTimeInput,
            sheetsProcessed: sheetsProcessedInput,
            wastedSheets: wastedSheetsInput,
            machineSpeed: machineSpeedInput
        }, {
            plannedQuantity: selectedJob?.plannedQuantity || pendingJobData.plannedQuantity || 0
        });

        if (validationResult.hasErrors) {
            alert('❌ Validation Errors:\n\n' + validationResult.getErrorMessages().join('\n'));
            return;
        }

        if (validationResult.hasWarnings) {
            if (!confirm('⚠️ Warnings:\n\n' + validationResult.getWarningMessages().join('\n') + '\n\nDo you want to continue?')) {
                return;
            }
        }
    } else {
        // Fallback validation - time format only
        const timePattern = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
        if (!timePattern.test(makereadyTimeInput)) {
            alert('Please enter Make Ready time in HH:MM:SS format (e.g., 01:30:45)');
            return;
        }
        if (!timePattern.test(runningTimeInput)) {
            alert('Please enter Running time in HH:MM:SS format (e.g., 02:15:30)');
            return;
        }
    }

    // Convert time strings to seconds
    const makereadySeconds = timeStringToSeconds(makereadyTimeInput);
    const runningSeconds = timeStringToSeconds(runningTimeInput);

    // Update data from form
    pendingJobData.sheetsProcessed = parseInt(document.getElementById('summary-sheets-processed').value);
    pendingJobData.wastedSheets = parseInt(document.getElementById('summary-wasted-sheets').value);
    pendingJobData.machineSpeed = 0;
    pendingJobData.remarks = document.getElementById('summary-remarks').value;

    if (pendingJobData.isJumbledJob && typeof JumbledJob !== 'undefined') {
        const applyDie = pendingJobData.applyDieDivision ?? shouldApplyBaseQuantityDivision(pendingJobData.uPCode);
        pendingJobData.fgLinesWithQty = JumbledJob.calculateFgLinesQuantities(
            pendingJobData.sheetsProcessed,
            JumbledJob.getFgLinesFromJob(pendingJobData),
            {
                applyDieDivision: applyDie,
                baseQuantities: pendingJobData.baseQuantities || []
            }
        );
        JumbledJob.refreshJumbledSummaryUI(pendingJobData.fgLinesWithQty);
    }
    
    // Update packing details if folding/pasting machine
    const packingDetailsInput = document.getElementById('summary-packing-details');
    if (packingDetailsInput && packingDetailsInput.value) {
        pendingJobData.packingDetails = packingDetailsInput.value;
    }

    // Update time breakdown with edited values
    pendingJobData.timeBreakdown.makeready = makereadySeconds;
    pendingJobData.timeBreakdown.running = runningSeconds;

    // Add to completed jobs (session + persisted list for summary)
    completedJobs.push(pendingJobData);
    sessionCompletedJobs.push(pendingJobData);
    saveShiftSessionToStorage();

    // Remove from current jobs
    currentJobs = currentJobs.filter(job => job.jobNumber !== pendingJobData.jobNumber);

    // Clear active job tracking
    activeJobNumber = null;
    activeJobState = null;
    selectedJob = null;

    // Live tracking: job finished -> clear loaded job (machine returns to idle)
    if (typeof LiveTracking !== 'undefined') {
        LiveTracking.jobUnload();
    }
    
    // Re-enable PO input after job is finished
    updatePOInputState();

    // DON'T reset makeready and running - they persist across jobs until shift change
    // Only reset other state timers
    // Note: We're NOT resetting these timers, so they continue from where they left off
    // stateTimers.lunch = 0;
    // stateTimers.cleaning = 0;
    // etc...
    // These will continue accumulating across multiple jobs within the same shift

    // Reset current state and timer display
    currentMachineState = null;
    timerSeconds = 0;
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    console.log('✅ Job finished. Timers preserved for shift:', {
        makeready: formatTime(stateTimers.makeready),
        running: formatTime(stateTimers.running)
    });

    // Update UI
    renderJobQueue(currentJobs);
    updateTimerDisplay();
    updateFooterStats();

    // Clear job details display
    const jobNumberEl = document.getElementById('selected-job-number');
    if (jobNumberEl) jobNumberEl.textContent = '--';

    const jobNameEl = document.getElementById('selected-job-name');
    if (jobNameEl) jobNameEl.textContent = 'Select a job from "Search PO"';

    const itemNoEl = document.getElementById('selected-job-itemno');
    if (itemNoEl) itemNoEl.textContent = '-';

    const quantityEl = document.getElementById('selected-job-quantity');
    if (quantityEl) quantityEl.textContent = '-';

    const statusEl = document.getElementById('selected-job-status');
    if (statusEl) statusEl.textContent = 'No Job Selected';

    const stateLabel = document.getElementById('current-state-label');
    if (stateLabel) stateLabel.textContent = 'Select a job to start tracking';

    // Remove active state from all buttons
    document.querySelectorAll('.control-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Close both modals
    closeModal('job-summary-modal-overlay');
    closeModal('finish-modal-overlay');

    // Clear pending data
    const completedJob = pendingJobData;
    pendingJobData = null;
    currentJobId = null;
    
    // Clear timestamp tracking
    stateStartTimestamp = null;
    accumulatedStateTime = 0;

    // Keep operator on screen and in storage until clock out
    const operatorForJob = getOperatorForSubmission();
    persistShiftOperator();
    
    // Save updated state to localStorage (includes operator + shiftLoginAt)
    saveStateToStorage();
    updateShiftFooterDisplay();
    updateClockButtonUI();

    // Save job completion to database
    completeJobInDatabase(completedJob, makereadySeconds, runningSeconds, operatorForJob);

    alert(`✅ Job ${completedJob.jobNumber} completed successfully!\n\nQuantity Processed: ${completedJob.sheetsProcessed}\nWasted: ${completedJob.wastedSheets}`);

    console.log('Job confirmed and finished:', completedJob);
}

// Save completed job to database with all activities
async function completeJobInDatabase(jobData, makereadySeconds, runningSeconds, operatorOverride) {
    try {
        console.log('💾 Attempting to save job to database...', jobData.jobNumber);

        // Quick timeout check
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

        // Prepare job data with correct IST timestamps
        // job_start_time: When operator first clicked Make Ready or Running
        // job_end_time: When operator clicked final Submit button (now)
        const jobEndTime = getISTTimestamp();
        
        console.log(`📊 Saving job with times:`);
        console.log(`   Start Time (IST): ${jobData.jobStartTime}`);
        console.log(`   End Time (IST): ${jobEndTime}`);
        
        // Calculate quantity for SAP posting
        // For DieCutting machines (except embossing only), divide by base quantities
        let quantityForSAP = jobData.sheetsProcessed || 0;
        const baseQuantities = jobData.baseQuantities || [];
        const jobUPCode = jobData.uPCode || '';
        
        if (shouldApplyBaseQuantityDivision(jobUPCode) && baseQuantities.length > 0) {
            quantityForSAP = calculateDieCuttingQuantityForSAP(jobData.sheetsProcessed, baseQuantities);
            console.log(`📊 DieCutting (U_PCode: ${jobUPCode}): ${jobData.sheetsProcessed} sheets ÷ baseQuantities ${JSON.stringify(baseQuantities)} = ${quantityForSAP} cartons for SAP`);
        }

        // Operator stays logged in for the whole shift — capture at submit time
        let operatorToSend = operatorOverride || getOperatorForSubmission();
        if (!operatorToSend) {
            console.warn('⚠️ No operator found at job submit — job will save with Unknown');
        }

        // Debug: Log operator before sending
        console.log('👤 Current Operator at submission:', operatorToSend);
        console.log('   operatorSelectedForShift:', operatorSelectedForShift);
        
        const jobInfo = {
            po_num: jobData.poNumber || jobData.jobNumber,
            fg_num: jobData.itemNo || '',
            job_name: jobData.jobName || '',
            operator_name: operatorToSend || 'Unknown',
            shift_type: getCurrentShift(),
            machine_name: machineInfo.name || 'Unknown',
            process_name: machineInfo.subProcess || formatProcessName(machineInfo.process) || 'Unknown',
            planned_qty: jobData.plannedQuantity || 0,
            job_start_time: jobData.jobStartTime,  // Actual start time when job began
            job_end_time: jobEndTime,               // Current time when submitting
            quantity_processed: jobData.sheetsProcessed || 0,  // Original quantity for local DB
            quantity_for_sap: quantityForSAP,                  // Adjusted quantity for SAP (with UPs)
            sheets_wasted: jobData.wastedSheets || 0,
            remark: jobData.remarks || '',
            device_id: getDeviceId(),
            // SAP posting fields
            absolute_entry: jobData.absoluteEntry || null,  // SAP AbsoluteEntry for InventoryGenEntries
            packing_details: jobData.packingDetails || '',   // Packing details (U_nopkg)
            u_job_ent: jobData.uJobEnt ?? null,
            u_p_code: jobData.uPCode || '',
            // LAM material codes for proportional issue at job finish
            lam_material_codes: jobData.lamMaterialCodes || null,
            // Jumbled (multi-output) production order
            is_jumbled_job: !!(jobData.isJumbledJob && jobData.fgLinesWithQty?.length > 1),
            fg_lines: (jobData.isJumbledJob && jobData.fgLinesWithQty?.length > 1 && typeof JumbledJob !== 'undefined')
                ? JumbledJob.buildFgLinesPayload(jobData.fgLinesWithQty)
                : null
        };
        
        // Debug: Log SAP posting fields
        console.log('📤 Sending to backend - SAP fields:');
        console.log('   absolute_entry:', jobInfo.absolute_entry);
        console.log('   packing_details:', jobInfo.packing_details);
        
        // Debug: Log LAM material codes if present
        if (jobInfo.lam_material_codes) {
            console.log('📤 LAM Material Codes for issue:');
            console.log('   Film:', jobInfo.lam_material_codes.film);
            console.log('   Adhesive:', jobInfo.lam_material_codes.adhesive);
            console.log('   Planned Qty:', jobInfo.lam_material_codes.plannedQty);
            console.log('   Actual Qty:', jobInfo.quantity_processed);
        }

        // Prepare activities array from timeBreakdown
        const activities = [];
        const timeBreakdown = jobData.timeBreakdown || {};

        // Add each activity that has time > 0
        if (timeBreakdown.makeready > 0) {
            activities.push({
                activity_name: 'makeready',
                activity_time_minutes: timeBreakdown.makeready / 60
            });
        }
        if (timeBreakdown.running > 0) {
            activities.push({
                activity_name: 'running',
                activity_time_minutes: timeBreakdown.running / 60
            });
        }
        if (timeBreakdown.lunch > 0) {
            activities.push({
                activity_name: 'lunch',
                activity_time_minutes: timeBreakdown.lunch / 60
            });
        }
        if (timeBreakdown.cleaning > 0) {
            activities.push({
                activity_name: 'cleaning',
                activity_time_minutes: timeBreakdown.cleaning / 60
            });
        }
        if (timeBreakdown.waiting_qc > 0) {
            activities.push({
                activity_name: 'waiting_qc',
                activity_time_minutes: timeBreakdown.waiting_qc / 60
            });
        }
        if (timeBreakdown.waiting_die > 0) {
            activities.push({
                activity_name: 'waiting_die',
                activity_time_minutes: timeBreakdown.waiting_die / 60
            });
        }
        if (timeBreakdown.waiting_input > 0) {
            activities.push({
                activity_name: 'waiting_input',
                activity_time_minutes: timeBreakdown.waiting_input / 60
            });
        }
        if (timeBreakdown.line_clearance > 0) {
            activities.push({
                activity_name: 'line_clearance',
                activity_time_minutes: timeBreakdown.line_clearance / 60
            });
        }
        if (timeBreakdown.downtime_elec > 0) {
            activities.push({
                activity_name: 'downtime_elec',
                activity_time_minutes: timeBreakdown.downtime_elec / 60
            });
        }
        if (timeBreakdown.downtime_mech > 0) {
            activities.push({
                activity_name: 'downtime_mech',
                activity_time_minutes: timeBreakdown.downtime_mech / 60
            });
        }

        if (activities.length === 0) {
            console.warn('⚠️ No activities to save for job:', jobData.jobNumber);
            return;
        }

        console.log('📊 Activities to save:', activities);

        // Send to backend API
        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/job-complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jobData: jobInfo,
                activities: activities
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (result.success) {
            console.log('✅ Job saved to database successfully!');
            console.log('📦 Batch Number:', result.batch_num);
            console.log('📝 Activities saved:', result.inserted);
            
            // Log SAP posting status
            console.log('📤 SAP Posting Status:', result.sapPosted ? '✅ SUCCESS' : '❌ NOT POSTED');
            if (result.sapError) {
                console.error('📤 SAP Error:', result.sapError);
            }
            if (result.sapDetails) {
                console.error('📤 SAP Error Details:', result.sapDetails);
            }
            
            // Log and display auto-issue results
            if (result.autoIssue) {
                if (result.autoIssue.isJumbledJob) {
                    console.log('📤 Jumbled Job Auto-Issue Results:');
                    console.log(`   Total FG Items: ${result.autoIssue.totalFGItems}`);
                    console.log(`   Successful Issues: ${result.autoIssue.successfulIssues}`);
                    if (result.autoIssue.results) {
                        result.autoIssue.results.forEach(r => {
                            console.log(`   ${r.success ? '✅' : '❌'} ${r.fgItemCode}: ${r.success ? `Issued ${r.totalIssued} to ${r.targetProcess} PO ${r.targetPO}` : r.error}`);
                        });
                    }
                    // Display results in UI
                    if (typeof JumbledJob !== 'undefined') {
                        JumbledJob.displayJumbledJobResults(result.autoIssue);
                    }
                } else {
                    console.log('📤 Auto-Issue Status:', result.autoIssue.success ? '✅ SUCCESS' : '❌ FAILED');
                    if (result.autoIssue.success) {
                        console.log(`   Issued ${result.autoIssue.totalIssued} to ${result.autoIssue.targetProcess} PO ${result.autoIssue.targetPO}`);
                    } else if (result.autoIssue.error) {
                        console.log(`   Error: ${result.autoIssue.error}`);
                    }
                }
            }
            
            // Log LAM material issue results (Film & Adhesive)
            if (result.lamIssue) {
                console.log('📦 LAM Material Issue Status:', result.lamIssue.success ? '✅ SUCCESS' : '⚠️ PARTIAL/FAILED');
                if (result.lamIssue.film) {
                    if (result.lamIssue.film.success) {
                        console.log(`   Film: ✅ Issued ${result.lamIssue.film.quantity} of ${result.lamIssue.film.itemCode}`);
                    } else if (result.lamIssue.film.skipped) {
                        console.log(`   Film: ⏭️ Skipped (${result.lamIssue.film.reason})`);
                    } else {
                        console.log(`   Film: ❌ Failed - ${result.lamIssue.film.error}`);
                    }
                }
                if (result.lamIssue.adhesive) {
                    if (result.lamIssue.adhesive.success) {
                        console.log(`   Adhesive: ✅ Issued ${result.lamIssue.adhesive.quantity} of ${result.lamIssue.adhesive.itemCode}`);
                    } else if (result.lamIssue.adhesive.skipped) {
                        console.log(`   Adhesive: ⏭️ Skipped (${result.lamIssue.adhesive.reason})`);
                    } else {
                        console.log(`   Adhesive: ❌ Failed - ${result.lamIssue.adhesive.error}`);
                    }
                }
                if (result.lamIssue.errors && result.lamIssue.errors.length > 0) {
                    console.log('   Errors:', result.lamIssue.errors.join(', '));
                }
            }

            // Store batch number in completed job for reference
            jobData.batchNum = result.batch_num;
        } else {
            console.error('❌ Failed to save job:', result.error);
        }

    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('⚠️ Database save timed out - continuing without database');
        } else {
            console.error('❌ Error saving job to database:', error);
            console.error('Error details:', error.message);
        }
        // Don't block the UI - job is still completed locally via localStorage
    }
}

// Get device ID (unique identifier for this device/browser)
function getDeviceId() {
    let deviceId = localStorage.getItem('device_id');
    if (!deviceId) {
        deviceId = 'DEV-' + Math.random().toString(36).substr(2, 9).toUpperCase();
        localStorage.setItem('device_id', deviceId);
    }
    return deviceId;
}

// Cancel Job
function showCancelJobModal() {
    if (!selectedJob) {
        alert('Please select a job first');
        return;
    }

    showModal('cancel-modal-overlay');
}

function handleCancelJob(e) {
    e.preventDefault();

    const formData = new FormData(e.target);
    const cancelReason = formData.get('cancelReason');

    // Validate cancel reason using validation module
    if (typeof ProductionValidation !== 'undefined') {
        const validationResult = ProductionValidation.validateCancelReason(cancelReason);
        
        if (validationResult.hasErrors) {
            alert('❌ ' + validationResult.getErrorMessages().join('\n'));
            return;
        }
    } else {
        // Fallback validation
        if (!cancelReason || cancelReason.trim() === '') {
            alert('Please provide a reason for cancellation');
            return;
        }
    }

    const data = {
        jobNumber: selectedJob.jobNumber,
        jobName: selectedJob.jobName,
        cancelReason: cancelReason,
        jobStartTime: selectedJob.jobStartTime,  // When job actually started
        cancelledAt: getISTTimestamp(),          // Current IST time
        timeSpent: { ...stateTimers }
    };

    // Add to cancelled jobs
    cancelledJobs.push(data);
    sessionCancelledJobs.push(data);
    saveShiftSessionToStorage();

    // Save cancellation to database
    if (currentJobId) {
        cancelJobInDatabase(currentJobId);
    }

    // Remove from current jobs
    currentJobs = currentJobs.filter(job => job.jobNumber !== selectedJob.jobNumber);

    // Clear active job tracking if this was the active job
    if (activeJobNumber === selectedJob.jobNumber) {
        activeJobNumber = null;
        activeJobState = null;
        
        // Re-enable PO input after job is cancelled
        updatePOInputState();
    }

    // Don't reset timers - they should persist until shift change
    // Only clear the current state
    currentMachineState = null;
    timerSeconds = 0;
    currentJobId = null; // Clear database job ID
    stateStartTimestamp = null; // Clear timestamp tracking
    accumulatedStateTime = 0;
    
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    // Update UI
    updateTimerDisplay();

    // Update UI
    renderJobQueue(currentJobs);
    clearSelection();
    closeModal('cancel-modal-overlay');
    e.target.reset();
    
    // Save updated state to localStorage
    saveStateToStorage();

    alert(`Job ${data.jobNumber} has been cancelled.\n\nReason: ${data.cancelReason}`);

    console.log('Job cancelled:', data);
}

// Shift Summary — current clock-in session (header Summary or Clock out)
function showShiftSummary(options = {}) {
    const endAt = options.endAt || Date.now();
    const summaryOperator = options.operatorName || currentOperator;
    const currentShift = getCurrentShift();

    // Set date and shift name
    const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    document.getElementById('summary-date').textContent = `${today} - ${getShiftName(currentShift)}`;

    const operatorLineEl = document.getElementById('summary-operator-line');
    if (operatorLineEl) {
        if (summaryOperator && shiftLoginAt) {
            const loginStr = new Date(shiftLoginAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const logoutStr = new Date(endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            operatorLineEl.textContent = `Operator: ${summaryOperator} · ${loginStr} – ${logoutStr}`;
            operatorLineEl.style.display = 'block';
        } else {
            operatorLineEl.style.display = 'none';
        }
    }

    // Session duration = time since clock-in (footer shift timer)
    const totalShiftTime = shiftLoginAt
        ? Math.max(0, Math.floor((endAt - shiftLoginAt) / 1000))
        : 0;

    // State times accumulated during this clock-in session
    const shiftTimes = {
        running: stateTimers.running || 0,
        makeready: stateTimers.makeready || 0,
        lunch: stateTimers.lunch || 0,
        cleaning: stateTimers.cleaning || 0,
        waiting_qc: stateTimers.waiting_qc || 0,
        waiting_die: stateTimers.waiting_die || 0,
        waiting_input: stateTimers.waiting_input || 0,
        line_clearance: stateTimers.line_clearance || 0,
        downtime_elec: stateTimers.downtime_elec || 0,
        downtime_mech: stateTimers.downtime_mech || 0,
        downtime: stateTimers.downtime || 0
    };

    const totalWaitingTime = shiftTimes.waiting_qc + shiftTimes.waiting_die +
        shiftTimes.waiting_input + shiftTimes.line_clearance;

    const totalDowntime = shiftTimes.downtime + shiftTimes.downtime_elec + shiftTimes.downtime_mech;

    const totalStateTime = Object.values(shiftTimes).reduce((a, b) => a + b, 0);

    const idleTime = Math.max(0, totalShiftTime - totalStateTime);

    // Update UI - show individual times
    const runningEl = document.getElementById('summary-running-time');
    if (runningEl) {
        runningEl.textContent = formatTime(shiftTimes.running);
    }

    const makereadyEl = document.getElementById('summary-makeready-time');
    if (makereadyEl) {
        makereadyEl.textContent = formatTime(shiftTimes.makeready);
    }

    const idleEl = document.getElementById('summary-idle-time');
    if (idleEl) {
        idleEl.textContent = formatTime(idleTime);
    }

    const lunchEl = document.getElementById('summary-lunch-time');
    if (lunchEl) {
        lunchEl.textContent = formatTime(shiftTimes.lunch);
    }

    const waitingEl = document.getElementById('summary-waiting-time');
    if (waitingEl) {
        waitingEl.textContent = formatTime(totalWaitingTime);
    }

    const downtimeEl = document.getElementById('summary-downtime-time');
    if (downtimeEl) {
        downtimeEl.textContent = formatTime(totalDowntime);
    }

    const totalEl = document.getElementById('summary-total-time');
    if (totalEl) {
        totalEl.textContent = formatTime(totalShiftTime);
    }

    console.log('📊 Shift Summary:', {
        running: shiftTimes.running,
        makeready: shiftTimes.makeready,
        lunch: shiftTimes.lunch,
        cleaning: shiftTimes.cleaning,
        waiting: totalWaitingTime,
        downtime: totalDowntime,
        idle: idleTime,
        total: totalShiftTime
    });

    // Jobs for this clock-in session only
    const shiftCompletedJobs = sessionCompletedJobs.length
        ? sessionCompletedJobs
        : completedJobs.filter(job => job.shift === currentShift);
    const shiftCancelledJobs = sessionCancelledJobs.length
        ? sessionCancelledJobs
        : cancelledJobs.filter(job => job.shift === currentShift);

    const tableContainer = document.getElementById('jobs-summary-table');
    if (shiftCompletedJobs.length === 0 && shiftCancelledJobs.length === 0) {
        tableContainer.innerHTML = `<div class="empty-summary">No jobs processed during ${getShiftName(currentShift)}</div>`;
    } else {
        let tableHTML = `
            <table class="summary-table">
                <thead>
                    <tr>
                        <th>Job Number</th>
                        <th>Job Name</th>
                        <th>Status</th>
                        <th>Sheets Processed</th>
                        <th>Wasted</th>
                    </tr>
                </thead>
                <tbody>
        `;

        shiftCompletedJobs.forEach(job => {
            tableHTML += `
                <tr>
                    <td>${job.jobNumber}</td>
                    <td>${job.jobName}</td>
                    <td><span class="job-status-badge completed">Completed</span></td>
                    <td>${job.sheetsProcessed ? job.sheetsProcessed.toLocaleString() : '-'}</td>
                    <td>${job.wastedSheets ? job.wastedSheets.toLocaleString() : '-'}</td>
                </tr>
            `;
        });

        shiftCancelledJobs.forEach(job => {
            tableHTML += `
                <tr>
                    <td>${job.jobNumber}</td>
                    <td>${job.jobName}</td>
                    <td><span class="job-status-badge cancelled">Cancelled</span></td>
                    <td>-</td>
                    <td>-</td>
                </tr>
            `;
        });

        tableHTML += '</tbody></table>';
        tableContainer.innerHTML = tableHTML;
    }

    showModal('summary-modal-overlay');
}

// Clear selection
function clearSelection() {
    selectedJob = null;
    currentMachineState = null;

    document.querySelectorAll('.job-card').forEach(card => {
        card.classList.remove('active');
    });

    document.querySelectorAll('.control-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Don't reset state timers - they should persist until shift change
    // Only reset the current timer display
    timerSeconds = 0;
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    updateTimerDisplay();
    updateFooterStats();
}

// Keyboard shortcuts
document.addEventListener('keydown', function (e) {
    if (e.key === 's' || e.key === 'S') {
        if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            e.preventDefault();
            document.getElementById('job-search-input').focus();
        }
    }

    if (e.key === 'Escape') {
        // Close any open modals
        document.querySelectorAll('.modal-overlay.active').forEach(modal => {
            closeModal(modal.id);
        });
    }
});

// Pull-to-refresh is allowed naturally by the browser
// Only pulling down from the top of the page will trigger refresh
// Pulling from the middle of the page will just scroll normally

// Cleanup
window.addEventListener('beforeunload', function () {
    if (timerInterval) {
        clearInterval(timerInterval);
    }
});
