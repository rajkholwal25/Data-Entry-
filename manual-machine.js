// Manual Machine - Simplified Production Tracking
// For manual machines: MDC1, MDC2, MDC3, MDC4, MF
// For lamination machines: YILEE, Yong Shun, Narendra, Wity

// ==================== Configuration ====================
const API_CONFIG = {
    BASE_URL: `${window.location.protocol}//${window.location.host}/api`,
    ENDPOINTS: {
        productionOrder: (docNum) => `/production-order/${docNum}`,
        itemBatchManaged: (itemCode) => `/item-batch-managed/${encodeURIComponent(itemCode)}`,
        itemUom: (itemCode) => `/item-uom/${encodeURIComponent(itemCode)}`,
        releaseProductionOrder: '/release-production-order',
        jobComplete: '/job-complete',
        bestPerformance: (fgNum) => `/best-performance/${fgNum}`,
        breakdownTicket: '/appsheet/breakdown-ticket'
    }
};

/** SAP Inventory UoM for an item (issue popups). */
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

// HTML escaping helper for any modal innerHTML usage
function escapeHtml(input) {
    const s = String(input ?? '');
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Backwards-compat alias (some older code may call EscapeHTML)
const EscapeHTML = escapeHtml;

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

// Machine categories
const MACHINE_CATEGORIES = {
    'manual': ['manual-mdc-1', 'manual-mdc-2', 'manual-mdc-3', 'manual-mdc-4', 'manual-mf'],
    'lamination': ['yilee', 'yong-shun', 'narendra', 'wity'],
    'spot-uv': ['spotuv-sakurai', 'spotuv-horda', 'spotuv-apr'],
    'rigid': ['rigid-emmeci-1', 'rigid-emmeci-2', 'rigid-fuchu', 'rigid-assembly']
};

// Machine display names
const MACHINE_NAMES = {
    // Manual machines
    'manual-mdc-1': 'MDC 1',
    'manual-mdc-2': 'MDC 2',
    'manual-mdc-3': 'MDC 3',
    'manual-mdc-4': 'MDC 4',
    'manual-mf': 'MF (Foiling)',
    // Lamination machines
    'yilee': 'YILEE',
    'yong-shun': 'Yong Shun',
    'narendra': 'Narendra',
    'wity': 'Wity',
    // Spot-UV machines
    'spotuv-sakurai': 'Sakurai',
    'spotuv-horda': 'Horda',
    'spotuv-apr': 'APR',
    // RIGID machines
    'rigid-emmeci-1': 'Emmeci-1',
    'rigid-emmeci-2': 'Emmeci-2',
    'rigid-fuchu': 'Fuchu',
    'rigid-assembly': 'Assembly'
};

// Machine process mapping
const MACHINE_PROCESS = {
    // Manual machines
    'manual-mdc-1': 'die-cutting-embossing',
    'manual-mdc-2': 'die-cutting-embossing',
    'manual-mdc-3': 'die-cutting-embossing',
    'manual-mdc-4': 'die-cutting-embossing',
    'manual-mf': 'foiling',
    // Lamination machines
    'yilee': 'lamination',
    'yong-shun': 'lamination',
    'narendra': 'lamination',
    'wity': 'lamination',
    // Spot-UV machines
    'spotuv-sakurai': 'spot-uv',
    'spotuv-horda': 'spot-uv',
    'spotuv-apr': 'spot-uv',
    // RIGID machines
    'rigid-emmeci-1': 'rigid',
    'rigid-emmeci-2': 'rigid',
    'rigid-fuchu': 'rigid',
    'rigid-assembly': 'rigid'
};

// Operator lists by machine
const OPERATOR_LISTS = {
    // Manual machines
    'manual-mdc-1': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    'manual-mdc-2': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    'manual-mdc-3': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    'manual-mdc-4': ['Ram Milan', 'Arun Kumar', 'Hari Sankar', 'Surender Tiwari', 'Sarvesh', 'Ashok', 'Vicky', 'Rajesh', 'Amit'],
    'manual-mf': ['Sachin', 'Khodas', 'Kunal', 'Arvind', 'Ashok'],
    // Lamination machines
    'yilee': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],
    'yong-shun': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],
    'narendra': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],
    'wity': ['Sandeep', 'Ganesh', 'Raju', 'Krishna', 'Parimal', 'Pardeep', 'Akash'],
    // Spot UV machines (Sakurai, Horda, APR)
    'spotuv-sakurai': ['Ashish Thakur', 'Gourav Pal', 'Sunil', 'Arjun'],
    'spotuv-horda': ['Ashish Thakur', 'Gourav Pal', 'Sunil', 'Arjun'],
    'spotuv-apr': ['Ashish Thakur', 'Gourav Pal', 'Sunil', 'Arjun'],
    // RIGID (Emmeci / Fuchu)
    'rigid-emmeci-1': ['Nirmal Joshi', 'Dipesh', 'Shivam', 'Bhudev', 'Mahesh', 'Naveen'],
    'rigid-emmeci-2': ['Nirmal Joshi', 'Dipesh', 'Shivam', 'Bhudev', 'Mahesh', 'Naveen'],
    'rigid-fuchu': ['Nirmal Joshi', 'Dipesh', 'Shivam', 'Bhudev', 'Mahesh', 'Naveen']
};

function isRigidMachine() {
    return getMachineCategory(currentMachine) === 'rigid';
}

function isAssemblyMachine() {
    return currentMachine === 'rigid-assembly';
}

function getEffectiveUPCodeForMachine() {
    if (isAssemblyMachine()) return 'ASS';
    if (isRigidMachine()) return 'MKG';
    return (currentJob?.rawData?.uPCode ?? currentJob?.uPCode ?? null);
}

function setAssemblyWorkflowVisible(visible) {
    const el = document.getElementById('assembly-workflow-section');
    if (!el) return;
    el.style.display = visible ? 'block' : 'none';
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function clearAssemblyForm() {
    const op = document.getElementById('assembly-operator-name');
    const st = document.getElementById('assembly-start-time');
    const et = document.getElementById('assembly-end-time');
    const sp = document.getElementById('assembly-sheets-processed');
    const ws = document.getElementById('assembly-wasted-sheets');
    const rm = document.getElementById('assembly-finish-remarks');
    if (op) op.value = '';
    if (st) st.value = '';
    if (et) et.value = '';
    if (sp) sp.value = '';
    if (ws) ws.value = '';
    if (rm) rm.value = '';
}

function formatTimePickerValue(timestamp = Date.now()) {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function setDefaultAssemblyTimes() {
    const startEl = document.getElementById('assembly-start-time');
    const endEl = document.getElementById('assembly-end-time');
    const now = Date.now();
    if (startEl && !startEl.value) startEl.value = formatTimePickerValue(jobStartTimestamp || now);
    if (endEl && !endEl.value) endEl.value = formatTimePickerValue(now);
}

function getAssemblyTimestampRange() {
    const startValue = document.getElementById('assembly-start-time')?.value || '';
    const endValue = document.getElementById('assembly-end-time')?.value || '';

    if (!startValue && !endValue) {
        const now = Date.now();
        const startTimestamp = jobStartTimestamp || now;
        const durationSeconds = Math.max(60, Math.round((now - startTimestamp) / 1000));
        return {
            startTimestamp,
            endTimestamp: now,
            durationSeconds
        };
    }

    if (!startValue || !endValue) {
        throw new Error('Please select both start time and end time, or leave both blank');
    }

    const [startHour, startMinute] = startValue.split(':').map(Number);
    const [endHour, endMinute] = endValue.split(':').map(Number);
    if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) {
        throw new Error('Please enter valid start time and end time');
    }

    const base = new Date();
    const startDate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), startHour, startMinute, 0, 0);
    const endDate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), endHour, endMinute, 0, 0);
    if (endDate.getTime() < startDate.getTime()) {
        endDate.setDate(endDate.getDate() + 1);
    }

    const durationSeconds = Math.max(60, Math.round((endDate.getTime() - startDate.getTime()) / 1000));
    return {
        startTimestamp: startDate.getTime(),
        endTimestamp: endDate.getTime(),
        durationSeconds
    };
}

/** Copy inline Assembly output fields into the hidden finish-modal inputs so handleFinishSubmit can stay single-path. */
function syncAssemblyFieldsToFinishForm() {
    const aSp = document.getElementById('assembly-sheets-processed');
    const aWs = document.getElementById('assembly-wasted-sheets');
    const aRm = document.getElementById('assembly-finish-remarks');
    const mSp = document.getElementById('sheets-processed');
    const mWs = document.getElementById('wasted-sheets');
    const mRm = document.getElementById('finish-remarks');
    if (mSp && aSp) mSp.value = aSp.value;
    if (mWs && aWs) mWs.value = aWs.value;
    if (mRm && aRm) mRm.value = aRm.value;
}

function handleAssemblyContinue() {
    if (!currentJob) {
        showToast('No job loaded', 'error');
        return;
    }
    if (currentJob._materialIssuePending) {
        showToast('Please issue pending material before reporting completion', 'error');
        return;
    }
    const op = document.getElementById('assembly-operator-name')?.value?.trim() || '';
    if (!op) {
        showToast('Please enter operator name', 'error');
        return;
    }
    let timeRange;
    try {
        timeRange = getAssemblyTimestampRange();
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    currentOperator = op;
    jobStartTimestamp = timeRange.startTimestamp;
    stateStartTimestamp = null;
    currentState = null;
    stateTimers = {
        running: timeRange.durationSeconds,
        downtime_mech: 0,
        downtime_elec: 0,
        lunch: 0
    };
    saveStateToStorage();

    syncAssemblyFieldsToFinishForm();
    handleFinishSubmit({ preventDefault() {} });
    if (pendingJobData) {
        pendingJobData.assemblyStartTimestamp = timeRange.startTimestamp;
        pendingJobData.assemblyEndTimestamp = timeRange.endTimestamp;
    }
}

// ==================== Global State ====================
let currentMachine = null;
let currentJob = null;
let currentState = null;
let currentOperator = null;
let shiftLoginAt = null; // Timestamp (ms) when operator logged in for the shift
let stateStartTimestamp = null;
let timerInterval = null;
let jobStartTimestamp = null; // Track when the job actually started

// State timers
let stateTimers = {
    running: 0,
    downtime_mech: 0,
    downtime_elec: 0,
    lunch: 0
};

// Pending job data for submission
let pendingJobData = null;
let breakdownType = 'downtime_mech';

// Lamination-specific data
let laminationData = {};

// Storage key
const STORAGE_KEY_BASE = 'vkglobal_manual_machine';

// Reset Memory PIN (same as data-entry.js)
const RESET_MEMORY_PIN = '8686';

// ==================== Helper Functions ====================
function getMachineCategory(machine) {
    if (MACHINE_CATEGORIES.manual.includes(machine)) return 'manual';
    if (MACHINE_CATEGORIES.lamination.includes(machine)) return 'lamination';
    if (MACHINE_CATEGORIES['spot-uv'].includes(machine)) return 'spot-uv';
    if (MACHINE_CATEGORIES.rigid && MACHINE_CATEGORIES.rigid.includes(machine)) return 'rigid';
    return 'manual';
}

/** Machine id for API payloads (must match data-entry `machineInfo.name` / server MACHINE_TO_RES_CODE keys). */
function getMachineIdForApi() {
    return currentMachine || '';
}

/** Human-readable label for UI only. */
function getMachineDisplayName() {
    return MACHINE_NAMES[currentMachine] || currentMachine || 'Unknown';
}

function isLaminationMachine() {
    return getMachineCategory(currentMachine) === 'lamination';
}

function isNarendraMachine() {
    return currentMachine === 'narendra';
}

function isWityMachine() {
    return currentMachine === 'wity';
}

function isSpotUVAprMachine() {
    return currentMachine === 'spotuv-apr';
}

// ==================== Spot-UV APR Tape Batch Issue (Foil-style) ====================
async function showAPRTapeBatchIssueDialog(tapeMaterial, absoluteEntry, documentNumber) {
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
                overscroll-behavior: contain;
                touch-action: none;
                padding: 16px;
            `;

            const modal = document.createElement('div');
            modal.style.cssText = `
                background: white;
                border-radius: 16px;
                width: 100%;
                max-width: 760px;
                max-height: 90vh;
                overflow: hidden;
                box-shadow: 0 25px 50px -12px rgba(0,0,0,0.45);
                display: flex;
                flex-direction: column;
            `;

            const TAPE_WAREHOUSE = (tapeMaterial?.warehouse || 'II-FOI');
            const originalItemNo = tapeMaterial?.itemNo || '';
            const plannedQty = Number(tapeMaterial?.plannedQuantity ?? 0) || 0;
            const lineNumber = Number(tapeMaterial?.lineNumber ?? 0) || 0;

            const totalCount = Number(tapeMaterial?._totalCount || 0) || 0;
            const currentIndex = Number(tapeMaterial?._currentIndex || 0) || 0;
            const progressText = totalCount > 1 ? ` (${currentIndex} of ${totalCount})` : '';

            modal.innerHTML = `
                <div style="background: linear-gradient(135deg, #0f766e 0%, #115e59 100%); padding: 18px 20px; color: white; flex-shrink: 0;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                        <div>
                            <div style="font-size: 16px; font-weight: 800; margin: 0;">APR Material Issue${progressText}</div>
                            <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">Select batch(es) and quantity to issue</div>
                        </div>
                        <div style="font-size: 12px; opacity: 0.95; text-align:right;">
                            PO: <span style="font-weight:800;">${documentNumber || ''}</span><br/>
                            Planned: <span style="font-weight:800;">${plannedQty.toLocaleString()}</span>
                        </div>
                    </div>
                </div>

                <div id="apr-tape-content" style="padding: 14px 16px; overflow-y: auto; flex: 1;">
                    <div style="background:#f1f5f9; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom: 12px;">
                        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                            <div style="font-size: 12px; color:#475569; font-weight:700;">ITEM</div>
                            <div style="font-family: monospace; font-weight:800; font-size: 14px; color:#1f2937;">${originalItemNo}</div>
                            <div style="margin-left:auto; font-size: 11px; color:#64748b;">Line: ${lineNumber} • Warehouse: ${TAPE_WAREHOUSE}</div>
                        </div>
                        <div style="font-size: 11px; color:#64748b; margin-top: 6px;">${tapeMaterial?.itemName || ''}</div>
                        <div style="font-size: 11px; color:#475569; margin-top: 6px;">Inventory UoM: <span id="apr-tape-uom" style="font-weight: 800; color:#0f172a;">—</span></div>
                    </div>

                    <div style="display:flex; gap:10px; align-items:center; margin-bottom: 10px;">
                        <input id="apr-tape-search" type="text" placeholder="Search batch no / width..."
                            style="flex:1; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 13px;" />
                        <button id="apr-tape-clear" style="padding: 10px 14px; border-radius: 10px; background: white; border: 1px solid #e2e8f0; cursor:pointer; font-size: 13px; font-weight:700; color:#64748b;">
                            Clear
                        </button>
                    </div>

                    <div id="apr-tape-loading" style="display:none; padding: 18px; text-align:center; color:#64748b; font-weight:700;">Loading batches...</div>
                    <div id="apr-tape-empty" style="display:none; padding: 18px; text-align:center;">
                        <div style="font-weight:800; color:#0f172a;">No batches available</div>
                        <div style="font-size: 12px; color:#64748b; margin-top:4px;">Checking stock in ${TAPE_WAREHOUSE}...</div>
                        <div id="apr-nonbatch-issue" style="display:none; margin-top: 14px; padding: 14px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; text-align:left;">
                            <div style="font-size: 12px; font-weight: 800; color:#0f172a;">Non-batch item issue</div>
                            <div style="font-size: 12px; color:#64748b; margin-top:4px;">
                                Available: <span id="apr-nonbatch-available" style="font-weight:900; color:#0f766e;">0</span>
                            </div>
                            <div style="display:flex; gap:10px; align-items:center; margin-top: 10px; flex-wrap: wrap;">
                                <input id="apr-nonbatch-qty" type="number" min="1" placeholder="Qty to issue"
                                    style="flex:1; min-width: 160px; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 14px; font-weight: 800; text-align:center;" />
                                <button id="apr-nonbatch-issue-btn"
                                    style="padding: 10px 14px; border-radius: 10px; background: #0f766e; border: none; cursor:pointer; font-size: 13px; font-weight:900; color:white;">
                                    Issue
                                </button>
                            </div>
                            <div style="font-size: 11px; color:#64748b; margin-top: 8px;">
                                This item has stock but no batches (not batch-managed). You can issue directly.
                            </div>
                        </div>
                    </div>

                    <table id="apr-tape-table" style="width:100%; border-collapse: collapse; display:none;">
                        <thead>
                            <tr style="background:#f8fafc; border:1px solid #e2e8f0;">
                                <th style="padding: 10px 8px; width:44px; text-align:center; font-size:12px; color:#475569;">Sel</th>
                                <th style="padding: 10px 8px; text-align:left; font-size:12px; color:#475569;">Batch</th>
                                <th style="padding: 10px 8px; text-align:left; font-size:12px; color:#475569;">Grade</th>
                                <th style="padding: 10px 8px; text-align:right; font-size:12px; color:#475569;">Len</th>
                                <th style="padding: 10px 8px; text-align:right; font-size:12px; color:#475569;">Wid</th>
                                <th style="padding: 10px 8px; text-align:right; font-size:12px; color:#475569;">Avail</th>
                                <th style="padding: 10px 8px; width:110px; text-align:center; font-size:12px; color:#475569;">Issue Qty</th>
                            </tr>
                        </thead>
                        <tbody id="apr-tape-tbody"></tbody>
                    </table>

                    <div style="margin-top: 12px; padding: 12px; border:1px solid #e2e8f0; border-radius:10px; background:#f8fafc; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
                        <div>
                            <span style="font-size: 12px; color:#64748b;">Total issue:</span>
                            <span id="apr-tape-total-issue" style="font-size: 16px; font-weight: 900; margin-left: 8px; color:#64748b;">0</span>
                        </div>
                        <div>
                            <span style="font-size: 12px; color:#64748b;">Total available:</span>
                            <span id="apr-tape-total-available" style="font-size: 16px; font-weight: 900; margin-left: 8px; color:#0f766e;">0</span>
                        </div>
                    </div>
                </div>

                <div style="padding: 14px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0; display:flex; gap:10px; justify-content:flex-end; flex-shrink: 0;">
                    <button id="apr-tape-cancel" style="padding: 10px 18px; background: white; color: #64748b; border: 1px solid #e2e8f0; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 800;">
                        Cancel
                    </button>
                    <button id="apr-tape-issue" style="padding: 10px 20px; background: #0f766e; color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 900;">
                        Issue Material
                    </button>
                </div>
            `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            const aprTapeUomEl = modal.querySelector('#apr-tape-uom');
            fetchItemInventoryUOM(originalItemNo).then((u) => {
                if (aprTapeUomEl) aprTapeUomEl.textContent = u || '—';
            });

            const contentDiv = modal.querySelector('#apr-tape-content');
            const searchInput = modal.querySelector('#apr-tape-search');
            const clearBtn = modal.querySelector('#apr-tape-clear');
            const loadingDiv = modal.querySelector('#apr-tape-loading');
            const emptyDiv = modal.querySelector('#apr-tape-empty');
            const table = modal.querySelector('#apr-tape-table');
            const tbody = modal.querySelector('#apr-tape-tbody');
            const totalIssueSpan = modal.querySelector('#apr-tape-total-issue');
            const totalAvailableSpan = modal.querySelector('#apr-tape-total-available');
            const cancelBtn = modal.querySelector('#apr-tape-cancel');
            const issueBtn = modal.querySelector('#apr-tape-issue');

            let allBatches = [];
            let filteredBatches = [];
            const itemCodeToFetch = originalItemNo;

            if (contentDiv) {
                let startY = 0;
                contentDiv.addEventListener('touchstart', (e) => { startY = e.touches[0].pageY; }, { passive: true });
                contentDiv.addEventListener('touchmove', (e) => {
                    const currentY = e.touches[0].pageY;
                    const scrollTop = contentDiv.scrollTop;
                    if (scrollTop <= 0 && currentY > startY) e.preventDefault();
                }, { passive: false });
            }
            overlay.addEventListener('touchmove', (e) => {
                if (contentDiv && !contentDiv.contains(e.target)) e.preventDefault();
            }, { passive: false });

            function cleanup() {
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }

            function updateTotals() {
                let total = 0;
                tbody.querySelectorAll('.batch-qty-input').forEach(input => {
                    total += (parseFloat(input.value) || 0);
                });
                totalIssueSpan.textContent = total.toFixed(0);
                totalIssueSpan.style.color = total > 0 ? '#16a34a' : '#64748b';
            }

            function renderBatches(batches) {
                const dimLen = (b) => {
                    const n = Number(b.length ?? b.Length ?? b.u_length ?? b.U_Length ?? b.U_LENGTH);
                    return Number.isFinite(n) ? n : 0;
                };
                const dimWid = (b) => {
                    const n = Number(b.width ?? b.Width ?? b.u_width ?? b.U_Width ?? b.U_WIDTH);
                    return Number.isFinite(n) ? n : 0;
                };
                const gradeOf = (b) => {
                    const g = b.grade ?? b.Grade ?? b.U_GRADE;
                    return (g != null && String(g).trim() !== '') ? String(g) : 'N/A';
                };
                tbody.innerHTML = '';
                batches.forEach((batch, idx) => {
                    const row = document.createElement('tr');
                    row.style.cssText = 'border-bottom: 1px solid #f1f5f9;';
                    row.innerHTML = `
                        <td style="padding: 8px; text-align: center;">
                            <input type="checkbox" class="batch-checkbox" data-idx="${idx}" style="width: 18px; height: 18px; cursor: pointer;">
                        </td>
                        <td style="padding: 8px; font-size: 14px; font-weight: 800; font-family: monospace; color: #1e293b;">${batch.batchNumber}</td>
                        <td style="padding: 8px; font-size: 13px; color: #374151; font-weight: 600;">${gradeOf(batch)}</td>
                        <td style="padding: 8px; font-size: 13px; text-align: right; color: #374151;">${dimLen(batch)}</td>
                        <td style="padding: 8px; font-size: 13px; text-align: right; color: #374151;">${dimWid(batch)}</td>
                        <td style="padding: 8px; font-size: 14px; text-align: right; font-weight: 900; color: #0f766e;">${batch.available || 0}</td>
                        <td style="padding: 8px; text-align: center;">
                            <input type="number" class="batch-qty-input" data-idx="${idx}" data-batch="${batch.batchNumber}"
                                data-available="${batch.available}" value="" min="0" max="${batch.available}" step="1"
                                style="width: 86px; padding: 6px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; text-align: center; font-weight: 800;"
                                disabled>
                        </td>
                    `;
                    tbody.appendChild(row);
                });

                tbody.querySelectorAll('.batch-checkbox').forEach(cb => {
                    cb.addEventListener('change', (e) => {
                        const idx = e.target.dataset.idx;
                        const qtyInput = tbody.querySelector(`.batch-qty-input[data-idx="${idx}"]`);
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

                tbody.querySelectorAll('.batch-qty-input').forEach(input => {
                    input.addEventListener('input', () => {
                        const max = parseFloat(input.dataset.available) || 0;
                        const val = parseFloat(input.value) || 0;
                        if (val > max) input.value = max;
                        if (val < 0) input.value = 0;
                        updateTotals();
                    });
                });
            }

            async function fetchBatches() {
                loadingDiv.style.display = 'block';
                table.style.display = 'none';
                emptyDiv.style.display = 'none';

                try {
                    const resp = await fetch(`${API_CONFIG.BASE_URL}/rmc-batches/${encodeURIComponent(itemCodeToFetch)}?warehouse=${encodeURIComponent(TAPE_WAREHOUSE)}`);
                    const result = await resp.json();
                    if (result.success && Array.isArray(result.batches) && result.batches.length > 0) {
                        allBatches = result.batches;
                        filteredBatches = [...allBatches];
                        totalAvailableSpan.textContent = result.totalAvailable || 0;

                        loadingDiv.style.display = 'none';
                        table.style.display = 'table';
                        renderBatches(filteredBatches);
                    } else {
                        loadingDiv.style.display = 'none';
                        emptyDiv.style.display = 'block';
                        allBatches = [];
                        filteredBatches = [];
                        totalAvailableSpan.textContent = '0';

                        // Fallback for non-batch items: show item availability + allow direct issue
                        try {
                            const availResp = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.itemAvailability(itemCodeToFetch)}?warehouse=${encodeURIComponent(TAPE_WAREHOUSE)}`);
                            const availResult = await availResp.json();
                            const availableQty = Number(availResult?.availableQuantity ?? 0) || 0;

                            const msgLine = emptyDiv.querySelector('div:nth-child(2)');
                            if (msgLine) msgLine.textContent = `Available in ${TAPE_WAREHOUSE}: ${availableQty}`;

                            const nonBatchWrap = modal.querySelector('#apr-nonbatch-issue');
                            const nonBatchAvail = modal.querySelector('#apr-nonbatch-available');
                            const nonBatchQty = modal.querySelector('#apr-nonbatch-qty');
                            const nonBatchBtn = modal.querySelector('#apr-nonbatch-issue-btn');

                            if (nonBatchAvail) nonBatchAvail.textContent = availableQty.toLocaleString();
                            if (nonBatchQty && plannedQty > 0) nonBatchQty.value = String(plannedQty);

                            if (nonBatchWrap && nonBatchBtn && nonBatchQty) {
                                if (availableQty > 0) {
                                    nonBatchWrap.style.display = 'block';
                                    nonBatchBtn.onclick = async () => {
                                        const qty = Math.floor(Number(nonBatchQty.value) || 0);
                                        if (qty <= 0) return alert('Enter valid quantity');
                                        if (qty > availableQty) return alert(`Qty exceeds available (${availableQty})`);

                                        nonBatchBtn.disabled = true;
                                        nonBatchBtn.textContent = 'Issuing...';
                                        try {
                                            const { resp: issueResp, json: issueJson } = await fetchJsonWithAutoRelease(
                                                `${API_CONFIG.BASE_URL}/issue-material`,
                                                {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({
                                                        absoluteEntry,
                                                        documentNumber,
                                                        itemCode: itemCodeToFetch,
                                                        quantity: qty,
                                                        warehouse: TAPE_WAREHOUSE,
                                                        lineNumber,
                                                        remarks: `Material issued via Manual Machine (APR)`
                                                    })
                                                },
                                                { absoluteEntry, documentNumber }
                                            );
                                            if (!issueResp.ok || !issueJson.success) throw new Error(issueJson.message || issueJson.error || 'Failed to issue');
                                            cleanup();
                                            resolve({ success: true, message: 'Material issued successfully', totalIssued: qty });
                                        } catch (e) {
                                            alert(`Error issuing material:\n${e.message}`);
                                            nonBatchBtn.disabled = false;
                                            nonBatchBtn.textContent = 'Issue';
                                        }
                                    };
                                } else {
                                    nonBatchWrap.style.display = 'none';
                                }
                            }
                        } catch (e) {
                            // ignore fallback errors; keep "no batches" message
                        }
                    }
                } catch (err) {
                    console.error('Error fetching tape batches:', err);
                    loadingDiv.style.display = 'none';
                    emptyDiv.style.display = 'block';
                    emptyDiv.querySelector('div:first-child').textContent = 'Error loading batches';
                    emptyDiv.querySelector('div:last-child').textContent = err.message;
                }
            }

            await fetchBatches();

            searchInput.addEventListener('input', () => {
                const query = (searchInput.value || '').toLowerCase().trim();
                if (!query) filteredBatches = [...allBatches];
                else {
                    filteredBatches = allBatches.filter(b =>
                        (b.batchNumber && b.batchNumber.toLowerCase().includes(query)) ||
                        (b.width && b.width.toString().includes(query))
                    );
                }
                renderBatches(filteredBatches);
            });

            clearBtn.addEventListener('click', () => {
                tbody.querySelectorAll('.batch-checkbox').forEach((cb) => { cb.checked = false; });
                tbody.querySelectorAll('.batch-qty-input').forEach((inp) => { inp.disabled = true; inp.value = ''; });
                updateTotals();
            });

            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve({ success: false, message: 'Tape issue cancelled by user' });
            });

            issueBtn.addEventListener('click', async () => {
                const batchAllocations = [];
                tbody.querySelectorAll('.batch-qty-input').forEach(input => {
                    if (!input.disabled) {
                        const qty = parseFloat(input.value) || 0;
                        if (qty > 0) batchAllocations.push({ batchNumber: input.dataset.batch, quantity: qty });
                    }
                });

                if (batchAllocations.length === 0) {
                    alert('Please select at least one batch and enter quantity to issue');
                    return;
                }

                issueBtn.disabled = true;
                issueBtn.textContent = 'Issuing...';

                try {
                    const { resp, json: result } = await fetchJsonWithAutoRelease(
                        `${API_CONFIG.BASE_URL}/issue-rmc-batches`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                absoluteEntry,
                                documentNumber,
                                itemCode: itemCodeToFetch,
                                lineNumber,
                                batchAllocations,
                                targetWarehouse: TAPE_WAREHOUSE,
                                remarks: `Material issued via Manual Machine (APR) - ${batchAllocations.length} batch(es)`
                            })
                        },
                        { absoluteEntry, documentNumber }
                    );
                    if (!resp.ok || !result.success) throw new Error(result.message || result.error || 'Failed to issue tape');
                    cleanup();
                    resolve({ success: true, message: 'Tape issued successfully', totalIssued: result.totalQuantity || null });
                } catch (err) {
                    alert(`Error issuing tape:\n${err.message}`);
                    issueBtn.disabled = false;
                    issueBtn.textContent = 'Issue Material';
                }
            });

            if (searchInput) searchInput.focus();
        } catch (err) {
            console.error('Error in showAPRTapeBatchIssueDialog:', err);
            resolve({ success: false, message: err.message || 'Failed to show tape issue dialog' });
        }
    });
}

function shouldApplyBaseQuantityDivisionForManualJob(job) {
    const uPCode = (job?.uPCode || job?.rawData?.uPCode || '').toUpperCase();
    const baseQuantities = job?.baseQuantities || job?.rawData?.baseQuantities || [];
    const plannedPositive = (job?.plannedQuantity || job?.rawData?.plannedQuantity || 0) > 0;
    return plannedPositive &&
        (uPCode.startsWith('DIE') || uPCode === 'EMB+P') &&
        Array.isArray(baseQuantities) && baseQuantities.length > 0;
}

function convertIssuedSheetsToCartons(issuedSheets, baseQuantities) {
    const issued = Number(issuedSheets) || 0;
    if (issued <= 0) return 0;
    if (!Array.isArray(baseQuantities) || baseQuantities.length === 0) return Math.round(issued);

    const totalBaseQty = baseQuantities.reduce((sum, bq) => sum + Math.abs(Number(bq) || 0), 0);
    if (totalBaseQty <= 0) return Math.round(issued);

    // Same conversion used in data-entry.js validation:
    // issuedCartons ~= issuedSheets / totalBaseQty * numberOfFGBaseQtyLines
    return Math.round((issued / totalBaseQty) * baseQuantities.length);
}

function calculateDieCuttingQuantityForSAPManual(quantityProcessedSheets, baseQuantities) {
    const qty = Number(quantityProcessedSheets) || 0;
    if (!Array.isArray(baseQuantities) || baseQuantities.length === 0) return Math.round(qty);

    // Same logic as data-entry.js:
    // For multiple base quantities: sum(qty / |baseQuantity|) and round to nearest integer.
    let total = 0;
    for (const bq of baseQuantities) {
        const absBq = Math.abs(Number(bq) || 0);
        if (absBq > 0) total += qty / absBq;
    }
    return Math.round(total);
}

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', () => {
    initializeMachine();
    setupEventListeners();
    loadStateFromStorage();
    startTimer();
    // Capture operator ONCE per shift when the machine page is opened.
    ensureOperatorForShift();
});

function initializeMachine() {
    const urlParams = new URLSearchParams(window.location.search);
    currentMachine = urlParams.get('machine') || 'manual-mdc-1';
    
    // Determine machine category
    const category = getMachineCategory(currentMachine);
    
    // Update header
    const machineName = MACHINE_NAMES[currentMachine] || currentMachine;
    document.getElementById('current-machine-name').textContent = machineName;
    
    // Update machine icon based on category
    const machineIcon = document.querySelector('.machine-badge .machine-icon');
    if (machineIcon) {
        if (category === 'lamination') machineIcon.textContent = '📋';
        else if (category === 'rigid') machineIcon.textContent = isAssemblyMachine() ? '🧩' : '🧱';
        else machineIcon.textContent = '⚙️';
    }
    
    // Update page title (match lamination: process + machine context)
    if (category === 'lamination') {
        document.title = 'Lamination Machine - Production Tracking';
    } else if (category === 'rigid') {
        document.title = isAssemblyMachine()
            ? 'Assembly - RIGID Production Tracking'
            : `${machineName} - RIGID Production Tracking`;
    } else {
        document.title = 'Manual Machine - Production Tracking';
    }
    
    // Update navigation based on category
    updateNavigationForCategory(category);
    
    // Show/hide lamination-specific fields
    updateLaminationFields();
    
    console.log(`🔧 Initialized machine: ${currentMachine} (${category})`);

    // Live tracking: tell the server which machine this terminal is.
    if (typeof LiveTracking !== 'undefined') {
        LiveTracking.configure({
            machineId: currentMachine,
            machineName: machineName,
            category: category,
            process: MACHINE_PROCESS[currentMachine] || null
        });
    }

    // Assembly: no start/end/breakdown UI; operator + output on main screen
    if (isAssemblyMachine()) {
        const control = document.querySelector('.control-section');
        if (control) control.style.display = 'none';
        setAssemblyWorkflowVisible(false);
    }
}

function updateNavigationForCategory(category) {
    const navContainer = document.querySelector('.machine-nav');
    if (!navContainer) return;
    
    const machines = MACHINE_CATEGORIES[category];
    navContainer.innerHTML = '';
    
    machines.forEach(machine => {
        const link = document.createElement('a');
        link.href = `?machine=${machine}`;
        link.className = 'nav-btn';
        link.dataset.machine = machine;
        link.textContent = MACHINE_NAMES[machine] || machine;
        
        if (machine === currentMachine) {
            link.classList.add('active');
        }
        
        navContainer.appendChild(link);
    });
}

function updateLaminationFields() {
    const narendraFields = document.getElementById('narendra-fields');
    const wityFields = document.getElementById('wity-fields');

    const sheetsProcessedEl = document.getElementById('sheets-processed');
    const wastedSheetsEl = document.getElementById('wasted-sheets');

    if (narendraFields) {
        narendraFields.style.display = isNarendraMachine() ? 'block' : 'none';
    }

    if (wityFields) {
        wityFields.style.display = isWityMachine() ? 'block' : 'none';
    }

    const wityInputIds = ['wity-quantity', 'wity-length-mm', 'wity-width-mm', 'wity-mill', 'wity-grade', 'wity-gsm'];
    wityInputIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.required = isWityMachine();
        if (!isWityMachine()) {
            if (el.tagName === 'SELECT') el.value = '';
            else el.value = '';
        }
    });

    if (isWityMachine()) {
        if (sheetsProcessedEl) {
            sheetsProcessedEl.required = false;
            const grp = sheetsProcessedEl.closest('.form-group');
            if (grp) grp.style.display = 'none';
        }
        if (wastedSheetsEl) {
            wastedSheetsEl.required = false;
            const grp = wastedSheetsEl.closest('.form-group');
            if (grp) grp.style.display = 'none';
        }
    } else {
        if (sheetsProcessedEl) {
            sheetsProcessedEl.required = true;
            const grp = sheetsProcessedEl.closest('.form-group');
            if (grp) grp.style.display = '';
        }
        if (wastedSheetsEl) {
            wastedSheetsEl.required = true;
            const grp = wastedSheetsEl.closest('.form-group');
            if (grp) grp.style.display = '';
        }
    }
}

function updateMachineSelectModal() {
    const category = getMachineCategory(currentMachine);
    const machines = MACHINE_CATEGORIES[category];
    const grid = document.querySelector('.machine-select-grid');
    
    if (!grid) return;
    
    grid.innerHTML = '';
    machines.forEach(machine => {
        const btn = document.createElement('button');
        btn.className = 'machine-select-btn';
        btn.dataset.machine = machine;
        btn.innerHTML = `
            <span class="machine-icon">${category === 'lamination' ? '📋' : category === 'rigid' ? '🧱' : '⚙️'}</span>
            <span>${MACHINE_NAMES[machine] || machine}</span>
        `;
        btn.addEventListener('click', () => {
            window.location.href = `manual-machine.html?machine=${machine}`;
        });
        grid.appendChild(btn);
    });
}

function setupEventListeners() {
    // PO Input
    document.getElementById('load-job-btn').addEventListener('click', handleLoadJob);
    document.getElementById('po-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLoadJob();
    });
    
    // Control buttons
    document.getElementById('btn-start').addEventListener('click', handleStartPressed);
    document.getElementById('btn-breakdown').addEventListener('click', showBreakdownModal);
    document.getElementById('btn-lunch').addEventListener('click', () => handleStateChange('lunch'));
    document.getElementById('btn-finish').addEventListener('click', showFinishModal);

    const assemblyContinueBtn = document.getElementById('assembly-continue-btn');
    if (assemblyContinueBtn) {
        assemblyContinueBtn.addEventListener('click', handleAssemblyContinue);
    }
    
    // Finish modal
    document.getElementById('finish-modal-close').addEventListener('click', () => closeModal('finish-modal'));
    document.getElementById('finish-cancel').addEventListener('click', () => closeModal('finish-modal'));
    document.getElementById('finish-form').addEventListener('submit', handleFinishSubmit);
    
    // Summary modal
    document.getElementById('summary-modal-close').addEventListener('click', () => closeModal('summary-modal'));
    document.getElementById('summary-edit').addEventListener('click', handleSummaryEdit);
    document.getElementById('summary-confirm').addEventListener('click', handleSummaryConfirm);
    
    // Breakdown modal
    document.getElementById('breakdown-modal-close').addEventListener('click', () => closeModal('breakdown-modal'));
    document.getElementById('breakdown-cancel').addEventListener('click', () => closeModal('breakdown-modal'));
    document.getElementById('breakdown-form').addEventListener('submit', handleBreakdownSubmit);
    
    // Breakdown type buttons
    document.querySelectorAll('.breakdown-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.breakdown-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            breakdownType = btn.dataset.type;
        });
    });
    
    // Machine selection modal - dynamically updated
    updateMachineSelectModal();

    // Reset memory button + modal
    const resetBtn = document.getElementById('reset-memory-btn');
    if (resetBtn) resetBtn.addEventListener('click', showResetMemoryModal);

    const logoutBtn = document.getElementById('shift-logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleShiftLogout);

    const resetClose = document.getElementById('reset-memory-modal-close');
    if (resetClose) resetClose.addEventListener('click', closeResetMemoryModal);

    const resetCancel = document.getElementById('reset-memory-cancel');
    if (resetCancel) resetCancel.addEventListener('click', closeResetMemoryModal);

    const resetConfirm = document.getElementById('reset-memory-confirm');
    if (resetConfirm) resetConfirm.addEventListener('click', confirmResetMemory);

    const pinInput = document.getElementById('reset-pin-input');
    if (pinInput) {
        pinInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') confirmResetMemory();
        });
    }
}

// ==================== Reset Memory (Simpler View) ====================
function showResetMemoryModal() {
    const pinInput = document.getElementById('reset-pin-input');
    const errorMessage = document.getElementById('pin-error-message');

    openModal('reset-memory-modal');
    if (pinInput) {
        pinInput.value = '';
        pinInput.focus();
    }
    if (errorMessage) errorMessage.textContent = '';
}

function closeResetMemoryModal() {
    const pinInput = document.getElementById('reset-pin-input');
    const errorMessage = document.getElementById('pin-error-message');

    closeModal('reset-memory-modal');
    if (pinInput) pinInput.value = '';
    if (errorMessage) errorMessage.textContent = '';
}

function confirmResetMemory() {
    const pinInput = document.getElementById('reset-pin-input');
    const errorMessage = document.getElementById('pin-error-message');
    if (!pinInput) return;

    const enteredPin = pinInput.value;

    if (enteredPin.length !== 4) {
        if (errorMessage) errorMessage.textContent = 'Please enter a 4-digit PIN';
        return;
    }

    if (enteredPin !== RESET_MEMORY_PIN) {
        if (errorMessage) errorMessage.textContent = 'Incorrect PIN. Please try again.';
        pinInput.value = '';
        pinInput.focus();
        return;
    }

    performMemoryReset();
}

function performMemoryReset() {
    console.log('🗑️ Performing memory reset (simpler view)...');

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    // Reset in-memory state
    currentJob = null;
    currentState = null;
    currentOperator = null;
    stateStartTimestamp = null;
    jobStartTimestamp = null;
    stateTimers = {
        running: 0,
        downtime_mech: 0,
        downtime_elec: 0,
        lunch: 0
    };
    pendingJobData = null;
    laminationData = {};

    // Clear storage for this machine
    clearStateStorage();

    // Update UI
    displayJobDetails();
    updateControlButtons();
    updateTimerDisplay();
    closeResetMemoryModal();

    alert('✅ Memory cleared successfully!\n\nAll data has been reset:\n• Job unloaded\n• Timers reset to zero\n• Machine state cleared');
}

// ==================== LAM Material Confirmation (Simpler View) ====================

/**
 * Lamination simpler-view flow:
 * - On Start (Running): if FIL/ADH lines have IssuedQuantity=0, show confirmation popup.
 * - Operator can edit last 4 digits (supports multiple FIL/ADH lines).
 * - Codes are stored on currentJob and sent on Finish as jobData.lam_material_codes.
 * - Backend issues materials proportionally on job completion.
 */
async function showLAMMaterialConfirmDialog(lamMaterials, absoluteEntry, jobPlannedQty, documentNumber) {
    return new Promise((resolve) => {
        // Create modal overlay
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
            overscroll-behavior: contain;
            touch-action: none;
            padding: 16px;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: white;
            border-radius: 16px;
            width: 100%;
            max-width: 520px;
            max-height: 90vh;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.45);
        `;

        const LAM_WAREHOUSE_DEFAULT =
            (lamMaterials || []).map(m => (m && m.warehouse) ? String(m.warehouse).trim() : '').find(Boolean) || 'II-LAM';

        // Build list UI (ADH only).
        // Film is issued on START from user-selected batches (foil-style).
        const normalized = (lamMaterials || []).filter(m => {
            // Skip negative planned qty/base ratio lines for this confirmation check
            if (Number(m.plannedQuantity ?? 0) < 0) return false;

            const itemNo = (m.itemNo || '').toUpperCase();
            const itemName = (m.itemName || '').toUpperCase();

            // Be tolerant: backend may place ADH hint in itemName or inside the string.
            return (
                itemNo.startsWith('ADH') ||
                itemName.startsWith('ADH') ||
                itemNo.includes('ADH') ||
                itemName.includes('ADH')
            );
        });

        const materialRowsHtml = normalized.map((m, idx) => {
            const itemNo = m.itemNo || '';
            const itemNoUpper = itemNo.toUpperCase();
            const isAdh = itemNoUpper.startsWith('ADH');
            const label = isAdh ? 'ADHESIVE' : 'ADHESIVE';
            const icon = '🧴';
            const accent = '#b45309';
            const bg = '#fef3c7';
            const border = '#fcd34d';

            const prefix = itemNo.length > 4 ? itemNo.substring(0, itemNo.length - 4) : itemNo;
            const suffix = itemNo.length > 4 ? itemNo.substring(itemNo.length - 4) : '';
            const supportsNumericSuffixEdit = /^\d{4}$/.test(suffix);

            const plannedQty = m.plannedQuantity ?? 0;
            const lineNumber = m.lineNumber ?? 0;

            return `
                <div style="background: ${bg}; border: 1px solid ${border}; border-radius: 10px; padding: 14px; margin-bottom: 12px;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span style="font-size: 20px;">${icon}</span>
                        <span style="font-size: 14px; color: ${accent}; font-weight: 700;">${label}</span>
                        <span style="font-size: 12px; color: #64748b; margin-left: auto;">Planned: ${plannedQty}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        <span style="font-size: 16px; color: #1e293b; font-weight: 700; font-family: monospace;">${prefix}</span>
                        <input
                            type="text"
                            inputmode="numeric"
                            pattern="\\d*"
                            id="lam-mat-suffix-${idx}"
                            value="${suffix}"
                            maxlength="4"
                            data-prefix="${prefix}"
                            data-original="${itemNo}"
                            data-planned="${plannedQty}"
                            data-line="${lineNumber}"
                            data-warehouse="${m.warehouse || LAM_WAREHOUSE_DEFAULT}"
                            data-type="ADH"
                            data-editable="${supportsNumericSuffixEdit ? 'true' : 'false'}"
                            ${supportsNumericSuffixEdit ? '' : 'readonly'}
                            style="width: 74px; padding: 6px 8px; border: 2px solid ${border}; border-radius: 6px; font-size: 16px; font-weight: 700; text-align: center; font-family: monospace; background: ${supportsNumericSuffixEdit ? 'white' : '#f1f5f9'}; ${supportsNumericSuffixEdit ? '' : 'cursor: not-allowed;'}"
                        />
                        <span style="font-size: 11px; color: #475569; margin-left: auto;">Line: ${lineNumber}</span>
                    </div>
                    <div style="font-size: 11px; color:#64748b; margin-top: 4px;">${supportsNumericSuffixEdit ? 'Last 4 digits can be changed' : 'Code is fixed because the last 4 characters are not numeric'}</div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 6px;">${m.itemName || ''}</div>
                    <div id="lam-mat-uom-${idx}" style="font-size: 11px; color: #64748b; margin-top: 4px;">UoM: —</div>
                </div>
            `;
        }).join('');

        modal.innerHTML = `
            <div style="background: linear-gradient(135deg, #0891b2 0%, #0e7490 100%); padding: 18px 20px; color: white;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                    <div>
                        <div style="font-size: 16px; font-weight: 800; margin: 0;">Lamination Adhesive</div>
                        <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">Confirm ADH code before starting</div>
                    </div>
                    <div style="font-size: 12px; opacity: 0.95; text-align:right;">
                        PO: <span style="font-weight:800;">${documentNumber}</span><br/>
                        Planned: <span style="font-weight:800;">${(jobPlannedQty || 0).toLocaleString()}</span>
                    </div>
                </div>
            </div>

            <div id="lam-simple-content" style="padding: 16px 20px; max-height: 60vh; overflow-y: auto;">
                <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:10px; padding:12px; margin-bottom: 14px;">
                    <div style="font-size:12px; color:#166534; font-weight:700;">
                        Adhesive will be issued on FINISH, proportionally to quantity processed.
                    </div>
                    <div style="font-size:11px; color:#14532d; margin-top:6px;">
                        You can change last 4 digits if you used a different Adhesive code.
                    </div>
                </div>

                ${materialRowsHtml || `<div style="font-size:13px; color:#334155; font-weight:700;">No ADH lines found.</div>`}
            </div>

            <div style="padding: 14px 20px; background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; gap:10px; justify-content:flex-end;">
                <button id="lam-simple-cancel" style="padding: 12px 18px; background:white; color:#64748b; border:1px solid #e2e8f0; border-radius:10px; cursor:pointer; font-size:14px; font-weight:700;">
                    Cancel
                </button>
                <button id="lam-simple-confirm" style="padding: 12px 20px; background: linear-gradient(135deg, #0891b2 0%, #0e7490 100%); color:white; border:none; border-radius:10px; cursor:pointer; font-size:14px; font-weight:800;">
                    Confirm & Continue
                </button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        normalized.forEach((m, idx) => {
            fetchItemInventoryUOM(m.itemNo).then((u) => {
                const el = modal.querySelector(`#lam-mat-uom-${idx}`);
                if (el) el.textContent = u ? `UoM: ${u}` : 'UoM: —';
            });
        });

        const contentDiv = modal.querySelector('#lam-simple-content');
        const cancelBtn = modal.querySelector('#lam-simple-cancel');
        const confirmBtn = modal.querySelector('#lam-simple-confirm');

        // Prevent pull-to-refresh / background scroll
        if (contentDiv) {
            let startY = 0;
            contentDiv.addEventListener('touchstart', (e) => { startY = e.touches[0].pageY; }, { passive: true });
            contentDiv.addEventListener('touchmove', (e) => {
                const currentY = e.touches[0].pageY;
                const scrollTop = contentDiv.scrollTop;
                if (scrollTop <= 0 && currentY > startY) e.preventDefault();
            }, { passive: false });
        }
        overlay.addEventListener('touchmove', (e) => {
            if (contentDiv && !contentDiv.contains(e.target)) e.preventDefault();
        }, { passive: false });

        const cleanup = () => {
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        };

        cancelBtn.addEventListener('click', () => {
            cleanup();
            resolve({ success: false, message: 'LAM material confirmation cancelled' });
        });

        confirmBtn.addEventListener('click', () => {
            const inputs = Array.from(modal.querySelectorAll('input[id^="lam-mat-suffix-"]'));

            const lamMaterialCodes = {
                plannedQty: jobPlannedQty || 0,
                absoluteEntry,
                documentNumber,
                warehouse: LAM_WAREHOUSE_DEFAULT,
                film: null,
                adhesive: null
            };

            // Only 1 ADH input is expected here, but be tolerant.
            const adhInput = inputs.find(i => (i.dataset.type || '').toUpperCase() === 'ADH') || inputs[0];
            if (adhInput) {
                const originalCode = adhInput.dataset.original || '';
                const editable = adhInput.dataset.editable === 'true';
                const suffix = editable ? (adhInput.value || '').padStart(4, '0') : '';
                const prefix = adhInput.dataset.prefix || '';
                const itemCode = editable ? prefix + suffix : originalCode;

                lamMaterialCodes.adhesive = {
                    itemCode,
                    originalCode,
                    plannedQty: parseFloat(adhInput.dataset.planned) || 0,
                    lineNumber: parseInt(adhInput.dataset.line) || 0,
                    warehouse: adhInput.dataset.warehouse || LAM_WAREHOUSE_DEFAULT,
                    codeChanged: editable && itemCode !== originalCode
                };
            }

            cleanup();
            resolve({ success: true, lamMaterialCodes });
        });

        // Focus first suffix field if any
        const firstInput = modal.querySelector('input[id^="lam-mat-suffix-"]');
        if (firstInput && firstInput.dataset.editable === 'true') {
            firstInput.focus();
            firstInput.select();
        }
    });
}

// ==================== LAM Film Batch Issue (Foil-style) ====================

async function showLAMFilmBatchIssueDialog(filmMaterial, absoluteEntry, documentNumber) {
    return new Promise(async (resolve) => {
        try {
            const LAM_WAREHOUSE = String(filmMaterial?.warehouse || '').trim() || 'II-LAM';

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
                overscroll-behavior: contain;
                touch-action: none;
                padding: 16px;
            `;

            const modal = document.createElement('div');
            modal.style.cssText = `
                background: white;
                border-radius: 16px;
                width: 100%;
                max-width: 760px;
                max-height: 90vh;
                overflow: hidden;
                box-shadow: 0 25px 50px -12px rgba(0,0,0,0.45);
                display: flex;
                flex-direction: column;
            `;

            const originalItemNo = filmMaterial?.itemNo || '';
            const itemNo = (originalItemNo || '').toUpperCase();

            const itemCodePrefix = originalItemNo.length > 4 ? originalItemNo.substring(0, originalItemNo.length - 4) : originalItemNo;
            const originalSuffix = originalItemNo.length > 4 ? originalItemNo.substring(originalItemNo.length - 4) : '';
            const supportsNumericSuffixEdit = /^\d{4}$/.test(originalSuffix);

            const plannedQty = Number(filmMaterial?.plannedQuantity ?? 0) || 0;
            const lineNumber = Number(filmMaterial?.lineNumber ?? 0) || 0;

            modal.innerHTML = `
                <div style="background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%); padding: 18px 20px; color: white; flex-shrink: 0;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                        <div>
                            <div style="font-size: 16px; font-weight: 800; margin: 0;">Lamination Film Issue</div>
                            <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">Select batch(es) and quantity to issue</div>
                        </div>
                        <div style="font-size: 12px; opacity: 0.95; text-align:right;">
                            PO: <span style="font-weight:800;">${documentNumber || ''}</span><br/>
                            Planned: <span style="font-weight:800;">${plannedQty.toLocaleString()}</span>
                        </div>
                    </div>
                </div>

                <div id="lam-film-content" style="padding: 14px 16px; overflow-y: auto; flex: 1;">
                    <div style="background:#f1f5f9; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-bottom: 12px;">
                        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                            <div style="font-size: 12px; color:#475569; font-weight:700;">FILM ITEM</div>
                            <div style="font-family: monospace; font-weight:800; font-size: 14px; color:#1f2937;">${originalItemNo}</div>
                            <div style="margin-left:auto; display:flex; align-items:center; gap:10px;">
                                <div style="font-size: 12px; color:#475569;">${supportsNumericSuffixEdit ? 'Change last 4 digits:' : 'Code fixed:'}</div>
                                <input id="lam-film-suffix" type="text" inputmode="numeric" pattern="\\d*" maxlength="4"
                                    value="${originalSuffix}" data-prefix="${itemCodePrefix}" data-original="${originalItemNo}"
                                    data-editable="${supportsNumericSuffixEdit ? 'true' : 'false'}"
                                    ${supportsNumericSuffixEdit ? '' : 'readonly'}
                                    style="width: 84px; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; font-weight: 800; text-align: center; font-family: monospace; background: ${supportsNumericSuffixEdit ? 'white' : '#f1f5f9'}; ${supportsNumericSuffixEdit ? '' : 'cursor: not-allowed;'}" />
                            </div>
                        </div>
                        <div style="font-size: 11px; color:#64748b; margin-top: 6px;">Line: ${lineNumber} • Warehouse: ${LAM_WAREHOUSE} • UoM: <span id="lam-film-uom">—</span></div>
                        <div style="font-size: 11px; color:#64748b; margin-top: 4px;">${supportsNumericSuffixEdit ? 'Last 4 digits can be changed' : 'Code is fixed because the last 4 characters are not numeric'}</div>
                    </div>

                    <div style="display:flex; gap:10px; align-items:center; margin-bottom: 10px;">
                        <input id="lam-film-search" type="text" placeholder="Search batch no / width..." 
                            style="flex:1; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 13px;" />
                        <button id="lam-film-clear" style="padding: 10px 14px; border-radius: 10px; background: white; border: 1px solid #e2e8f0; cursor:pointer; font-size: 13px; font-weight:700; color:#64748b;">
                            Clear
                        </button>
                    </div>

                    <div id="lam-film-loading" style="display:none; padding: 18px; text-align:center; color:#64748b; font-weight:700;">Loading batches...</div>
                    <div id="lam-film-empty" style="display:none; padding: 18px; text-align:center;">
                        <div style="font-weight:800; color:#0f172a;">No batches available</div>
                        <div style="font-size: 12px; color:#64748b; margin-top:4px;">Check stock in ${LAM_WAREHOUSE}</div>
                    </div>

                    <table id="lam-film-table" style="width:100%; border-collapse: collapse; display:none;">
                        <thead>
                            <tr style="background:#f8fafc; border:1px solid #e2e8f0;">
                                <th style="padding: 10px 8px; width:44px; text-align:center; font-size:12px; color:#475569;">Sel</th>
                                <th style="padding: 10px 8px; text-align:left; font-size:12px; color:#475569;">Batch</th>
                                <th style="padding: 10px 8px; text-align:left; font-size:12px; color:#475569;">Grade</th>
                                <th style="padding: 10px 8px; text-align:right; font-size:12px; color:#475569;">Len</th>
                                <th style="padding: 10px 8px; text-align:right; font-size:12px; color:#475569;">Wid</th>
                                <th style="padding: 10px 8px; text-align:right; font-size:12px; color:#475569;">Avail</th>
                                <th style="padding: 10px 8px; width:110px; text-align:center; font-size:12px; color:#475569;">Issue Qty</th>
                            </tr>
                        </thead>
                        <tbody id="lam-film-tbody"></tbody>
                    </table>

                    <div style="margin-top: 12px; padding: 12px; border:1px solid #e2e8f0; border-radius:10px; background:#f8fafc; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
                        <div>
                            <span style="font-size: 12px; color:#64748b;">Total issue:</span>
                            <span id="lam-film-total-issue" style="font-size: 16px; font-weight: 900; margin-left: 8px; color:#64748b;">0</span>
                        </div>
                        <div>
                            <span style="font-size: 12px; color:#64748b;">Total available:</span>
                            <span id="lam-film-total-available" style="font-size: 16px; font-weight: 900; margin-left: 8px; color:#7c3aed;">0</span>
                        </div>
                    </div>
                </div>

                <div style="padding: 14px 16px; background: #f8fafc; border-top: 1px solid #e2e8f0; display:flex; gap:10px; justify-content:flex-end; flex-shrink: 0;">
                    <button id="lam-film-cancel" style="padding: 10px 18px; background: white; color: #64748b; border: 1px solid #e2e8f0; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 800;">
                        Cancel
                    </button>
                    <button id="lam-film-issue" style="padding: 10px 20px; background: #7c3aed; color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 900;">
                        Issue Film
                    </button>
                </div>
            `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            const contentDiv = modal.querySelector('#lam-film-content');
            const suffixInput = modal.querySelector('#lam-film-suffix');
            const searchInput = modal.querySelector('#lam-film-search');
            const clearBtn = modal.querySelector('#lam-film-clear');
            const loadingDiv = modal.querySelector('#lam-film-loading');
            const emptyDiv = modal.querySelector('#lam-film-empty');
            const table = modal.querySelector('#lam-film-table');
            const tbody = modal.querySelector('#lam-film-tbody');
            const totalIssueSpan = modal.querySelector('#lam-film-total-issue');
            const totalAvailableSpan = modal.querySelector('#lam-film-total-available');
            const cancelBtn = modal.querySelector('#lam-film-cancel');
            const issueBtn = modal.querySelector('#lam-film-issue');

            let allBatches = [];
            let filteredBatches = [];
            let currentItemCode = originalItemNo;

            const lamFilmUomEl = modal.querySelector('#lam-film-uom');
            async function refreshLamFilmUom() {
                const u = await fetchItemInventoryUOM(currentItemCode);
                if (lamFilmUomEl) lamFilmUomEl.textContent = u || '—';
            }
            await refreshLamFilmUom();

            // Prevent pull-to-refresh / background scroll
            if (contentDiv) {
                let startY = 0;
                contentDiv.addEventListener('touchstart', (e) => { startY = e.touches[0].pageY; }, { passive: true });
                contentDiv.addEventListener('touchmove', (e) => {
                    const currentY = e.touches[0].pageY;
                    const scrollTop = contentDiv.scrollTop;
                    if (scrollTop <= 0 && currentY > startY) e.preventDefault();
                }, { passive: false });
            }
            overlay.addEventListener('touchmove', (e) => {
                if (contentDiv && !contentDiv.contains(e.target)) e.preventDefault();
            }, { passive: false });

            function cleanup() {
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }

            function updateTotals() {
                let total = 0;
                tbody.querySelectorAll('.batch-qty-input').forEach(input => {
                    total += (parseFloat(input.value) || 0);
                });
                totalIssueSpan.textContent = total.toFixed(0);
                totalIssueSpan.style.color = total > 0 ? '#16a34a' : '#64748b';
            }

            function renderBatches(batches) {
                const dimLen = (b) => {
                    const n = Number(b.length ?? b.Length ?? b.u_length ?? b.U_Length ?? b.U_LENGTH);
                    return Number.isFinite(n) ? n : 0;
                };
                const dimWid = (b) => {
                    const n = Number(b.width ?? b.Width ?? b.u_width ?? b.U_Width ?? b.U_WIDTH);
                    return Number.isFinite(n) ? n : 0;
                };
                const gradeOf = (b) => {
                    const g = b.grade ?? b.Grade ?? b.U_GRADE;
                    return (g != null && String(g).trim() !== '') ? String(g) : 'N/A';
                };
                tbody.innerHTML = '';
                batches.forEach((batch, idx) => {
                    const row = document.createElement('tr');
                    row.style.cssText = 'border-bottom: 1px solid #f1f5f9;';
                    row.innerHTML = `
                        <td style="padding: 8px; text-align: center;">
                            <input type="checkbox" class="batch-checkbox" data-idx="${idx}" style="width: 18px; height: 18px; cursor: pointer;">
                        </td>
                        <td style="padding: 8px; font-size: 14px; font-weight: 800; font-family: monospace; color: #1e293b;">${batch.batchNumber}</td>
                        <td style="padding: 8px; font-size: 13px; color: #374151; font-weight: 600;">${gradeOf(batch)}</td>
                        <td style="padding: 8px; font-size: 13px; text-align: right; color: #374151;">${dimLen(batch)}</td>
                        <td style="padding: 8px; font-size: 13px; text-align: right; color: #374151;">${dimWid(batch)}</td>
                        <td style="padding: 8px; font-size: 14px; text-align: right; font-weight: 900; color: #7c3aed;">${batch.available || 0}</td>
                        <td style="padding: 8px; text-align: center;">
                            <input type="number" class="batch-qty-input" data-idx="${idx}" data-batch="${batch.batchNumber}"
                                data-available="${batch.available}" value="" min="0" max="${batch.available}" step="1"
                                style="width: 86px; padding: 6px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; text-align: center; font-weight: 800;"
                                disabled>
                        </td>
                    `;
                    tbody.appendChild(row);
                });

                tbody.querySelectorAll('.batch-checkbox').forEach(cb => {
                    cb.addEventListener('change', (e) => {
                        const idx = e.target.dataset.idx;
                        const qtyInput = tbody.querySelector(`.batch-qty-input[data-idx="${idx}"]`);
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

                tbody.querySelectorAll('.batch-qty-input').forEach(input => {
                    input.addEventListener('input', () => {
                        const max = parseFloat(input.dataset.available) || 0;
                        const val = parseFloat(input.value) || 0;
                        if (val > max) input.value = max;
                        if (val < 0) input.value = 0;
                        updateTotals();
                    });
                });
            }

            async function fetchBatches(itemCodeToFetch) {
                loadingDiv.style.display = 'block';
                table.style.display = 'none';
                emptyDiv.style.display = 'none';

                try {
                    const resp = await fetch(`${API_CONFIG.BASE_URL}/rmc-batches/${encodeURIComponent(itemCodeToFetch)}?warehouse=${encodeURIComponent(LAM_WAREHOUSE)}`);
                    const result = await resp.json();

                    if (result.success && Array.isArray(result.batches) && result.batches.length > 0) {
                        allBatches = result.batches;
                        filteredBatches = [...allBatches];
                        totalAvailableSpan.textContent = result.totalAvailable || 0;

                        loadingDiv.style.display = 'none';
                        table.style.display = 'table';
                        renderBatches(filteredBatches);
                    } else {
                        loadingDiv.style.display = 'none';
                        emptyDiv.style.display = 'block';
                        allBatches = [];
                        filteredBatches = [];
                        totalAvailableSpan.textContent = '0';
                    }
                } catch (err) {
                    console.error('Error fetching film batches:', err);
                    loadingDiv.style.display = 'none';
                    emptyDiv.style.display = 'block';
                    emptyDiv.querySelector('div:first-child').textContent = 'Error loading batches';
                    emptyDiv.querySelector('div:last-child').textContent = err.message;
                }
            }

            // Initial load
            await fetchBatches(currentItemCode);

            searchInput.addEventListener('input', () => {
                const query = (searchInput.value || '').toLowerCase().trim();
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

            suffixInput.addEventListener('input', async () => {
                if (!supportsNumericSuffixEdit) {
                    suffixInput.value = originalSuffix;
                    currentItemCode = originalItemNo;
                    return;
                }
                let rawValue = (suffixInput.value || '').replace(/\D/g, '');
                if (rawValue.length > 4) rawValue = rawValue.substring(0, 4);
                suffixInput.value = rawValue;
                const newSuffix = rawValue.padStart(4, '0');
                currentItemCode = (suffixInput.dataset.prefix || itemCodePrefix) + newSuffix;
                if (rawValue.length === 4) await refreshLamFilmUom();
                if (rawValue.length >= 2) await fetchBatches(currentItemCode);
            });

            suffixInput.addEventListener('blur', async () => {
                if (!supportsNumericSuffixEdit) {
                    suffixInput.value = originalSuffix;
                    currentItemCode = originalItemNo;
                    await refreshLamFilmUom();
                    return;
                }
                let rawValue = (suffixInput.value || '').replace(/\D/g, '');
                if (rawValue.length > 4) rawValue = rawValue.substring(0, 4);
                suffixInput.value = rawValue.padStart(4, '0');
                currentItemCode = (suffixInput.dataset.prefix || itemCodePrefix) + suffixInput.value;
                await refreshLamFilmUom();
            });

            clearBtn.addEventListener('click', () => {
                tbody.querySelectorAll('.batch-checkbox').forEach((cb) => { cb.checked = false; });
                tbody.querySelectorAll('.batch-qty-input').forEach((inp) => { inp.disabled = true; inp.value = ''; });
                updateTotals();
            });

            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve({ success: false, message: 'Film issue cancelled by user' });
            });

            issueBtn.addEventListener('click', async () => {
                const batchAllocations = [];
                tbody.querySelectorAll('.batch-qty-input').forEach(input => {
                    if (!input.disabled) {
                        const qty = parseFloat(input.value) || 0;
                        if (qty > 0) batchAllocations.push({ batchNumber: input.dataset.batch, quantity: qty });
                    }
                });

                if (batchAllocations.length === 0) {
                    alert('Please select at least one batch and enter quantity to issue');
                    return;
                }

                const totalQty = batchAllocations.reduce((sum, b) => sum + b.quantity, 0);
                const currentSuffix = supportsNumericSuffixEdit ? (suffixInput.value || '').replace(/\D/g, '').padStart(4, '0') : originalSuffix;
                const finalItemCode = supportsNumericSuffixEdit ? itemCodePrefix + currentSuffix : originalItemNo;
                const itemCodeWasChanged = supportsNumericSuffixEdit && (currentSuffix !== originalSuffix);

                issueBtn.disabled = true;
                issueBtn.textContent = 'Issuing...';

                try {
                    const { resp, json: result } = await fetchJsonWithAutoRelease(
                        `${API_CONFIG.BASE_URL}/issue-rmc-batches`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                absoluteEntry,
                                documentNumber,
                                itemCode: finalItemCode,
                                lineNumber,
                                batchAllocations,
                                targetWarehouse: LAM_WAREHOUSE,
                                remarks: `FILM issued via Manual Machine (LAM) - ${batchAllocations.length} batch(es), total ${totalQty}`,
                                itemCodeChanged: itemCodeWasChanged,
                                originalItemCode: itemCodeWasChanged ? originalItemNo : undefined
                            })
                        },
                        { absoluteEntry, documentNumber }
                    );
                    if (!resp.ok || !result.success) {
                        throw new Error(result.message || result.error || 'Failed to issue film');
                    }

                    cleanup();
                    resolve({ success: true, message: 'Film issued successfully', totalIssued: totalQty, itemCode: finalItemCode });
                } catch (err) {
                    alert(`Error issuing film:\n${err.message}`);
                    issueBtn.disabled = false;
                    issueBtn.textContent = 'Issue Film';
                }
            });

            // Focus suffix (quick edits)
            if (suffixInput && supportsNumericSuffixEdit) {
                suffixInput.focus();
                suffixInput.select();
            }
        } catch (err) {
            console.error('Error in showLAMFilmBatchIssueDialog:', err);
            resolve({ success: false, message: err.message || 'Failed to show film issue dialog' });
        }
    });
}

// ==================== Generic Batch Issue (Foil-style) ====================
// Used for batch-managed materials (OITM.ManBtchNum = 'Y') that are not covered by
// the dedicated FIL/TAP/RMC dialogs and are not PMT/ADH workflows.
async function showGenericBatchIssueDialog(material, absoluteEntry, documentNumber, title = 'Material Issue', batchCache) {
    return new Promise(async (resolve) => {
        try {
            const itemCode = (material?.itemNo || '').toString().trim();
            const itemName = (material?.itemName || itemCode || '').toString().trim();
            const warehouse = (material?.warehouse || '').toString().trim();
            const progressText = material?._currentIndex && material?._totalCount
                ? ` (${material._currentIndex}/${material._totalCount})`
                : '';

            if (!itemCode) return resolve({ success: false, message: 'Missing item code' });
            if (!absoluteEntry || !documentNumber) return resolve({ success: false, message: 'Missing PO details' });

            // Use pre-fetched batches from cache when available, otherwise fetch now
            let batches = (batchCache && Array.isArray(batchCache[itemCode])) ? batchCache[itemCode] : null;
            if (!batches) {
                const batchesUrl = `${API_CONFIG.BASE_URL}/rmc-batches/${encodeURIComponent(itemCode)}${warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : ''}`;
                const resp = await fetch(batchesUrl, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
                const result = await resp.json().catch(() => ({}));
                if (!resp.ok || !result.success) {
                    throw new Error(result.message || result.error || 'Failed to fetch batches');
                }
                batches = Array.isArray(result.batches) ? result.batches : [];
            }
            if (batches.length === 0) {
                throw new Error(`No batches found for ${itemCode}. Please check stock/batches in SAP.`);
            }

            // Build modal
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed; inset: 0; background: rgba(0,0,0,0.45);
                display:flex; align-items:center; justify-content:center;
                z-index: 9999; padding: 20px;
            `;

            modal.innerHTML = `
                <div style="width: min(980px, 98vw); max-height: 88vh; overflow:auto; background:#fff; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.35);">
                    <div style="padding: 16px 18px; background: linear-gradient(135deg, #0f766e, #155e75); color:#fff;">
                        <div style="font-size: 16px; font-weight: 800; margin: 0;">${title}${progressText}</div>
                        <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">Select batch(es) and quantity to issue</div>
                        <div style="font-size: 12px; opacity: 0.9; margin-top: 6px;">
                            <b>${itemCode}</b> — ${escapeHtml(itemName)} ${warehouse ? ` • WH: <b>${escapeHtml(warehouse)}</b>` : ''}
                        </div>
                        <div style="font-size: 12px; opacity: 0.9; margin-top: 6px;">Inventory UoM: <span id="generic-issue-uom" style="font-weight: 700;">—</span></div>
                    </div>

                    <div style="padding: 16px 18px; overflow-x: auto; -webkit-overflow-scrolling: touch;">
                        <table style="width:100%; min-width: 640px; border-collapse: collapse; font-size: 13px;">
                            <thead>
                                <tr style="background:#f8fafc; color:#334155;">
                                    <th style="padding: 10px 8px; text-align:left; font-size:12px;">Batch</th>
                                    <th style="padding: 10px 8px; text-align:left; font-size:12px;">Grade</th>
                                    <th style="padding: 10px 8px; text-align:right; font-size:12px;">Length (m)</th>
                                    <th style="padding: 10px 8px; text-align:right; font-size:12px;">Width (mm)</th>
                                    <th style="padding: 10px 8px; text-align:right; font-size:12px; width:100px;">Available</th>
                                    <th style="padding: 10px 8px; text-align:center; font-size:12px; width:120px;">Issue Qty</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${batches.map((b, idx) => {
                                    const batchNumber = escapeHtml(String(b.batchNumber ?? b.BatchNumber ?? b.batch ?? ''));
                                    const grade = escapeHtml(String(b.grade ?? b.Grade ?? b.U_GRADE ?? 'N/A'));
                                    const len = Number(b.length ?? b.Length ?? b.u_length ?? b.U_Length ?? 0);
                                    const wid = Number(b.width ?? b.Width ?? b.u_width ?? b.U_Width ?? 0);
                                    const avail = Number(b.available ?? b.Available ?? b.availableQuantity ?? 0) || 0;
                                    return `
                                        <tr style="border-top: 1px solid #e2e8f0;">
                                            <td style="padding: 10px 8px; font-weight: 700; color:#0f172a;">${batchNumber}</td>
                                            <td style="padding: 10px 8px; color:#475569;">${grade}</td>
                                            <td style="padding: 10px 8px; text-align:right; color:#0f172a;">${Number.isFinite(len) ? len : 0}</td>
                                            <td style="padding: 10px 8px; text-align:right; color:#0f172a;">${Number.isFinite(wid) ? wid : 0}</td>
                                            <td style="padding: 10px 8px; text-align:right; color:#0f172a;">${avail.toLocaleString()}</td>
                                            <td style="padding: 10px 8px; text-align:center;">
                                                <input type="number" min="0" step="1"
                                                    data-idx="${idx}"
                                                    style="width: 96px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; text-align:center;"
                                                    placeholder="0" />
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>

                        <div style="display:flex; justify-content: space-between; align-items:center; margin-top: 14px;">
                            <div>
                                <span style="font-size: 12px; color:#64748b;">Total issue:</span>
                                <span id="generic-total-issue" style="font-size: 16px; font-weight: 900; margin-left: 8px; color:#64748b;">0</span>
                            </div>
                            <div style="display:flex; gap: 10px;">
                                <button id="generic-cancel" style="padding: 10px 16px; background: #e2e8f0; border:none; border-radius: 10px; cursor:pointer; font-weight: 800;">Cancel</button>
                                <button id="generic-issue" style="padding: 10px 20px; background: #0f766e; color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 900;">
                                    Issue Material
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const genericUomEl = modal.querySelector('#generic-issue-uom');
            fetchItemInventoryUOM(itemCode).then((u) => {
                if (genericUomEl) genericUomEl.textContent = u || '—';
            });

            const totalIssueSpan = modal.querySelector('#generic-total-issue');
            const cancelBtn = modal.querySelector('#generic-cancel');
            const issueBtn = modal.querySelector('#generic-issue');
            const qtyInputs = Array.from(modal.querySelectorAll('input[type="number"][data-idx]'));

            const cleanup = () => modal.remove();

            const computeTotal = () => {
                const total = qtyInputs.reduce((sum, el) => sum + (Number(el.value) || 0), 0);
                totalIssueSpan.textContent = total.toFixed(0);
                totalIssueSpan.style.color = total > 0 ? '#16a34a' : '#64748b';
                return total;
            };

            qtyInputs.forEach(el => el.addEventListener('input', computeTotal));
            computeTotal();

            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve({ success: false, message: 'Issue cancelled' });
            });

            issueBtn.addEventListener('click', async () => {
                const totalQty = computeTotal();
                const batchAllocations = qtyInputs
                    .map(el => {
                        const idx = Number(el.getAttribute('data-idx'));
                        const qty = Number(el.value) || 0;
                        const b = batches[idx] || {};
                        const batchNumber = String(b.BatchNumber ?? b.batchNumber ?? b.batch ?? '').trim();
                        return qty > 0 && batchNumber ? { batchNumber, quantity: qty } : null;
                    })
                    .filter(Boolean);

                if (batchAllocations.length === 0 || totalQty <= 0) {
                    alert('Please select at least one batch and enter quantity to issue');
                    return;
                }

                issueBtn.disabled = true;
                issueBtn.textContent = 'Issuing...';

                try {
                    const { resp: issueResp, json: issueJson } = await fetchJsonWithAutoRelease(
                        `${API_CONFIG.BASE_URL}/issue-rmc-batches`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                absoluteEntry,
                                documentNumber,
                                itemCode,
                                lineNumber: material?.lineNumber,
                                batchAllocations,
                                warehouse: warehouse || undefined,
                                remarks: `Material issued via Manual Machine - ${batchAllocations.length} batch(es), total ${totalQty}`
                            })
                        },
                        { absoluteEntry, documentNumber }
                    );
                    if (!issueResp.ok || !issueJson.success) {
                        throw new Error(issueJson.message || issueJson.error || 'Failed to issue material');
                    }

                    cleanup();
                    resolve({ success: true, message: 'Material issued successfully', totalIssued: totalQty });
                } catch (err) {
                    alert(`Error issuing material:\n${err.message}`);
                    issueBtn.disabled = false;
                    issueBtn.textContent = 'Issue Material';
                }
            });
        } catch (err) {
            console.error('Error in showGenericBatchIssueDialog:', err);
            resolve({ success: false, message: err.message || 'Failed to issue material' });
        }
    });
}

/**
 * Material issue flow (called right after Load Job), then auto-start running timer.
 * Uses PO data already fetched during load — no extra SAP round-trip.
 */
async function runMaterialIssueAndStartRunning() {
    showMaterialCheckOverlay('Checking materials…');

    try {
        // Wity: skip issue prompts entirely
        if (isWityMachine()) {
            hideMaterialCheckOverlay();
            if (currentJob) currentJob._materialIssuePending = false;
            handleStateChange('running');
            return;
        }

        // Combine ALL material arrays from the already-loaded PO data
        const allPending = [
            ...(Array.isArray(currentJob?.rawData?.unissuedMaterialsNeedIssue) ? currentJob.rawData.unissuedMaterialsNeedIssue : []),
            ...(Array.isArray(currentJob?.rawData?.pmtMaterialsNeedIssue) ? currentJob.rawData.pmtMaterialsNeedIssue : []),
            ...(Array.isArray(currentJob?.rawData?.rmcMaterialsNeedIssue) ? currentJob.rawData.rmcMaterialsNeedIssue : []),
            ...(Array.isArray(currentJob?.rawData?.lamMaterialsNeedIssue) ? currentJob.rawData.lamMaterialsNeedIssue : []),
            ...(Array.isArray(currentJob?.rawData?.tapMaterialsNeedIssue) ? currentJob.rawData.tapMaterialsNeedIssue : []),
        ];

        console.log('📦 Material issue check — allPending:', allPending.length,
            'items:', allPending.map(m => `${m?.itemNo}(batch=${m?.batchManaged})`));

        // --- Step 1: ADH code capture (any machine) ---
        // ADH materials are issued proportionally on FINISH — this popup only captures the code.
        // No batchManaged check: ADH code capture is independent of batch management.
        const adhMaterials = allPending.filter(m => {
            if (!m || Number(m.plannedQuantity ?? 0) < 0) return false;
            return (m.itemNo || '').toUpperCase().startsWith('ADH');
        });
        console.log('🧴 ADH materials found:', adhMaterials.length,
            adhMaterials.map(m => `${m?.itemNo}(batch=${m?.batchManaged}, planned=${m?.plannedQuantity})`));

        if (adhMaterials.length > 0 && !currentJob.lamMaterialCodes) {
            const absEntry = currentJob.rawData?.absoluteEntry || currentJob.rawData?.AbsoluteEntry || null;
            const docNum = currentJob.jobNumber;
            hideMaterialCheckOverlay();
            const confirmResult = await showLAMMaterialConfirmDialog(
                adhMaterials, absEntry, currentJob.plannedQuantity || 0, docNum
            );
            if (!confirmResult.success) {
                showToast('Adhesive confirmation cancelled', 'error');
                return;
            }
            currentJob.lamMaterialCodes = confirmResult.lamMaterialCodes;
            console.log('✅ ADH code stored for job finish:', currentJob.lamMaterialCodes);
            saveStateToStorage();
            showMaterialCheckOverlay('Preparing material issue…');
        }

        // --- Step 2: Batch-managed material issue (exclude ADH) ---
        const candidates = allPending
            .filter(m => Number(m?.plannedQuantity ?? 0) >= 0)
            .filter(m => {
                const code = (m?.itemNo || '').toString().toUpperCase();
                if (!code) return false;
                if (code.startsWith('ADH')) return false;
                if (!m.batchManaged) return false;
                return true;
            });

        console.log('📦 Batch-managed candidates for issue:', candidates.length,
            candidates.map(m => m?.itemNo));

        if (candidates.length > 0) {
            const absEntry = currentJob?.rawData?.absoluteEntry || currentJob?.rawData?.AbsoluteEntry || null;
            const docNum = currentJob?.jobNumber;
            if (!absEntry || !docNum) {
                showToast('Missing job AbsoluteEntry/PO number. Please reload the job.', 'error');
                return;
            }

            // Pre-fetch batches for ALL candidates in parallel while overlay is showing
            showMaterialCheckOverlay(`Fetching batch info for ${candidates.length} material(s)…`);
            const batchCache = {};
            await Promise.all(candidates.map(async (mat) => {
                const code = (mat?.itemNo || '').toString().trim();
                const wh = (mat?.warehouse || '').toString().trim();
                if (!code) return;
                try {
                    const url = `${API_CONFIG.BASE_URL}/rmc-batches/${encodeURIComponent(code)}${wh ? `?warehouse=${encodeURIComponent(wh)}` : ''}`;
                    const resp = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
                    const json = await resp.json().catch(() => ({}));
                    if (resp.ok && json.success && Array.isArray(json.batches)) {
                        batchCache[code] = json.batches;
                    }
                } catch (e) {
                    console.warn(`Pre-fetch batches for ${code} failed:`, e);
                }
            }));

            for (let i = 0; i < candidates.length; i++) {
                const mat = { ...candidates[i], _currentIndex: i + 1, _totalCount: candidates.length };
                hideMaterialCheckOverlay();
                const issueRes = await showGenericBatchIssueDialog(mat, absEntry, docNum, 'Material Issue', batchCache);
                if (!issueRes.success) {
                    showToast(issueRes.message || 'Material issue cancelled. Job not started.', 'error');
                    return;
                }
            }

            if (currentJob?.rawData) {
                currentJob.rawData.unissuedMaterialsNeedIssue = [];
                currentJob.rawData.pmtMaterialsNeedIssue = [];
                currentJob.rawData.rmcMaterialsNeedIssue = [];
                currentJob.rawData.lamMaterialsNeedIssue = [];
                currentJob.rawData.tapMaterialsNeedIssue = [];
            }
            saveStateToStorage();
        }

        // All materials issued successfully — unlock the Running state and start timer
        if (currentJob) currentJob._materialIssuePending = false;
        saveStateToStorage();
        hideMaterialCheckOverlay();
        handleStateChange('running');
    } finally {
        hideMaterialCheckOverlay();
        showLoading(false);
    }
}

function showMaterialCheckOverlay(message) {
    let overlay = document.getElementById('material-check-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'material-check-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.70);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:20000;';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div style="background:#0b1220;color:#e2e8f0;border:1px solid rgba(148,163,184,0.25);border-radius:12px;padding:20px 24px;width:min(420px,calc(100vw - 32px));box-shadow:0 18px 50px rgba(0,0,0,0.35);text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:8px;">
                <div style="width:10px;height:10px;border-radius:50%;background:#38bdf8;box-shadow:0 0 0 6px rgba(56,189,248,0.18);animation:pulse 1.5s infinite;"></div>
                <div style="font-weight:700;font-size:15px;">${escapeHtml(message || 'Please wait…')}</div>
            </div>
            <div style="font-size:13px;opacity:0.75;">Fetching data from SAP</div>
        </div>
        <style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}</style>
    `;
}

function hideMaterialCheckOverlay() {
    const el = document.getElementById('material-check-overlay');
    if (el) el.remove();
}

async function handleStartPressed() {
    if (!currentJob) {
        showToast('Please load a job first', 'error');
        return;
    }
    // If materials are still pending, re-trigger the issue flow instead of blocking silently.
    if (currentJob._materialIssuePending) {
        try {
            await runMaterialIssueAndStartRunning();
        } catch (e) {
            console.error('handleStartPressed material retry:', e);
            showToast(e?.message || 'Material issue failed', 'error');
        }
        return;
    }
    // Frontend-only: resume/start the running timer. No SAP request.
    handleStateChange('running');
}

// ==================== Job Loading ====================
async function handleLoadJob() {
    const poInput = document.getElementById('po-input');
    const poNumber = poInput.value.trim();
    
    if (!poNumber) {
        showToast('Please enter a PO number', 'error');
        return;
    }
    
    // Check if job is already running
    if (currentJob && currentState) {
        showToast('Please finish current job first', 'error');
        return;
    }
    
    showLoading(true);
    
    try {
        // Build URL with machine and process params for server-side validation
        const machineProcess = MACHINE_PROCESS[currentMachine];
        const baseUrl = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.productionOrder(poNumber)}`;
        const urlParams = new URLSearchParams();
        urlParams.append('machine', currentMachine);
        urlParams.append('process', machineProcess);
        // Fast job load (same as data-entry): skip optional SAP enrichment + slow PMT Goods Issue scan
        urlParams.append('materialOnly', '1');
        urlParams.append('enrich', '0');
        // Match data-entry: lamination machines may run MPET jobs (server uses machine-specific rules; param kept for parity)
        if (machineProcess && String(machineProcess).toLowerCase().includes('lamination')) {
            urlParams.append('allowedProcessCodes', 'LAM,MPET');
        }

        const url = `${baseUrl}?${urlParams.toString()}`;
        console.log('Fetching job from:', url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        console.log('API Response:', result);
        
        if (!response.ok) {
            // Handle specific error types
            if (result.error === 'Process code mismatch') {
                throw new Error(`Wrong machine! ${result.message}`);
            }
            throw new Error(result.error || result.message || 'Failed to load job');
        }
        
        if (!result.success || !result.data) {
            throw new Error('Invalid response from server');
        }
        
        const jobData = result.data;
        console.log('Job data received:', jobData);

        // Fresh job: clear stale session state. If currentState stayed 'running', handleStateChange('running')
        // would no-op (same state) and the Start button would never show "Running" / timer would not reset.
        currentState = null;
        stateStartTimestamp = null;
        jobStartTimestamp = null;
        stateTimers = { running: 0, downtime_mech: 0, downtime_elec: 0, lunch: 0 };
        updateControlButtons();

        // RIGID machines: enforce U_PCode override in client payload to keep SAP auto-issue stable.
        // MKG for Emmeci/Fuchu; ASS for Assembly.
        if (isRigidMachine()) {
            const override = isAssemblyMachine() ? 'ASS' : 'MKG';
            jobData.uPCode = override;
            jobData.u_p_code = override;
            jobData.U_PCode = override;
        }
        
        // Set current job using the correct field names from API
        currentJob = {
            jobNumber: jobData.jobNumber || jobData.docNum,
            jobName: jobData.jobName || jobData.itemName || jobData.fgItemCode || 'Unknown',
            fgItemCode: jobData.itemNo || jobData.fgItemCode,
            plannedQuantity: jobData.plannedQuantity || 0,
            issuedQuantity: jobData.issuedQuantity || 0,
            completedQuantity: jobData.completedQuantity || 0,
            numOfUps: jobData.numOfUps || 1,
            processCode: jobData.processCode || '',
            // DieCutting (DIE/EMB+P): issuedQuantity is in SHEETS, completedQuantity is in CARTONS.
            // We keep the raw values as-is and convert for display/validation when needed.
            uPCode: jobData.uPCode || '',
            baseQuantities: jobData.baseQuantities || [],
            fgLines: jobData.fgLines || [],
            isJumbledJob: jobData.isJumbledJob === true || (jobData.fgLines && jobData.fgLines.length > 1),
            rawData: jobData,
            // Lamination: FIL/ADH lines needing issue (IssuedQuantity === 0)
            lamMaterialsNeedIssue: jobData.lamMaterialsNeedIssue || [],
            lamMaterialCodes: null,
            lamFilmIssued: false
        };

        // Check if any materials need issuing — if so, block Running until done.
        // Includes batch-managed materials AND ADH code-capture materials.
        const _allMats = [
            ...(jobData.unissuedMaterialsNeedIssue || []),
            ...(jobData.pmtMaterialsNeedIssue || []),
            ...(jobData.rmcMaterialsNeedIssue || []),
            ...(jobData.lamMaterialsNeedIssue || []),
            ...(jobData.tapMaterialsNeedIssue || []),
        ];
        const _hasADH = _allMats.some(m => m && (m.itemNo || '').toUpperCase().startsWith('ADH'));
        const _hasBatchManaged = _allMats.some(m => {
            if (!m || !m.batchManaged) return false;
            return true;
        });
        const _needsMaterialFlow = _hasBatchManaged || _hasADH;
        console.log('📦 Material check on load:', {
            totalMats: _allMats.length,
            items: _allMats.map(m => `${m?.itemNo}(batch=${m?.batchManaged})`),
            hasBatchManaged: _hasBatchManaged,
            hasADH: _hasADH
        });
        if (_needsMaterialFlow) {
            currentJob._materialIssuePending = true;
            console.log('🔒 _materialIssuePending = true — Running blocked until materials are issued');
        }
        
        console.log('Current job set:', currentJob);

        // Live tracking: record loaded job + load time
        if (typeof LiveTracking !== 'undefined') {
            LiveTracking.jobLoad({
                po: currentJob.jobNumber,
                jobName: currentJob.jobName,
                fgNum: currentJob.fgItemCode,
                plannedQty: currentJob.plannedQuantity
            });
        }

        // Assembly: do not show/save the loaded job until all material issue popups are completed.
        if (isAssemblyMachine()) {
            clearAssemblyForm();
            setAssemblyWorkflowVisible(false);
            showLoading(false);

            try {
                await runMaterialIssueAndStartRunning();
            } catch (e) {
                console.error('Assembly material issue after load failed:', e);
                showToast(e?.message || 'Material issue failed', 'error');
            }

            if (!currentJob || currentJob._materialIssuePending) {
                currentJob = null;
                currentState = null;
                stateStartTimestamp = null;
                jobStartTimestamp = null;
                stateTimers = { running: 0, downtime_mech: 0, downtime_elec: 0, lunch: 0 };
                clearAssemblyForm();
                setAssemblyWorkflowVisible(false);
                clearStateStorage();
                displayJobDetails();
                updateControlButtons();
                showToast('Job not loaded. Please issue all materials first.', 'error');
                return;
            }

            currentState = null;
            stateStartTimestamp = null;
            jobStartTimestamp = Date.now();
            stateTimers = { running: 0, downtime_mech: 0, downtime_elec: 0, lunch: 0 };
            setDefaultAssemblyTimes();

            displayJobDetails();
            poInput.value = '';
            setAssemblyWorkflowVisible(true);
            saveStateToStorage();
            updateControlButtons();
            updateJobStatus();
            showToast('Job loaded successfully', 'success');
            return;
        }
        
        // Display job details
        displayJobDetails();
        
        // Clear input
        poInput.value = '';
        
        // Save state
        saveStateToStorage();
        
        showToast('Job loaded successfully', 'success');
        
        showLoading(false);

        // Full Load Job flow:
        // 1) Operator is captured ONCE per shift at page login — only prompt
        //    here in the rare case it's still missing.
        // 2) Material issue popups (if any batch-managed materials)
        // 3) Auto-start running timer (frontend only, no SAP)
        if (!currentOperator) {
            await ensureOperatorForShift();
        }

        try {
            await runMaterialIssueAndStartRunning();
        } catch (e) {
            console.error('Material issue after load failed:', e);
            showToast(e?.message || 'Material issue failed', 'error');
        }
        return;
        
    } catch (error) {
        console.error('Error loading job:', error);
        showToast(error.message || 'Failed to load job', 'error');
    }
    
    showLoading(false);
}

function displayJobDetails() {
    if (!currentJob) {
        document.getElementById('job-empty-state').style.display = 'flex';
        document.getElementById('job-content').style.display = 'none';
        if (isAssemblyMachine()) {
            setAssemblyWorkflowVisible(false);
            clearAssemblyForm();
        }
        return;
    }
    
    document.getElementById('job-empty-state').style.display = 'none';
    document.getElementById('job-content').style.display = 'block';
    
    document.getElementById('job-number').textContent = currentJob.jobNumber || '--';
    document.getElementById('job-name').textContent = currentJob.jobName || '--';
    document.getElementById('job-planned').textContent = formatNumber(currentJob.plannedQuantity);
    
    // For DIE/EMB+P: convert issued (sheets) → cartons for display so that
    // Issued / Done / Remaining are comparable units on the job card.
    const needsDivision = shouldApplyBaseQuantityDivisionForManualJob(currentJob);
    const baseQuantities = currentJob.baseQuantities || currentJob.rawData?.baseQuantities || [];
    const issuedQtyDisplay = needsDivision
        ? convertIssuedSheetsToCartons(currentJob.issuedQuantity || 0, baseQuantities)
        : (currentJob.issuedQuantity || 0);
    const completedQtyDisplay = currentJob.completedQuantity || 0;
    const remaining = Math.max(0, issuedQtyDisplay - completedQtyDisplay);

    document.getElementById('job-issued').textContent = formatNumber(issuedQtyDisplay);
    document.getElementById('job-done').textContent = formatNumber(completedQtyDisplay);
    document.getElementById('job-remaining').textContent = formatNumber(remaining);
    
    updateJobStatus();
    
    console.log('Job details displayed:', {
        number: currentJob.jobNumber,
        name: currentJob.jobName,
        planned: currentJob.plannedQuantity,
        issued_raw: currentJob.issuedQuantity,
        done: currentJob.completedQuantity,
        issued_display: issuedQtyDisplay,
        remaining: remaining,
        uPCode: currentJob.uPCode || currentJob.rawData?.uPCode || '',
        baseQuantitiesCount: Array.isArray(baseQuantities) ? baseQuantities.length : 0
    });
}

function updateJobStatus() {
    const statusEl = document.getElementById('job-status');
    
    if (!currentState) {
        statusEl.textContent = 'Loaded';
        statusEl.className = 'job-status';
    } else if (currentState === 'running') {
        statusEl.textContent = 'Running';
        statusEl.className = 'job-status running';
    } else if (currentState.includes('downtime')) {
        statusEl.textContent = 'Breakdown';
        statusEl.className = 'job-status breakdown';
    } else if (currentState === 'lunch') {
        statusEl.textContent = 'Lunch Break';
        statusEl.className = 'job-status lunch';
    }
}

// ==================== State Management ====================
function handleStateChange(newState) {
    // Validate job is loaded for running state
    if (newState === 'running' && !currentJob) {
        showToast('Please load a job first', 'error');
        return;
    }

    // Block running if materials haven't been issued yet
    if (newState === 'running' && currentJob && currentJob._materialIssuePending) {
        showToast('Materials must be issued before starting the job.\nPlease reload the job to complete material issue.', 'error');
        return;
    }
    
    // Same state: still refresh UI (fixes label/timer desync if session was inconsistent)
    if (currentState === newState) {
        updateControlButtons();
        updateJobStatus();
        updateTimerDisplay();
        return;
    }
    
    // Save time for previous state
    if (currentState && stateStartTimestamp) {
        const elapsed = Math.floor((Date.now() - stateStartTimestamp) / 1000);
        stateTimers[currentState] = (stateTimers[currentState] || 0) + elapsed;
    }
    
    // Record job start time on first state change
    if (!jobStartTimestamp) {
        jobStartTimestamp = Date.now();
        console.log(`📍 Job started at: ${new Date(jobStartTimestamp).toISOString()}`);
    }
    
    // Set new state
    currentState = newState;
    stateStartTimestamp = Date.now();
    
    // Update UI
    updateControlButtons();
    updateJobStatus();
    updateTimerDisplay();
    
    // Save state
    saveStateToStorage();

    // Live tracking: record state change (start time captured server-side)
    if (typeof LiveTracking !== 'undefined') {
        LiveTracking.setState(newState);
    }
    
    console.log(`📍 State changed to: ${newState}`);
}

function updateStartButtonLabel() {
    const running = currentState === 'running';
    const text = running ? 'Running' : 'Start';
    const label = document.getElementById('btn-start-label') || document.querySelector('#btn-start .btn-label');
    if (label) label.textContent = text;
    const btn = document.getElementById('btn-start');
    if (btn) {
        btn.setAttribute('aria-label', text);
        btn.setAttribute('title', text);
        btn.dataset.running = running ? 'true' : 'false';
    }
}

function updateControlButtons() {
    // Remove active from all
    document.querySelectorAll('.control-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Add active to current state button
    if (currentState === 'running') {
        document.getElementById('btn-start').classList.add('active');
    } else if (currentState === 'downtime_mech' || currentState === 'downtime_elec') {
        document.getElementById('btn-breakdown').classList.add('active');
    } else if (currentState === 'lunch') {
        document.getElementById('btn-lunch').classList.add('active');
    }
    updateStartButtonLabel();
}

// ==================== Timer ====================
function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    
    timerInterval = setInterval(() => {
        updateTimerDisplay();
        updateShiftInfoDisplay();
    }, 1000);
}

function updateTimerDisplay() {
    let seconds = 0;
    
    if (currentState && stateStartTimestamp) {
        const elapsed = Math.floor((Date.now() - stateStartTimestamp) / 1000);
        seconds = (stateTimers[currentState] || 0) + elapsed;
    }
    
    document.getElementById('timer-display').textContent = formatTime(seconds);
    
    // Update state label
    const stateLabel = document.getElementById('current-state-label');
    if (!currentState) {
        stateLabel.textContent = 'Not Started';
    } else if (currentState === 'running') {
        stateLabel.textContent = 'Running';
    } else if (currentState === 'downtime_mech') {
        stateLabel.textContent = 'Mechanical Breakdown';
    } else if (currentState === 'downtime_elec') {
        stateLabel.textContent = 'Electrical Breakdown';
    } else if (currentState === 'lunch') {
        stateLabel.textContent = 'Lunch Break';
    }
}

function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatNumber(num) {
    if (num === null || num === undefined) return '-';
    return num.toLocaleString();
}

// Format datetime for MySQL (IST timezone)
function formatMySQLDateTime(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    // Add 5:30 hours for IST
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffset);
    
    const year = istDate.getUTCFullYear();
    const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    const hours = String(istDate.getUTCHours()).padStart(2, '0');
    const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(istDate.getUTCSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ==================== Breakdown Modal ====================
function showBreakdownModal() {
    if (!currentJob) {
        showToast('Please load a job first', 'error');
        return;
    }
    
    document.getElementById('breakdown-reason').value = '';
    openModal('breakdown-modal');
}

function handleBreakdownSubmit(e) {
    e.preventDefault();
    
    const reason = document.getElementById('breakdown-reason').value.trim();
    if (!reason) {
        showToast('Please enter a breakdown reason', 'error');
        return;
    }
    
    // Change state to breakdown
    handleStateChange(breakdownType);
    
    // Create breakdown ticket (async, don't wait)
    createBreakdownTicket(reason);
    
    closeModal('breakdown-modal');
    showToast('Breakdown recorded', 'success');
}

async function createBreakdownTicket(reason) {
    try {
        const ticketData = {
            machine: MACHINE_NAMES[currentMachine] || currentMachine,
            breakdownType: breakdownType === 'downtime_elec' ? 'Electrical' : 'Mechanical',
            reason: reason,
            jobNumber: currentJob?.jobNumber || 'N/A',
            timestamp: new Date().toISOString()
        };
        
        await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.breakdownTicket}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ticketData)
        });
        
        console.log('📋 Breakdown ticket created');
    } catch (error) {
        console.error('Failed to create breakdown ticket:', error);
    }
}

// ==================== Operator Selection Modal ====================
function getOperatorListForMachine(machineName) {
    if (!machineName) return [];
    const normalizedName = machineName.toLowerCase().replace(/\s+/g, '-');
    return OPERATOR_LISTS[normalizedName] || [];
}

function showOperatorSelectionModal() {
    return new Promise((resolve) => {
        const operators = getOperatorListForMachine(currentMachine);
        const select = document.getElementById('operator-select');
        const otherGroup = document.getElementById('other-operator-group');
        const otherInput = document.getElementById('other-operator-input');
        
        // Populate dropdown
        select.innerHTML = '<option value="">-- Select Operator --</option>';
        operators.forEach(op => {
            const option = document.createElement('option');
            option.value = op;
            option.textContent = op;
            select.appendChild(option);
        });
        // Add "Other" option
        const otherOption = document.createElement('option');
        otherOption.value = 'other';
        otherOption.textContent = 'Other (Enter manually)';
        select.appendChild(otherOption);
        
        // Reset state
        select.value = '';
        otherInput.value = '';
        otherGroup.style.display = 'none';
        
        // Handle dropdown change
        const handleSelectChange = () => {
            if (select.value === 'other') {
                otherGroup.style.display = 'block';
                otherInput.focus();
            } else {
                otherGroup.style.display = 'none';
            }
        };
        
        // Handle confirm
        const handleConfirm = () => {
            let operatorName = '';
            
            if (select.value === 'other') {
                operatorName = otherInput.value.trim();
                if (!operatorName) {
                    showToast('Please enter operator name', 'error');
                    return;
                }
            } else if (select.value) {
                operatorName = select.value;
            } else {
                showToast('Please select an operator', 'error');
                return;
            }
            
            currentOperator = operatorName;
            if (!shiftLoginAt) shiftLoginAt = Date.now();
            saveStateToStorage();
            saveOperatorForShift();
            closeModal('operator-modal');
            
            // Clean up listeners
            select.removeEventListener('change', handleSelectChange);
            confirmBtn.removeEventListener('click', handleConfirm);

            // Live tracking: record operator login (machine selected for shift)
            if (typeof LiveTracking !== 'undefined') {
                LiveTracking.login(operatorName);
            }

            updateShiftInfoDisplay();
            
            console.log('👤 Operator selected:', currentOperator);
            showToast(`Operator: ${currentOperator}`, 'success');
            resolve(operatorName);
        };
        
        const confirmBtn = document.getElementById('operator-confirm');
        select.addEventListener('change', handleSelectChange);
        confirmBtn.addEventListener('click', handleConfirm);
        
        openModal('operator-modal');
    });
}

// ==================== Finish Job ====================
function showFinishModal() {
    if (!currentJob) {
        showToast('No job to finish', 'error');
        return;
    }
    
    // Check if job has been started (has any recorded time)
    // Calculate total time including current state
    let totalTime = Object.values(stateTimers).reduce((a, b) => a + b, 0);
    if (currentState && stateStartTimestamp) {
        const elapsed = Math.floor((Date.now() - stateStartTimestamp) / 1000);
        totalTime += elapsed;
    }
    
    if (totalTime === 0 && !isAssemblyMachine()) {
        showToast('Please start the job first by pressing "Start"', 'error');
        return;
    }
    
    // Clear form
    document.getElementById('sheets-processed').value = '';
    document.getElementById('wasted-sheets').value = '';
    document.getElementById('finish-remarks').value = '';

    if (isWityMachine()) {
        const ids = ['wity-quantity', 'wity-length-mm', 'wity-width-mm', 'wity-mill', 'wity-grade', 'wity-gsm'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.tagName === 'SELECT') el.value = '';
            else el.value = '';
        });
    }

    if (typeof JumbledJob !== 'undefined' && currentJob) {
        JumbledJob.refreshJumbledFinishUI(currentJob, 0, {
            applyDieDivision: shouldApplyBaseQuantityDivisionForManualJob(currentJob)
        });
    }

    openModal('finish-modal');
}

function updateJumbledFGQuantities() {
    if (!currentJob || typeof JumbledJob === 'undefined') return;
    const sheets = parseInt(document.getElementById('sheets-processed')?.value, 10) || 0;
    JumbledJob.refreshJumbledFinishUI(currentJob, sheets, {
        applyDieDivision: shouldApplyBaseQuantityDivisionForManualJob(currentJob)
    });
}
window.updateJumbledFGQuantities = updateJumbledFGQuantities;

function handleFinishSubmit(e) {
    e.preventDefault();

    let sheetsProcessed = parseInt(document.getElementById('sheets-processed').value) || 0;
    let wastedSheets = parseInt(document.getElementById('wasted-sheets').value) || 0;
    const remarks = document.getElementById('finish-remarks').value.trim();

    if (isWityMachine()) {
        const wQty = parseInt(document.getElementById('wity-quantity')?.value) || 0;
        const wLen = parseFloat(document.getElementById('wity-length-mm')?.value) || 0;
        const wWid = parseFloat(document.getElementById('wity-width-mm')?.value) || 0;
        const wMill = document.getElementById('wity-mill')?.value || '';
        const wGrade = document.getElementById('wity-grade')?.value || '';
        const wGsm = parseInt(document.getElementById('wity-gsm')?.value) || 0;

        if (wQty <= 0) {
            showToast('Please enter quantity', 'error');
            return;
        }
        if (wLen <= 0) {
            showToast('Please enter length (mm)', 'error');
            return;
        }
        if (wWid <= 0) {
            showToast('Please enter width (mm)', 'error');
            return;
        }
        if (!wMill) {
            showToast('Please select mill', 'error');
            return;
        }
        if (!wGrade) {
            showToast('Please select grade', 'error');
            return;
        }
        if (!wGsm || wGsm <= 0) {
            showToast('Please enter GSM', 'error');
            return;
        }

        sheetsProcessed = wQty;
        wastedSheets = 0;

        const issuedQty = Number(currentJob?.issuedQuantity || 0);
        if (issuedQty <= 0) {
            showToast('Issued Quantity is 0 in SAP. Please issue first, then complete.', 'error');
            return;
        }
    } else if (sheetsProcessed <= 0) {
        showToast('Please enter quantity processed', 'error');
        return;
    }

    const isJumbled = typeof JumbledJob !== 'undefined' && JumbledJob.isJumbledJobFromData(currentJob);
    let fgLinesWithQty = [];

    if (!isLaminationMachine()) {
        const uPCode = (currentJob?.uPCode || currentJob?.rawData?.uPCode || '').toUpperCase();
        const baseQuantities = currentJob?.baseQuantities || currentJob?.rawData?.baseQuantities || [];
        const rawIssuedQty = currentJob?.issuedQuantity || 0;
        const completedQty = currentJob?.completedQuantity || 0;

        const plannedPositive = (currentJob?.plannedQuantity || currentJob?.rawData?.plannedQuantity || 0) > 0;
        const needsDivision = plannedPositive &&
            (uPCode.startsWith('DIE') || uPCode === 'EMB+P') &&
            Array.isArray(baseQuantities) && baseQuantities.length > 0;

        let headerCompletionQty = sheetsProcessed;
        if (needsDivision) {
            headerCompletionQty = calculateDieCuttingQuantityForSAPManual(sheetsProcessed, baseQuantities);
        }

        if (isJumbled) {
            fgLinesWithQty = JumbledJob.calculateFgLinesQuantities(
                sheetsProcessed,
                JumbledJob.getFgLinesFromJob(currentJob),
                { applyDieDivision: needsDivision }
            );
            const jumbledValidation = JumbledJob.validateJumbledCompletion(sheetsProcessed, fgLinesWithQty, {
                applyDieDivision: needsDivision,
                baseQuantities,
                issuedQuantity: rawIssuedQty,
                completedQuantity: completedQty,
                headerCompletionQty
            });
            if (!jumbledValidation.valid) {
                showToast(jumbledValidation.message, 'error');
                return;
            }
        } else if (needsDivision) {
            const issuedCartons = convertIssuedSheetsToCartons(rawIssuedQty, baseQuantities);
            const remainingCartons = issuedCartons - completedQty;
            const finalSAPQuantityCartons = calculateDieCuttingQuantityForSAPManual(sheetsProcessed, baseQuantities);

            console.log('📊 Manual DIE/EMB+P validation:', {
                uPCode,
                rawIssuedSheets: rawIssuedQty,
                issuedCartons,
                completedCartons: completedQty,
                remainingCartons,
                entrySheets: sheetsProcessed,
                entryCartons: finalSAPQuantityCartons,
            });

            if (!isJumbled && issuedCartons > 0 && finalSAPQuantityCartons > remainingCartons) {
                showToast(`Qty exceeds remaining (${Math.max(0, remainingCartons)}) cartons. Please reduce.`, 'error');
                return;
            }
        } else if (!isJumbled) {
            const remainingQty = Math.max(0, rawIssuedQty - completedQty);
            if (rawIssuedQty > 0 && sheetsProcessed > remainingQty) {
                showToast(`Qty exceeds remaining (${remainingQty}). Please reduce.`, 'error');
                return;
            }
        }
    }

    if (isLaminationMachine()) {
        laminationData = {};

        if (isNarendraMachine()) {
            laminationData.narendra = {
                anilox: document.getElementById('nar-anilox')?.value || '',
                rubberMm: parseFloat(document.getElementById('nar-rubber-mm')?.value) || 0,
                tunnelTemp: parseFloat(document.getElementById('nar-tunnel-temp')?.value) || 0,
                nipTemp: parseFloat(document.getElementById('nar-nip-temp')?.value) || 0
            };
        }

        if (isWityMachine()) {
            laminationData.wity = {
                quantity: parseInt(document.getElementById('wity-quantity')?.value) || 0,
                lengthMm: parseFloat(document.getElementById('wity-length-mm')?.value) || 0,
                widthMm: parseFloat(document.getElementById('wity-width-mm')?.value) || 0,
                mill: document.getElementById('wity-mill')?.value || '',
                grade: document.getElementById('wity-grade')?.value || '',
                gsm: parseInt(document.getElementById('wity-gsm')?.value) || 0
            };
        }
    }

    if (currentState && stateStartTimestamp) {
        const elapsed = Math.floor((Date.now() - stateStartTimestamp) / 1000);
        stateTimers[currentState] = (stateTimers[currentState] || 0) + elapsed;
    }

    pendingJobData = {
        sheetsProcessed,
        wastedSheets,
        remarks,
        timers: { ...stateTimers },
        laminationData: isLaminationMachine() ? { ...laminationData } : null,
        isJumbledJob: isJumbled,
        fgLines: isJumbled ? JumbledJob.getFgLinesFromJob(currentJob) : [],
        fgLinesWithQty: isJumbled ? fgLinesWithQty : []
    };

    closeModal('finish-modal');
    showSummaryModal();
}

function showSummaryModal() {
    document.getElementById('summary-job-number').textContent = currentJob.jobNumber;
    document.getElementById('summary-operator-name').textContent = currentOperator || '-';
    
    // Time breakdown
    document.getElementById('summary-running-time').value = formatTime(pendingJobData.timers.running || 0);
    document.getElementById('summary-breakdown-time').value = formatTime(
        (pendingJobData.timers.downtime_mech || 0) + (pendingJobData.timers.downtime_elec || 0)
    );
    document.getElementById('summary-lunch-time').value = formatTime(pendingJobData.timers.lunch || 0);
    
    const totalTime = Object.values(pendingJobData.timers).reduce((a, b) => a + b, 0);
    document.getElementById('summary-total-time').textContent = formatTime(totalTime);
    
    document.getElementById('summary-qty-processed').textContent = formatNumber(pendingJobData.sheetsProcessed);
    document.getElementById('summary-wasted').textContent = formatNumber(pendingJobData.wastedSheets);

    if (pendingJobData.isJumbledJob && typeof JumbledJob !== 'undefined') {
        const applyDie = shouldApplyBaseQuantityDivisionForManualJob(currentJob);
        pendingJobData.fgLinesWithQty = JumbledJob.calculateFgLinesQuantities(
            pendingJobData.sheetsProcessed,
            JumbledJob.getFgLinesFromJob(currentJob),
            { applyDieDivision: applyDie }
        );
        JumbledJob.refreshJumbledSummaryUI(pendingJobData.fgLinesWithQty);
    } else if (typeof JumbledJob !== 'undefined') {
        JumbledJob.refreshJumbledSummaryUI([]);
    }

    openModal('summary-modal');
}

function handleSummaryEdit() {
    closeModal('summary-modal');

    if (isAssemblyMachine()) {
        document.getElementById('assembly-sheets-processed').value = pendingJobData.sheetsProcessed;
        document.getElementById('assembly-wasted-sheets').value = pendingJobData.wastedSheets;
        document.getElementById('assembly-finish-remarks').value = pendingJobData.remarks || '';
        document.getElementById('assembly-operator-name').value = currentOperator || '';
        return;
    }

    openModal('finish-modal');

    document.getElementById('sheets-processed').value = pendingJobData.sheetsProcessed;
    document.getElementById('wasted-sheets').value = pendingJobData.wastedSheets;
    document.getElementById('finish-remarks').value = pendingJobData.remarks;

    if (pendingJobData.laminationData) {
        const ld = pendingJobData.laminationData;
        if (document.getElementById('nar-anilox')) document.getElementById('nar-anilox').value = ld.narendra?.anilox || '';
        if (document.getElementById('nar-rubber-mm')) document.getElementById('nar-rubber-mm').value = ld.narendra?.rubberMm || '';
        if (document.getElementById('nar-tunnel-temp')) document.getElementById('nar-tunnel-temp').value = ld.narendra?.tunnelTemp || '';
        if (document.getElementById('nar-nip-temp')) document.getElementById('nar-nip-temp').value = ld.narendra?.nipTemp || '';

        if (isWityMachine() && ld.wity) {
            const w = ld.wity;
            if (document.getElementById('wity-quantity')) document.getElementById('wity-quantity').value = w.quantity || '';
            if (document.getElementById('wity-length-mm')) document.getElementById('wity-length-mm').value = w.lengthMm || '';
            if (document.getElementById('wity-width-mm')) document.getElementById('wity-width-mm').value = w.widthMm || '';
            if (document.getElementById('wity-mill')) document.getElementById('wity-mill').value = w.mill || '';
            if (document.getElementById('wity-grade')) document.getElementById('wity-grade').value = w.grade || '';
            if (document.getElementById('wity-gsm')) document.getElementById('wity-gsm').value = w.gsm || '';
        }
    }
}

function buildRemarks() {
    let remarks = pendingJobData.remarks || '';

    if (pendingJobData.laminationData) {
        const ld = pendingJobData.laminationData;
        const lamParts = [];

        if (ld.board) lamParts.push(`Board: ${ld.board}`);
        if (ld.filmSize) lamParts.push(`Film: ${ld.filmSize}`);
        if (ld.anilox) lamParts.push(`Anilox: ${ld.anilox}`);
        if (ld.glue) lamParts.push(`Glue: ${ld.glue}`);
        if (ld.rubber) lamParts.push(`Rubber: ${ld.rubber}`);
        if (ld.diesel) lamParts.push(`Diesel: ${ld.diesel}`);
        if (ld.temperature) lamParts.push(`Temp: ${ld.temperature}`);
        if (ld.coatingCode) lamParts.push(`Coating: ${ld.coatingCode}`);
        if (ld.narendra) {
            const n = ld.narendra;
            if (n.anilox) lamParts.push(`Anilox: ${n.anilox}`);
            if (n.rubberMm) lamParts.push(`Rubber: ${n.rubberMm}mm`);
            if (n.tunnelTemp) lamParts.push(`Tunnel Temp: ${n.tunnelTemp}`);
            if (n.nipTemp) lamParts.push(`Nip Temp: ${n.nipTemp}`);
        }

        if (ld.wity) {
            const w = ld.wity;
            const wParts = [];
            if (w.quantity) wParts.push(`Qty: ${w.quantity}`);
            if (w.lengthMm) wParts.push(`L: ${w.lengthMm}mm`);
            if (w.widthMm) wParts.push(`W: ${w.widthMm}mm`);
            if (w.mill) wParts.push(`Mill: ${w.mill}`);
            if (w.grade) wParts.push(`Grade: ${w.grade}`);
            if (w.gsm) wParts.push(`GSM: ${w.gsm}`);
            if (wParts.length) lamParts.push(`Wity: ${wParts.join(', ')}`);
        }

        if (lamParts.length > 0) {
            const lamRemarks = lamParts.join(' | ');
            remarks = remarks ? `${remarks} || LAM: ${lamRemarks}` : `LAM: ${lamRemarks}`;
        }
    }

    return remarks;
}

async function handleSummaryConfirm() {
    showLoading(true);
    
    try {
        // Build activities array - use activity_time_minutes to match server expectation
        const activities = [];
        
        console.log('📊 Timer values:', pendingJobData.timers);
        
        if (pendingJobData.timers.running > 0) {
            activities.push({
                activity_name: 'running',
                activity_time_minutes: pendingJobData.timers.running / 60
            });
        }
        
        if (pendingJobData.timers.downtime_mech > 0) {
            activities.push({
                activity_name: 'downtime_mech',
                activity_time_minutes: pendingJobData.timers.downtime_mech / 60
            });
        }
        
        if (pendingJobData.timers.downtime_elec > 0) {
            activities.push({
                activity_name: 'downtime_elec',
                activity_time_minutes: pendingJobData.timers.downtime_elec / 60
            });
        }
        
        if (pendingJobData.timers.lunch > 0) {
            activities.push({
                activity_name: 'lunch',
                activity_time_minutes: pendingJobData.timers.lunch / 60
            });
        }
        
        // If no activities recorded but we have total time, add it as running time
        // This handles edge cases where timer tracking might have issues
        if (activities.length === 0) {
            const totalSeconds = Object.values(pendingJobData.timers).reduce((a, b) => a + b, 0);
            if (totalSeconds > 0) {
                activities.push({
                    activity_name: 'running',
                    activity_time_minutes: totalSeconds / 60
                });
                console.log('⚠️ No individual activities, using total time as running:', totalSeconds);
            } else if (isAssemblyMachine()) {
                // Assembly: allow completion without explicit start/end; send a minimal running time.
                activities.push({ activity_name: 'running', activity_time_minutes: 1 });
            } else {
                console.error('❌ No activity time recorded at all!');
                showToast('Error: No activity time recorded. Please start the job first.', 'error');
                showLoading(false);
                return;
            }
        }
        
        console.log('📤 Activities to send:', activities);
        
        // Calculate quantity_for_sap (matches data-entry.js logic):
        // - For U_PCode = DIE or EMB+P and baseQuantities exist: convert sheets -> cartons.
        // - Otherwise: send the entered quantity as-is.
        //
        // NOTE: Manual-machine flow does not apply a separate UPs multiplication here;
        // the DIE/EMB+P carton conversion comes from baseQuantities.
        let quantityForSAP = pendingJobData.sheetsProcessed;
        const uPCode = (currentJob?.uPCode || currentJob?.rawData?.uPCode || '').toUpperCase();
        const baseQuantities = currentJob?.baseQuantities || currentJob?.rawData?.baseQuantities || [];

        if ((uPCode.startsWith('DIE') || uPCode === 'EMB+P') && Array.isArray(baseQuantities) && baseQuantities.length > 0) {
            quantityForSAP = calculateDieCuttingQuantityForSAPManual(pendingJobData.sheetsProcessed, baseQuantities);
            console.log(`📊 Manual DIE/EMB+P: ${pendingJobData.sheetsProcessed} sheets ÷ baseQuantities ${JSON.stringify(baseQuantities)} = ${quantityForSAP} cartons for SAP`);
        }
        
        // Use actual job start time and current time as end time
        // Format as MySQL datetime (YYYY-MM-DD HH:MM:SS) in IST
        const jobEndTime = formatMySQLDateTime(pendingJobData.assemblyEndTimestamp || Date.now());
        const jobStartTime = formatMySQLDateTime(pendingJobData.assemblyStartTimestamp || jobStartTimestamp || Date.now());
        
        console.log('⏰ Job times:');
        console.log('   jobStartTimestamp:', jobStartTimestamp, jobStartTimestamp ? new Date(jobStartTimestamp).toISOString() : 'null');
        console.log('   jobStartTime (MySQL):', jobStartTime);
        console.log('   jobEndTime (MySQL):', jobEndTime);
        
        // Build request payload - match the format expected by /api/job-complete
        // Using exact same structure as data-entry.js which works
        const processName = isAssemblyMachine()
            ? 'RIGID Assembly'
            : (isRigidMachine() ? 'RIGID' : (isLaminationMachine() ? 'Lamination' : 'DieCutting'));
        
        const payload = {
            jobData: {
                po_num: currentJob.jobNumber,
                fg_num: currentJob.fgItemCode || '',
                job_name: currentJob.jobName || '',
                operator_name: currentOperator || 'Manual Entry',
                shift_type: getCurrentShift(),
                machine_name: getMachineIdForApi(),
                process_name: processName,
                planned_qty: currentJob.plannedQuantity || 0,
                job_start_time: jobStartTime,
                job_end_time: jobEndTime,
                quantity_processed: pendingJobData.sheetsProcessed,
                quantity_for_sap: quantityForSAP,
                sheets_wasted: pendingJobData.wastedSheets,
                remark: buildRemarks(),
                device_id: `manual-${currentMachine}`,
                absolute_entry: currentJob.rawData?.absoluteEntry || currentJob.rawData?.AbsoluteEntry || null,
                // Skip extra SAP GET on job-complete when auto-issue needs U_JobEnt / U_PCode
                u_job_ent: currentJob.rawData?.uJobEnt ?? null,
                u_p_code: getEffectiveUPCodeForMachine(),
                packing_details: '',
                lam_material_codes: currentJob.lamMaterialCodes || null,
                is_jumbled_job: !!(pendingJobData?.isJumbledJob && pendingJobData?.fgLinesWithQty?.length > 1),
                fg_lines: (pendingJobData?.isJumbledJob && pendingJobData?.fgLinesWithQty?.length > 1 && typeof JumbledJob !== 'undefined')
                    ? JumbledJob.buildFgLinesPayload(pendingJobData.fgLinesWithQty)
                    : null,
                U_Length: isWityMachine() ? (pendingJobData?.laminationData?.wity?.lengthMm || 0) : undefined,
                U_Width: isWityMachine() ? (pendingJobData?.laminationData?.wity?.widthMm || 0) : undefined,
                U_MILL: isWityMachine() ? (pendingJobData?.laminationData?.wity?.mill || '') : undefined,
                U_GRADE: isWityMachine() ? (pendingJobData?.laminationData?.wity?.grade || '') : undefined,
                U_GSM: isWityMachine() ? (pendingJobData?.laminationData?.wity?.gsm || 0) : undefined
            },
            activities: activities
        };
        
        console.log('📤 Full payload:', JSON.stringify(payload, null, 2));
        
        const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.jobComplete}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        console.log('📥 Server response:', result);
        
        if (!response.ok || !result.success) {
            const errorMsg = result.message || result.error || 'Failed to submit job';
            console.error('❌ Server error details:', result);
            throw new Error(errorMsg);
        }
        
        console.log('✅ Job completed successfully:', result);

        // Live tracking: job finished -> clear loaded job (machine returns to idle)
        if (typeof LiveTracking !== 'undefined') {
            LiveTracking.jobUnload();
        }

        // If backend detected a jumbled job, surface auto-issue summary (non-blocking)
        if (result && result.autoIssue && result.autoIssue.isJumbledJob) {
            const total = Number(result.autoIssue.totalFGItems || 0);
            const ok = Number(result.autoIssue.successfulIssues || 0);
            const msg = `Jumbled job: auto-issue ${ok}/${total} item(s).`;
            showToast(msg, ok === total ? 'success' : 'error');
            if (typeof JumbledJob !== 'undefined') {
                JumbledJob.displayJumbledJobResults(result.autoIssue);
            }
        }
        
        // Reset state
        resetJobState();
        
        closeModal('summary-modal');
        
        // Show machine selection popup (operator stays on shift info bar)
        openModal('machine-select-modal');
        
    } catch (error) {
        console.error('Error submitting job:', error);
        showToast(error.message || 'Failed to submit job', 'error');
    }
    
    showLoading(false);
}

function getCurrentShift() {
    const hour = new Date().getHours();
    // Day shift: 9AM-8PM, Night shift: 8PM-9AM (matching data-entry.js)
    if (hour >= 9 && hour < 20) {
        return 'day';
    }
    return 'night';
}

// ==================== Per-Shift Operator (login once per shift) ====================
function getOperatorShiftKey() {
    return `${STORAGE_KEY_BASE}_operator_${currentMachine}`;
}

function saveOperatorForShift() {
    try {
        localStorage.setItem(getOperatorShiftKey(), JSON.stringify({
            operator: currentOperator,
            shift: getCurrentShift(),
            shiftDate: new Date().toISOString().split('T')[0],
            loginAt: shiftLoginAt
        }));
    } catch (e) {
        console.error('Failed to save shift operator:', e);
    }
}

// Returns true if a valid operator for the CURRENT shift/date was restored.
function loadOperatorForShift() {
    try {
        const saved = localStorage.getItem(getOperatorShiftKey());
        if (!saved) return false;
        const data = JSON.parse(saved);
        const today = new Date().toISOString().split('T')[0];
        if (data.operator && data.shift === getCurrentShift() && data.shiftDate === today) {
            currentOperator = data.operator;
            shiftLoginAt = data.loginAt || Date.now();
            return true;
        }
        // Stored operator belongs to a previous shift/day -> clear it.
        localStorage.removeItem(getOperatorShiftKey());
        return false;
    } catch (e) {
        return false;
    }
}

function clearOperatorForShift() {
    currentOperator = null;
    shiftLoginAt = null;
    try {
        localStorage.removeItem(getOperatorShiftKey());
    } catch (e) { /* ignore */ }
}

// Capture the operator once per shift. Called on page open and (defensively)
// before a job load if somehow no operator is set.
async function ensureOperatorForShift() {
    if (isAssemblyMachine()) {
        // Assembly captures the operator on the on-screen form per job.
        updateShiftInfoDisplay();
        return;
    }

    // Prefer the dedicated per-shift operator store.
    const restored = loadOperatorForShift();

    // A job may have been restored with an operator but no shift store yet.
    if (!restored && currentOperator && !shiftLoginAt) {
        shiftLoginAt = jobStartTimestamp || Date.now();
        saveOperatorForShift();
    }

    if (!currentOperator) {
        // First login of the shift on this machine.
        await showOperatorSelectionModal();
    } else if (typeof LiveTracking !== 'undefined') {
        // Re-mark the machine online for the shift (reuses the existing session).
        LiveTracking.login(currentOperator);
    }

    updateShiftInfoDisplay();
}

function formatClockTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Update the shift info bar (shift, operator, login time, running shift timer).
function updateShiftInfoDisplay() {
    const shift = getCurrentShift();
    const shiftEl = document.getElementById('si-shift');
    const opEl = document.getElementById('si-operator');
    const loginEl = document.getElementById('si-login-at');
    const timerEl = document.getElementById('si-shift-timer');

    if (shiftEl) shiftEl.textContent = shift === 'day' ? 'Day (9AM–8PM)' : 'Night (8PM–9AM)';
    if (opEl) opEl.textContent = currentOperator || '-';
    if (loginEl) loginEl.textContent = shiftLoginAt ? formatClockTime(shiftLoginAt) : '-';
    if (timerEl) {
        timerEl.textContent = shiftLoginAt
            ? formatTime(Math.floor((Date.now() - shiftLoginAt) / 1000))
            : '00:00:00';
    }
}

// ==================== Shift Logout (End Shift) ====================
async function handleShiftLogout() {
    if (!currentOperator) {
        showToast('No operator is logged in on this machine.', 'error');
        return;
    }
    const ok = confirm(`End shift and log out operator "${currentOperator}"?\n\nLogout time will be recorded.`);
    if (!ok) return;

    if (typeof LiveTracking !== 'undefined') {
        await LiveTracking.logout('manual');
    }

    clearOperatorForShift();
    saveStateToStorage();
    updateShiftInfoDisplay();
    showToast('Shift ended. Operator logged out.', 'success');
}

function resetJobState() {
    currentJob = null;
    currentState = null;
    // NOTE: currentOperator is intentionally preserved — the operator stays
    // logged in for the whole shift across multiple jobs. It is only cleared
    // on End Shift (handleShiftLogout) or when the shift changes.
    stateStartTimestamp = null;
    jobStartTimestamp = null;
    stateTimers = {
        running: 0,
        downtime_mech: 0,
        downtime_elec: 0,
        lunch: 0
    };
    pendingJobData = null;
    laminationData = {};

    // Update UI
    displayJobDetails();
    updateControlButtons();
    updateTimerDisplay();
    updateShiftInfoDisplay();

    // Clear job snapshot only — keep operator logged in for the shift
    try {
        localStorage.removeItem(getStorageKey());
    } catch (e) { /* ignore */ }
    saveOperatorForShift();
    saveStateToStorage();
}

// ==================== Storage ====================
function getStorageKey() {
    return `${STORAGE_KEY_BASE}_${currentMachine}`;
}

function saveStateToStorage() {
    const state = {
        currentJob,
        currentState,
        currentOperator,
        stateStartTimestamp,
        jobStartTimestamp,
        stateTimers,
        savedAt: Date.now()
    };
    
    try {
        localStorage.setItem(getStorageKey(), JSON.stringify(state));
        console.log('💾 State saved');
    } catch (e) {
        console.error('Failed to save state:', e);
    }
}

function loadStateFromStorage() {
    try {
        const saved = localStorage.getItem(getStorageKey());
        if (!saved) return;
        
        const state = JSON.parse(saved);
        
        // Check if state is recent (within 24 hours)
        if (Date.now() - state.savedAt > 24 * 60 * 60 * 1000) {
            clearStateStorage();
            return;
        }
        
        currentJob = state.currentJob;
        currentState = state.currentState;
        currentOperator = state.currentOperator;
        stateStartTimestamp = state.stateStartTimestamp;
        jobStartTimestamp = state.jobStartTimestamp;
        stateTimers = state.stateTimers || {};
        
        // If jobStartTimestamp is missing (old data), calculate it from stateStartTimestamp and timers
        if (!jobStartTimestamp && stateStartTimestamp) {
            const totalPreviousTime = Object.values(stateTimers).reduce((a, b) => a + b, 0) * 1000;
            jobStartTimestamp = stateStartTimestamp - totalPreviousTime;
            console.log('📍 Calculated jobStartTimestamp from existing data:', new Date(jobStartTimestamp).toISOString());
        }
        
        // Update UI
        displayJobDetails();
        updateControlButtons();

        if (isAssemblyMachine() && currentJob) {
            setAssemblyWorkflowVisible(true);
            const opEl = document.getElementById('assembly-operator-name');
            if (opEl && currentOperator) opEl.value = currentOperator;
            setDefaultAssemblyTimes();
        }
        
        console.log('🔄 State restored from storage');
        if (jobStartTimestamp) {
            console.log('   Job started at:', new Date(jobStartTimestamp).toISOString());
        }
        
    } catch (e) {
        console.error('Failed to load state:', e);
    }
}

function clearStateStorage() {
    localStorage.removeItem(getStorageKey());
    console.log('🗑️ State cleared');
}

// ==================== UI Helpers ====================
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (show) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

function showToast(message, type = 'success') {
    if (type === 'error') {
        showErrorPopup(message);
        return;
    }
    const toast = document.getElementById('toast');
    const icon = toast.querySelector('.toast-icon');
    const msg = toast.querySelector('.toast-message');
    
    icon.textContent = '✅';
    msg.textContent = message;
    
    toast.className = `toast ${type}`;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function showErrorPopup(message) {
    const existing = document.getElementById('error-popup-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'error-popup-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e2e;border:2px solid #ef4444;border-radius:16px;padding:28px 24px;max-width:420px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(239,68,68,0.3);';

    const icon = document.createElement('div');
    icon.textContent = '❌';
    icon.style.cssText = 'font-size:2.5rem;margin-bottom:12px;';

    const title = document.createElement('div');
    title.textContent = 'Error';
    title.style.cssText = 'font-size:1.3rem;font-weight:700;color:#ef4444;margin-bottom:12px;';

    const msg = document.createElement('div');
    msg.style.cssText = 'color:#e2e8f0;font-size:1rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin-bottom:20px;';
    msg.textContent = message;

    const btn = document.createElement('button');
    btn.textContent = 'OK';
    btn.style.cssText = 'background:#ef4444;color:#fff;border:none;border-radius:10px;padding:12px 48px;font-size:1.1rem;font-weight:700;cursor:pointer;';
    btn.onclick = () => overlay.remove();

    box.append(icon, title, msg, btn);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    btn.focus();
}
