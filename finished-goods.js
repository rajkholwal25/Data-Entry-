// Finished Goods Entry - JavaScript
// Handles PO search, form validation, submission to SAP/MySQL, and label printing

// API Configuration
const API_BASE_URL = `${window.location.protocol}//${window.location.host}/api`;

// Current job data
let currentJobData = null;
let currentInventoryUOM = '';

// Last submitted entry data (for label printing)
let lastSubmittedEntry = null;

// QC Supervisor list
const QC_SUPERVISORS = [
    'Amit',
    'Aakash',
    'Jagdish',
    'Mukesh'
];

function extractFirstName(fullName) {
    const s = (fullName || '').toString().trim();
    if (!s) return '';
    return s.split(/\s+/)[0];
}

/** Label Operator field: "SupervisorFirst/OperatorFirst" */
function formatLabelOperatorField(supervisorName, operatorName) {
    const supFirst = extractFirstName(supervisorName);
    const opFirst = extractFirstName(operatorName);
    if (supFirst && opFirst) return `${supFirst}/${opFirst}`;
    return supFirst || opFirst || '';
}

// DOM Elements
const elements = {
    poSearchInput: null,
    poSearchBtn: null,
    loadingSection: null,
    errorSection: null,
    errorMessage: null,
    retryBtn: null,
    jobSection: null,
    successSection: null,
    successDetails: null,
    newEntryBtn: null,
    printLabelsBtn: null,
    labelCount: null,
    fgEntryForm: null,
    clearFormBtn: null,
    submitBtn: null,
    confirmModal: null,
    confirmModalBody: null,
    cancelSubmitBtn: null,
    confirmSubmitBtn: null,
    qcSupervisorSelect: null,
    otherQcGroup: null,
    otherQcInput: null,
    currentTime: null,
    labelPrintContainer: null,
    labelPreviewModal: null,
    labelPreviewHint: null,
    labelPreviewHost: null,
    labelPreviewSkipBtn: null,
    labelPreviewBrowserPrintBtn: null,
    labelPreviewPrintBtn: null,
    labelPrintStatusExtra: null
};

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
    initializeElements();
    setupEventListeners();
    startClock();
    
    // Focus on search input
    if (elements.poSearchInput) {
        elements.poSearchInput.focus();
    }
});

// Initialize DOM element references
function initializeElements() {
    elements.poSearchInput = document.getElementById('po-search-input');
    elements.poSearchBtn = document.getElementById('po-search-btn');
    elements.loadingSection = document.getElementById('loading-section');
    elements.errorSection = document.getElementById('error-section');
    elements.errorMessage = document.getElementById('error-message');
    elements.retryBtn = document.getElementById('retry-btn');
    elements.jobSection = document.getElementById('job-section');
    elements.successSection = document.getElementById('success-section');
    elements.successDetails = document.getElementById('success-details');
    elements.newEntryBtn = document.getElementById('new-entry-btn');
    elements.printLabelsBtn = document.getElementById('print-labels-btn');
    elements.labelCount = document.getElementById('label-count');
    elements.fgEntryForm = document.getElementById('fg-entry-form');
    elements.clearFormBtn = document.getElementById('clear-form-btn');
    elements.submitBtn = document.getElementById('submit-btn');
    elements.confirmModal = document.getElementById('confirm-modal');
    elements.confirmModalBody = document.getElementById('confirm-modal-body');
    elements.cancelSubmitBtn = document.getElementById('cancel-submit-btn');
    elements.confirmSubmitBtn = document.getElementById('confirm-submit-btn');
    elements.qcSupervisorSelect = document.getElementById('qc-supervisor');
    elements.otherQcGroup = document.getElementById('other-qc-group');
    elements.otherQcInput = document.getElementById('other-qc-supervisor');
    elements.currentTime = document.getElementById('current-time');
    elements.labelPrintContainer = document.getElementById('label-print-container');
    elements.labelPreviewModal = document.getElementById('label-preview-modal');
    elements.labelPreviewHint = document.getElementById('label-preview-hint');
    elements.labelPreviewHost = document.getElementById('label-preview-host');
    elements.labelPreviewSkipBtn = document.getElementById('label-preview-skip-btn');
    elements.labelPreviewBrowserPrintBtn = document.getElementById('label-preview-browser-print-btn');
    elements.labelPreviewPrintBtn = document.getElementById('label-preview-print-btn');
    elements.labelPrintStatusExtra = document.getElementById('label-print-status-extra');
    elements.previewSlipBtn = document.getElementById('preview-slip-btn');
}

// Setup event listeners
function setupEventListeners() {
    // Search functionality
    if (elements.poSearchBtn) {
        elements.poSearchBtn.addEventListener('click', handleSearch);
    }
    
    if (elements.poSearchInput) {
        elements.poSearchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleSearch();
            }
        });
    }
    
    // Retry button
    if (elements.retryBtn) {
        elements.retryBtn.addEventListener('click', handleSearch);
    }
    
    // Form submission
    if (elements.fgEntryForm) {
        elements.fgEntryForm.addEventListener('submit', handleFormSubmit);
    }
    
    // Clear form button
    if (elements.clearFormBtn) {
        elements.clearFormBtn.addEventListener('click', clearForm);
    }

    if (elements.previewSlipBtn) {
        elements.previewSlipBtn.addEventListener('click', handlePreviewPackingSlip);
    }
    
    // QC Supervisor "Other" option
    if (elements.qcSupervisorSelect) {
        elements.qcSupervisorSelect.addEventListener('change', handleQcSupervisorChange);
    }
    
    // Modal buttons
    if (elements.cancelSubmitBtn) {
        elements.cancelSubmitBtn.addEventListener('click', hideConfirmModal);
    }
    
    if (elements.confirmSubmitBtn) {
        elements.confirmSubmitBtn.addEventListener('click', confirmAndSubmit);
    }
    
    // New entry button
    if (elements.newEntryBtn) {
        elements.newEntryBtn.addEventListener('click', resetToSearch);
    }
    
    // Reprint / print on label printer (server PDF → CUPS → ZT411)
    if (elements.printLabelsBtn) {
        elements.printLabelsBtn.addEventListener('click', () => sendLabelsToPrinter({ fromReprint: true }));
    }

    // Label preview modal (optional flow)
    if (elements.labelPreviewSkipBtn) {
        elements.labelPreviewSkipBtn.addEventListener('click', hideLabelPreviewModal);
    }
    if (elements.labelPreviewBrowserPrintBtn) {
        elements.labelPreviewBrowserPrintBtn.addEventListener('click', () => {
            // Tablet/browser printing: render all labels into #label-print-container and open native print dialog
            try {
                printLabelsOnThisDevice();
            } finally {
                hideLabelPreviewModal();
            }
        });
    }
    if (elements.labelPreviewPrintBtn) {
        elements.labelPreviewPrintBtn.addEventListener('click', () => sendLabelsToPrinter({ fromPreview: true }));
    }
    // Rendered printing (PNG -> ZPL) is intentionally disabled because it degrades barcode quality.
    if (elements.labelPreviewModal) {
        elements.labelPreviewModal.addEventListener('click', (e) => {
            if (e.target === elements.labelPreviewModal) {
                hideLabelPreviewModal();
            }
        });
    }
    
    // Close modal on overlay click
    if (elements.confirmModal) {
        elements.confirmModal.addEventListener('click', (e) => {
            if (e.target === elements.confirmModal) {
                hideConfirmModal();
            }
        });
    }
}

// Start clock display
function startClock() {
    function updateClock() {
        const now = new Date();
        const options = {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        };
        if (elements.currentTime) {
            elements.currentTime.textContent = now.toLocaleTimeString('en-IN', options);
        }
    }
    
    updateClock();
    setInterval(updateClock, 1000);
}

// Handle PO search
async function handleSearch() {
    const poNumber = elements.poSearchInput?.value.trim();
    
    if (!poNumber) {
        alert('Please enter a PO Number');
        elements.poSearchInput?.focus();
        return;
    }
    
    // Show loading, hide other sections
    showSection('loading');
    
    try {
        const response = await fetch(`${API_BASE_URL}/production-order/${poNumber}?enrich=1`);
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || result.message || 'Failed to fetch production order');
        }
        
        if (!result.success || !result.data) {
            throw new Error('Production order not found');
        }
        
        // Store job data
        currentJobData = result.data;
        
        // Validate U_PCode - Only FG jobs allowed on Finished Goods page
        const uPCode = (currentJobData.uPCode || '').toUpperCase();
        if (uPCode !== 'FG') {
            throw new Error(`This page is only for Finished Goods (FG) jobs.\n\nThis job has process code "${currentJobData.uPCode || 'N/A'}" which should be processed on the appropriate machine first.`);
        }
        
        // Display job details
        displayJobDetails(currentJobData);
        
        // Show job section
        showSection('job');
        
    } catch (error) {
        console.error('Search error:', error);
        showError(error.message);
    }
}

function formatQty(qty) {
    return (Number(qty) || 0).toLocaleString();
}

function applyInventoryUomToFgUi(uom) {
    currentInventoryUOM = (uom || '').toString().trim();
    const unitLabel = currentInventoryUOM || 'Units';
    const unitSuffix = currentInventoryUOM ? ` (${currentInventoryUOM})` : '';

    const fgQtyLabel = document.getElementById('fg-quantity-label');
    const fgQtyHint = document.getElementById('fg-quantity-hint');
    if (fgQtyLabel) {
        fgQtyLabel.innerHTML = `<span class="label-icon">📦</span> FG Quantity (${unitLabel}) *`;
    }
    if (fgQtyHint) {
        fgQtyHint.textContent = currentInventoryUOM
            ? `Enter quantity in ${currentInventoryUOM} (same as planned)`
            : 'Enter quantity in the same unit as planned';
    }

    const qtyLabels = [
        ['planned-quantity-label', 'Planned Quantity'],
        ['issued-quantity-label', 'Issued Quantity'],
        ['completed-quantity-label', 'Completed Quantity'],
        ['remaining-quantity-label', 'Remaining Quantity']
    ];
    for (const [id, base] of qtyLabels) {
        const el = document.getElementById(id);
        if (el) el.textContent = `${base}${unitSuffix}`;
    }
}

// Display job details
function displayJobDetails(job) {
    // Update job info elements
    const jobNumberEl = document.getElementById('job-number');
    const customerNameEl = document.getElementById('customer-name');
    const fgCodeEl = document.getElementById('fg-code');
    const productDescEl = document.getElementById('product-description');
    const plannedQtyEl = document.getElementById('planned-quantity');
    const issuedQtyEl = document.getElementById('issued-quantity');
    const completedQtyEl = document.getElementById('completed-quantity');
    const remainingQtyEl = document.getElementById('remaining-quantity');
    const processCodeEl = document.getElementById('process-code');

    applyInventoryUomToFgUi(job.inventoryUOM);
    
    if (jobNumberEl) jobNumberEl.textContent = job.jobNumber || '-';
    const customerDisplay = (job.customerName || job.customerCode || '').toString().trim();
    if (customerNameEl) customerNameEl.textContent = customerDisplay || '-';
    if (fgCodeEl) fgCodeEl.textContent = job.itemNo || '-';
    if (productDescEl) productDescEl.textContent = job.jobName || '-';
    if (plannedQtyEl) plannedQtyEl.textContent = formatQty(job.plannedQuantity);
    if (issuedQtyEl) issuedQtyEl.textContent = formatQty(job.issuedQuantity);
    if (completedQtyEl) completedQtyEl.textContent = formatQty(job.completedQuantity);
    
    // Remaining = issued − already done (not planned − done)
    const issuedQty = job.issuedQuantity || 0;
    const completedQty = job.completedQuantity || 0;
    const remaining = Math.max(0, issuedQty - completedQty);
    if (remainingQtyEl) {
        remainingQtyEl.textContent = formatQty(remaining);
        // Show warning color if remaining is low or zero
        if (remaining <= 0) {
            remainingQtyEl.style.color = '#ef4444'; // Red
        } else {
            remainingQtyEl.style.color = ''; // Default warning color from CSS
        }
    }
    
    if (processCodeEl) processCodeEl.textContent = job.uPCode || '-';
}

// Handle QC Supervisor dropdown change
function handleQcSupervisorChange() {
    const selectedValue = elements.qcSupervisorSelect?.value;
    
    if (selectedValue === 'other') {
        if (elements.otherQcGroup) {
            elements.otherQcGroup.style.display = 'block';
        }
        if (elements.otherQcInput) {
            elements.otherQcInput.required = true;
            elements.otherQcInput.focus();
        }
    } else {
        if (elements.otherQcGroup) {
            elements.otherQcGroup.style.display = 'none';
        }
        if (elements.otherQcInput) {
            elements.otherQcInput.required = false;
            elements.otherQcInput.value = '';
        }
    }
}

// Handle form submission
function handleFormSubmit(e) {
    e.preventDefault();
    
    // Validate form
    const formData = getFormData();
    const validation = validateFormData(formData);
    
    if (!validation.valid) {
        alert(validation.message);
        return;
    }
    
    // Show confirmation modal
    showConfirmModal(formData);
}

// Get form data
function getFormData() {
    const fgQuantity = parseInt(document.getElementById('fg-quantity')?.value) || 0;
    const remarks = document.getElementById('remarks')?.value.trim() || '';
    const pkdDetails = document.getElementById('pkd-details')?.value.trim() || '';
    
    // Get QC Supervisor
    let qcSupervisor = elements.qcSupervisorSelect?.value || '';
    if (qcSupervisor === 'other') {
        qcSupervisor = elements.otherQcInput?.value.trim() || '';
    }
    
    return {
        fgQuantity,
        qcSupervisor,
        operatorName: document.getElementById('operator-name')?.value.trim() || '',
        remarks,
        pkdDetails
    };
}

// Validate form data
function validateFormData(data) {
    if (!data.fgQuantity || data.fgQuantity <= 0) {
        const uomHint = currentInventoryUOM ? ` (${currentInventoryUOM})` : '';
        return { valid: false, message: `Please enter a valid FG Quantity${uomHint}` };
    }
    
    if (!data.qcSupervisor) {
        return { valid: false, message: 'Please select a QC Supervisor' };
    }

    if (!data.operatorName || !data.operatorName.trim()) {
        return { valid: false, message: 'Please enter the operator name (shown on the label)' };
    }

    // ========== QUANTITY VALIDATION AGAINST REMAINING ==========
    // Same validation as data-entry: Check that FG quantity doesn't exceed (issuedQuantity - completedQuantity)
    if (currentJobData) {
        const issuedQty = currentJobData.issuedQuantity || 0;
        const completedQty = currentJobData.completedQuantity || 0;
        const plannedQty = currentJobData.plannedQuantity || 0;
        
        const remainingQty = Math.max(0, issuedQty - completedQty);
        
        console.log(`📊 FG Quantity Validation:`);
        console.log(`   Issued Qty: ${issuedQty}`);
        console.log(`   Completed Qty: ${completedQty}`);
        console.log(`   Remaining Qty: ${remainingQty}`);
        console.log(`   FG Entry Qty: ${data.fgQuantity}`);
        
        // Only validate if we have a positive remaining quantity to check against
        if (remainingQty > 0 && data.fgQuantity > remainingQty) {
            let errorMsg = `❌ Quantity Exceeds Remaining!\n\n`;
            
            if (issuedQty > 0) {
                errorMsg += `Issued Quantity: ${issuedQty.toLocaleString()}\n`;
            } else {
                errorMsg += `Planned Quantity: ${plannedQty.toLocaleString()}\n`;
            }
            errorMsg += `Already Completed: ${completedQty.toLocaleString()}\n`;
            errorMsg += `Remaining to Complete: ${remainingQty.toLocaleString()}\n\n`;
            errorMsg += `Your Entry: ${data.fgQuantity.toLocaleString()}\n\n`;
            errorMsg += `The FG quantity (${data.fgQuantity.toLocaleString()}) exceeds the remaining quantity (${remainingQty.toLocaleString()}).\n`;
            errorMsg += `Please reduce the FG quantity.`;
            
            return { valid: false, message: errorMsg };
        }
        
        // Warn if remaining is zero or negative
        if (remainingQty <= 0) {
            return { 
                valid: false, 
                message: `❌ No Remaining Quantity!\n\nIssued: ${issuedQty.toLocaleString()}\nCompleted: ${completedQty.toLocaleString()}\n\nAll quantity has already been completed for this job.`
            };
        }
    }
    
    return { valid: true };
}

// Show confirmation modal
function showConfirmModal(formData) {
    if (!elements.confirmModalBody || !elements.confirmModal) return;
    
    // Build confirmation HTML
    const confirmHTML = `
        <div class="confirm-item">
            <span class="confirm-label">PO Number</span>
            <span class="confirm-value highlight">${currentJobData?.jobNumber || '-'}</span>
        </div>
        <div class="confirm-item">
            <span class="confirm-label">FG Code</span>
            <span class="confirm-value">${currentJobData?.itemNo || '-'}</span>
        </div>
        <div class="confirm-item">
            <span class="confirm-label">Product</span>
            <span class="confirm-value">${currentJobData?.jobName || '-'}</span>
        </div>
        <div class="confirm-item">
            <span class="confirm-label">FG Quantity${currentInventoryUOM ? ` (${currentInventoryUOM})` : ''}</span>
            <span class="confirm-value highlight">${formatQty(formData.fgQuantity)}</span>
        </div>
        <div class="confirm-item">
            <span class="confirm-label">QC Supervisor</span>
            <span class="confirm-value">${formData.qcSupervisor}</span>
        </div>
        <div class="confirm-item">
            <span class="confirm-label">Operator</span>
            <span class="confirm-value">${formData.operatorName}</span>
        </div>
        ${formData.remarks ? `
        <div class="confirm-item">
            <span class="confirm-label">Remarks</span>
            <span class="confirm-value">${formData.remarks}</span>
        </div>
        ` : ''}
        ${formData.pkdDetails ? `
        <div class="confirm-item">
            <span class="confirm-label">PKD Details</span>
            <span class="confirm-value">${formData.pkdDetails}</span>
        </div>
        ` : ''}
    `;
    
    elements.confirmModalBody.innerHTML = confirmHTML;
    elements.confirmModal.style.display = 'flex';
}

// Hide confirmation modal
function hideConfirmModal() {
    if (elements.confirmModal) {
        elements.confirmModal.style.display = 'none';
    }
}

// Confirm and submit
async function confirmAndSubmit() {
    hideConfirmModal();
    
    const formData = getFormData();
    
    // Disable submit button
    if (elements.submitBtn) {
        elements.submitBtn.disabled = true;
        elements.submitBtn.innerHTML = '<span>⏳</span> Submitting...';
    }
    
    try {
        // Prepare payload for API
        const payload = {
            poNumber: currentJobData?.jobNumber,
            jobNo: currentJobData?.jobNo || currentJobData?.jobNumber,
            absoluteEntry: currentJobData?.absoluteEntry,
            itemCode: currentJobData?.itemNo,
            productDescription: currentJobData?.jobName,
            customerName: currentJobData?.customerName || '',
            customerCode: currentJobData?.customerCode || '',
            itemCodeLabel: currentJobData?.itemCodeLabel || '',
            plannedQuantity: currentJobData?.plannedQuantity || 0,
            completedQuantity: currentJobData?.completedQuantity || 0,
            fgQuantity: formData.fgQuantity,
            inventoryUOM: currentInventoryUOM || currentJobData?.inventoryUOM || '',
            qcSupervisor: formData.qcSupervisor,
            operatorName: formData.operatorName,
            remarks: formData.remarks,
            pkdDetails: formData.pkdDetails,
            entryTimestamp: new Date().toISOString()
        };
        
        console.log('📤 Submitting FG Entry:', payload);
        
        // Submit to API
        const response = await fetch(`${API_BASE_URL}/fg-entry`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || result.message || 'Failed to submit FG entry');
        }
        
        console.log('✅ FG Entry submitted successfully:', result);
        
        // Show success
        showSuccess(payload, result);
        
    } catch (error) {
        console.error('❌ Submission error:', error);
        alert(`Failed to submit FG entry: ${error.message}`);
        
        // Re-enable submit button
        if (elements.submitBtn) {
            elements.submitBtn.disabled = false;
            elements.submitBtn.innerHTML = '<span>✅</span> Submit FG Entry';
        }
    }
}

// Show success message
function showSuccess(payload, result) {
    const numLabels = result.labelsCount || 1;

    lastSubmittedEntry = {
        customerName: currentJobData?.customerName || '',
        customerCode: currentJobData?.customerCode || '',
        itemDescription: currentJobData?.jobName || '',
        fgCode: currentJobData?.itemNo || '',
        itemCodeLabel: currentJobData?.itemCodeLabel || '',
        jobNo: payload.jobNo,
        quantity: payload.fgQuantity,
        totalQuantity: payload.fgQuantity,
        inventoryUOM: payload.inventoryUOM || currentInventoryUOM || 'KGS',
        packedOn: formatDateForLabel(new Date()),
        operator: formatLabelOperatorField(payload.qcSupervisor, payload.operatorName),
        batchNo: result.batchNumber || '',
        numLabels
    };
    
    // Determine print status
    let printStatusHTML = '';
    if (result.printResult) {
        if (result.printResult.success) {
            printStatusHTML = `
                <div style="color: #22c55e; font-weight: bold;">
                    <strong>🖨️ Labels Printed:</strong> ${result.printResult.printed}/${result.printResult.total} ✅
                </div>
            `;
        } else if (result.printResult.previewPending) {
            printStatusHTML = `
                <div style="color: #38bdf8;">
                    <strong>🖨️ Label printer:</strong> Preview the layout, then send to Zebra or skip.
                </div>
            `;
        } else {
            printStatusHTML = `
                <div style="color: #f59e0b;">
                    <strong>🖨️ Auto-Print:</strong> ${result.printResult.message || 'Not available'}
                </div>
                <div style="font-size: 0.85em; color: #94a3b8;">Use "Reprint Labels" button for manual printing</div>
            `;
        }
    }

    // Show SAP posting status clearly (FG can be saved locally even if SAP posting fails)
    const sapOk = !!result.sapSuccess;
    const sapStatusHTML = sapOk
        ? `<div style="color:#22c55e; font-weight:700;"><strong>SAP:</strong> Posted ✅</div>`
        : `<div style="color:#ef4444; font-weight:800;"><strong>SAP:</strong> NOT posted ❌</div>`;
    
    if (elements.successDetails) {
        elements.successDetails.innerHTML = `
            <div><strong>PO Number:</strong> ${payload.poNumber}</div>
            <div><strong>FG Quantity${currentInventoryUOM ? ` (${currentInventoryUOM})` : ''}:</strong> ${formatQty(payload.fgQuantity)}</div>
            <div><strong>QC Supervisor:</strong> ${payload.qcSupervisor}</div>
            <div><strong>Operator:</strong> ${payload.operatorName}</div>
            ${result.batchNumber ? `<div><strong>Batch Number:</strong> ${result.batchNumber}</div>` : ''}
            ${result.sapDocEntry ? `<div><strong>SAP Doc Entry:</strong> ${result.sapDocEntry}</div>` : ''}
            ${sapStatusHTML}
            <div><strong>Packing Slip:</strong> 1 label (${formatQty(payload.fgQuantity)}${currentInventoryUOM ? ` ${currentInventoryUOM}` : ''})</div>
            ${printStatusHTML}
        `;
    }
    
    // Update label count on button
    if (elements.labelCount) {
        elements.labelCount.textContent = numLabels;
    }
    
    // Update button text to indicate reprint
    if (elements.printLabelsBtn) {
        elements.printLabelsBtn.innerHTML = `<span>🖨️</span> Reprint Labels (<span id="label-count">${numLabels}</span>)`;
    }
    
    showSection('success');

    // If server requested preview-before-print, show preview modal
    if (result.printResult?.previewPending) {
        if (elements.labelPrintStatusExtra) {
            elements.labelPrintStatusExtra.style.display = 'none';
            elements.labelPrintStatusExtra.innerHTML = '';
        }
        showLabelPreviewModal();
    }
}

function hideLabelPreviewModal() {
    if (elements.labelPreviewModal) {
        elements.labelPreviewModal.style.display = 'none';
    }
}

function showLabelPreviewModal() {
    if (!elements.labelPreviewModal || !lastSubmittedEntry) return;
    const n = lastSubmittedEntry.numLabels;
    if (elements.labelPreviewHint) {
        elements.labelPreviewHint.textContent =
            `Packing slip preview — total FG quantity in ${lastSubmittedEntry.inventoryUOM || 'KGS'}.`;
    }
    if (elements.labelPreviewHost) {
        elements.labelPreviewHost.innerHTML =
            `<div class="label-preview-scale">${generateLabelHTML(lastSubmittedEntry, 1, n)}</div>`;
    }
    if (elements.labelPreviewPrintBtn) {
        elements.labelPreviewPrintBtn.disabled = false;
    }
    elements.labelPreviewModal.style.display = 'flex';
}

async function fetchLastBatchForPo(poNumber) {
    if (!poNumber) return '';
    try {
        const response = await fetch(`${API_BASE_URL}/fg-last-batch/${encodeURIComponent(poNumber)}`);
        if (!response.ok) return '';
        const json = await response.json();
        return (json.batchNumber || '').toString().trim();
    } catch {
        return '';
    }
}

async function buildLabelDataFromCurrentForm(batchNo = '') {
    const formData = getFormData();
    const uom = currentInventoryUOM || currentJobData?.inventoryUOM || 'KGS';
    return {
        customerName: currentJobData?.customerName || '',
        customerCode: currentJobData?.customerCode || '',
        itemDescription: currentJobData?.jobName || '',
        fgCode: currentJobData?.itemNo || '',
        itemCodeLabel: currentJobData?.itemCodeLabel || '',
        jobNo: currentJobData?.jobNo || currentJobData?.jobNumber || '',
        quantity: formData.fgQuantity,
        totalQuantity: formData.fgQuantity,
        inventoryUOM: uom,
        packedOn: formatDateForLabel(new Date()),
        operator: formatLabelOperatorField(formData.qcSupervisor, formData.operatorName),
        batchNo: batchNo || ''
    };
}

/** Preview / reprint packing slip without re-submitting to SAP. */
async function handlePreviewPackingSlip() {
    if (!currentJobData?.jobNumber) {
        alert('Please search a production order first.');
        return;
    }

    const formData = getFormData();
    if (!formData.fgQuantity || formData.fgQuantity <= 0) {
        alert('Please enter FG Quantity first.');
        return;
    }
    if (!formData.qcSupervisor) {
        alert('Please select QC Supervisor (shown on label).');
        return;
    }
    if (!formData.operatorName) {
        alert('Please enter Operator name (shown on label).');
        return;
    }

    const batchNo = await fetchLastBatchForPo(currentJobData.jobNumber);
    const labelData = await buildLabelDataFromCurrentForm(batchNo);
    lastSubmittedEntry = {
        ...labelData,
        numLabels: 1
    };

    showLabelPreviewModal();
}

function getLabelQuantityLabel(data) {
    const uom = (data?.inventoryUOM || data?.uom || currentInventoryUOM || 'KGS').toString().trim();
    return uom ? `Quantity (${uom})` : 'Quantity';
}

function getLabelQuantityValue(data) {
    const qty = Number(data?.quantity ?? data?.totalQuantity ?? data?.fgQuantity);
    if (!Number.isFinite(qty) || qty <= 0) return '';
    return qty.toLocaleString();
}

function buildLabelDataForZebra() {
    if (!lastSubmittedEntry) return null;
    return {
        customerName: lastSubmittedEntry.customerName,
        customerCode: lastSubmittedEntry.customerCode,
        itemDescription: lastSubmittedEntry.itemDescription,
        fgCode: lastSubmittedEntry.fgCode,
        itemCodeLabel: lastSubmittedEntry.itemCodeLabel,
        jobNo: lastSubmittedEntry.jobNo,
        quantity: lastSubmittedEntry.quantity,
        totalQuantity: lastSubmittedEntry.totalQuantity,
        inventoryUOM: lastSubmittedEntry.inventoryUOM,
        packedOn: lastSubmittedEntry.packedOn,
        operator: lastSubmittedEntry.operator,
        batchNo: lastSubmittedEntry.batchNo
    };
}

async function sendLabelsToPrinter({ fromPreview = false, fromReprint = false } = {}) {
    const labelData = buildLabelDataForZebra();
    const numLabels = lastSubmittedEntry?.numLabels;
    if (!labelData || !numLabels) {
        alert('No label data for printing.');
        return;
    }

    const btn = fromPreview ? elements.labelPreviewPrintBtn : (fromReprint ? elements.printLabelsBtn : null);
    if (btn) btn.disabled = true;

    try {
        console.log('🖨️ Sending labels to printer via server…', { numLabels, labelData });
        const response = await fetch(`${API_BASE_URL}/fg-print-labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelData, numLabels })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.message || data.error || 'Print request failed');
        }
        const printResult = data.printResult;
        if (!printResult?.success) {
            throw new Error(printResult?.message || 'Print did not complete');
        }

        if (fromPreview) hideLabelPreviewModal();

        if (elements.labelPrintStatusExtra) {
            elements.labelPrintStatusExtra.style.display = 'block';
            elements.labelPrintStatusExtra.innerHTML =
                `<span style="color:#22c55e;font-weight:600">🖨️ Printed ${printResult.printed}/${printResult.total} on label printer.</span>`;
        }
    } catch (err) {
        console.error('fg-print-labels:', err);
        alert(err.message || 'Print failed');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/** @deprecated use sendLabelsToPrinter */
async function sendLabelPrintToZebra() {
    return sendLabelsToPrinter({ fromPreview: true });
}

function svgToPngDataUrl(svgString, widthPx, heightPx) {
    return new Promise((resolve, reject) => {
        const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = widthPx;
                canvas.height = heightPx;
                const ctx = canvas.getContext('2d');
                // White background
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, widthPx, heightPx);
                ctx.drawImage(img, 0, 0, widthPx, heightPx);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/png'));
            } catch (e) {
                URL.revokeObjectURL(url);
                reject(e);
            }
        };
        img.onerror = (e) => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to rasterize label layout'));
        };
        img.src = url;
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read image'));
        reader.readAsDataURL(blob);
    });
}

async function inlineLabelImages(rootEl) {
    // Inline any <img> sources as data URLs so rasterization works reliably on tablets.
    const imgs = Array.from(rootEl.querySelectorAll('img'));
    for (const img of imgs) {
        const src = (img.getAttribute('src') || '').trim();
        if (!src) continue;
        // Skip already-inlined images
        if (src.startsWith('data:')) continue;
        try {
            const res = await fetch(src, { cache: 'no-store' });
            const blob = await res.blob();
            const dataUrl = await blobToDataUrl(blob);
            img.setAttribute('src', dataUrl);
        } catch (e) {
            // If inlining fails, hide the image (better than failing the whole print)
            console.warn('inlineLabelImages failed for', src, e);
            img.style.display = 'none';
        }
    }
}

async function renderCurrentLabelHtmlToPngDataUrl(labelHtml, widthMm = 150, heightMm = 100) {
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.style.width = `${widthMm}mm`;
    host.style.height = `${heightMm}mm`;
    host.style.background = '#fff';
    host.innerHTML = labelHtml;
    document.body.appendChild(host);

    try {
        await inlineLabelImages(host);

        // Prefer html2canvas (works on tablets). Fallback to SVG foreignObject if unavailable.
        if (typeof window.html2canvas === 'function') {
            const canvas = await window.html2canvas(host, {
                backgroundColor: '#ffffff',
                // Higher scale makes text/bars bolder after thresholding; keep moderate for barcode readability.
                scale: 1.25,
                useCORS: true,
                logging: false
            });
            return canvas.toDataURL('image/png');
        }

        // Fallback: SVG foreignObject (may fail on some tablet browsers)
        const cssPxPerMm = 96 / 25.4;
        const widthPx = Math.round(widthMm * cssPxPerMm);
        const heightPx = Math.round(heightMm * cssPxPerMm);
        const html = `
<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${widthMm}mm;height:${heightMm}mm;background:#fff;">
      ${host.innerHTML}
    </div>
  </foreignObject>
</svg>`;
        return await svgToPngDataUrl(html, widthPx, heightPx);
    } finally {
        host.remove();
    }
}

// Rendered print (PNG -> ZPL) intentionally removed: it degrades barcode quality.

// Format date for label (DD/MM/YYYY)
function formatDateForLabel(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

// Browser-only print (local device dialog) — not the ZT411 label printer
function printLabelsOnThisDevice() {
    if (!lastSubmittedEntry) {
        alert('No entry data available for printing');
        return;
    }
    
    const { numLabels } = lastSubmittedEntry;
    
    // Generate label HTML
    let labelsHTML = '';
    for (let i = 1; i <= numLabels; i++) {
        labelsHTML += generateLabelHTML(lastSubmittedEntry, i, numLabels);
    }
    
    // Put labels in print container
    if (elements.labelPrintContainer) {
        elements.labelPrintContainer.innerHTML = labelsHTML;
        elements.labelPrintContainer.style.display = 'block';
        
        // Trigger print
        window.print();
        
        // Hide container after print dialog closes
        setTimeout(() => {
            elements.labelPrintContainer.style.display = 'none';
        }, 1000);
    }
}

function extractBarcodeDisplay(data) {
    const itemCodeLabelRaw = (data?.itemCodeLabel || '').toString().trim();
    const fromLabel = itemCodeLabelRaw.split(',')[0].trim().toUpperCase().replace(/[^0-9A-Z \-\.\$\/\+%]/g, '');
    const fgCode = (data?.fgCode || '').toString().trim();
    const barcodeValue = fromLabel || fgCode.toUpperCase().replace(/[^0-9A-Z \-\.\$\/\+%]/g, '');
    const displayText = itemCodeLabelRaw || fgCode;
    return { barcodeValue, displayText };
}

// Generate HTML for a single label (150mm x 100mm for Zebra ZT411 - Landscape)
function generateLabelHTML(data, boxNum, totalBoxes) {
    const { barcodeValue, displayText } = extractBarcodeDisplay(data);
    const barcodeSvg = barcodeValue ? renderCode39Svg(barcodeValue) : '';

    return `
        <div class="label-page">
          <div class="label-page-inner">
            <div class="sap-label">
              <div class="sap-top">
                <div class="sap-logo">
                  <img src="/vk-logo.png" alt="VK logo">
                </div>
                <div class="sap-company">
                  <strong>VK GLOBAL DIGITAL PRIVATE LIMITED</strong>
                  PLOT NO. 928, SECTOR-68, IMT FARIDABAD,<br/>
                  FARIDABAD - 121004, INDIA
                </div>
              </div>

              <div class="sap-title">PACKING SLIP</div>

              <div class="sap-fields">
                <table class="sap-table sap-fields-table">
                  <tr>
                    <td class="k">Customer Name</td>
                    <td class="v">${escapeHtml(data.customerName)}</td>
                  </tr>
                  <tr>
                    <td class="k">Item Description</td>
                    <td class="v">${escapeHtml(data.itemDescription)}</td>
                  </tr>
                </table>

                <table class="sap-table sap-details-grid">
                  <colgroup>
                    <col class="col-k">
                    <col class="col-v">
                    <col class="col-rk">
                    <col class="col-rv">
                  </colgroup>
                  <tr>
                    <td class="k">FG Code</td><td class="v">${escapeHtml(data.fgCode)}</td>
                    <td class="barcode-cell" colspan="2" rowspan="3">
                      <div class="sap-barcode-title">ItemCode</div>
                      <div class="sap-barcode">
                        ${barcodeSvg}
                        <div class="code-text">${escapeHtml(displayText)}</div>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td class="k">Job No</td><td class="v">${escapeHtml(data.jobNo)}</td>
                  </tr>
                  <tr>
                    <td class="k">${escapeHtml(getLabelQuantityLabel(data))}</td><td class="v">${escapeHtml(getLabelQuantityValue(data))}</td>
                  </tr>
                  <tr>
                    <td class="k">Packed On</td><td class="v">${escapeHtml(data.packedOn)}</td>
                    <td class="rk">Batch No</td><td class="rv">${escapeHtml(data.batchNo)}</td>
                  </tr>
                  <tr>
                    <td class="k">Operator</td><td class="v" colspan="3">${escapeHtml(data.operator)}</td>
                  </tr>
                </table>
              </div>
            </div>
          </div>
        </div>
    `;
}

// Offline barcode (Code 39) for digits/uppercase + basic symbols
function renderCode39Svg(value) {
    const normalized = value.toUpperCase();
    const encoded = `*${normalized}*`;

    const patterns = {
        '0': 'nnnwwnwnn',
        '1': 'wnnwnnnnw',
        '2': 'nnwwnnnnw',
        '3': 'wnwwnnnnn',
        '4': 'nnnwwnnnw',
        '5': 'wnnwwnnnn',
        '6': 'nnwwwnnnn',
        '7': 'nnnwnnwnw',
        '8': 'wnnwnnwnn',
        '9': 'nnwwnnwnn',
        'A': 'wnnnnwnnw',
        'B': 'nnwnnwnnw',
        'C': 'wnwnnwnnn',
        'D': 'nnnnwwnnw',
        'E': 'wnnnwwnnn',
        'F': 'nnwnwwnnn',
        'G': 'nnnnnwwnw',
        'H': 'wnnnnwwnn',
        'I': 'nnwnnwwnn',
        'J': 'nnnnwwwnn',
        'K': 'wnnnnnnww',
        'L': 'nnwnnnnww',
        'M': 'wnwnnnnwn',
        'N': 'nnnnwnnww',
        'O': 'wnnnwnnwn',
        'P': 'nnwnwnnwn',
        'Q': 'nnnnnnwww',
        'R': 'wnnnnnwwn',
        'S': 'nnwnnnwwn',
        'T': 'nnnnwnwwn',
        'U': 'wwnnnnnnw',
        'V': 'nwwnnnnnw',
        'W': 'wwwnnnnnn',
        'X': 'nwnnwnnnw',
        'Y': 'wwnnwnnnn',
        'Z': 'nwwnwnnnn',
        '-': 'nwnnnnwnw',
        '.': 'wwnnnnwnn',
        ' ': 'nwwnnnwnn',
        '$': 'nwnwnwnnn',
        '/': 'nwnwnnnwn',
        '+': 'nwnnnwnwn',
        '%': 'nnnwnwnwn',
        '*': 'nwnnwnwnn'
    };

    const narrow = 1;
    const wide = 3;
    const gap = 1; // inter-character gap (narrow space)

    let x = 0;
    const bars = [];

    for (let i = 0; i < encoded.length; i++) {
        const ch = encoded[i];
        const pattern = patterns[ch];
        if (!pattern) continue;

        // pattern length 9: bar/space alternating starting with bar
        for (let j = 0; j < pattern.length; j++) {
            const isBar = j % 2 === 0;
            const w = pattern[j] === 'w' ? wide : narrow;
            if (isBar) {
                bars.push({ x, w });
            }
            x += w;
        }
        x += gap;
    }

    const height = 60; // svg units
    const width = Math.max(x, 1);
    const viewBox = `0 0 ${width} ${height}`;
    const rects = bars
        .map(b => `<rect x="${b.x}" y="0" width="${b.w}" height="${height}" fill="#000" />`)
        .join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="none">${rects}</svg>`;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Reset to search state
function resetToSearch() {
    currentJobData = null;
    lastSubmittedEntry = null;
    
    // Clear form
    clearForm();
    
    // Clear search input
    if (elements.poSearchInput) {
        elements.poSearchInput.value = '';
    }
    
    // Reset submit button
    if (elements.submitBtn) {
        elements.submitBtn.disabled = false;
        elements.submitBtn.innerHTML = '<span>✅</span> Submit FG Entry';
    }
    
    // Show search section
    showSection('search');
    
    // Focus on search input
    if (elements.poSearchInput) {
        elements.poSearchInput.focus();
    }
}

// Clear form
function clearForm() {
    if (elements.fgEntryForm) {
        elements.fgEntryForm.reset();
    }
    
    // Reset QC supervisor "other" field
    if (elements.otherQcGroup) {
        elements.otherQcGroup.style.display = 'none';
    }
    if (elements.otherQcInput) {
        elements.otherQcInput.required = false;
        elements.otherQcInput.value = '';
    }
}

// Show error message
function showError(message) {
    if (elements.errorMessage) {
        elements.errorMessage.textContent = message;
    }
    showSection('error');
}

// Show specific section
function showSection(section) {
    // Hide all sections
    if (elements.loadingSection) elements.loadingSection.style.display = 'none';
    if (elements.errorSection) elements.errorSection.style.display = 'none';
    if (elements.jobSection) elements.jobSection.style.display = 'none';
    if (elements.successSection) elements.successSection.style.display = 'none';
    
    // Show requested section
    switch (section) {
        case 'loading':
            if (elements.loadingSection) elements.loadingSection.style.display = 'flex';
            break;
        case 'error':
            if (elements.errorSection) elements.errorSection.style.display = 'flex';
            break;
        case 'job':
            if (elements.jobSection) elements.jobSection.style.display = 'flex';
            break;
        case 'success':
            if (elements.successSection) elements.successSection.style.display = 'block';
            break;
        case 'search':
        default:
            // Just show search section (always visible)
            break;
    }
}

// Format IST date time
function formatISTDateTime() {
    const now = new Date();
    const options = {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    return now.toLocaleString('en-IN', options);
}

// Generate sample label for testing
function generateSampleLabel() {
    const sampleData = {
        customerName: 'ABC Pharmaceuticals Pvt Ltd',
        customerCode: 'CUST-12345',
        itemDescription: 'Premium Quality Printed Cartons for Medicine Packaging - 300gsm',
        fgCode: 'FG-2024-00123',
        jobNo: 'PO-2024-001234',
        quantity: 500,
        totalQuantity: 2500,
        packedOn: formatDateForLabel(new Date()),
            operator: 'Rajesh/Amit',
        batchNo: 'BATCH-2024-0313-001',
        numLabels: 5
    };
    
    // Generate label HTML
    const labelHTML = generateLabelHTML(sampleData, 1, 5);
    
    // Put label in print container
    if (elements.labelPrintContainer) {
        elements.labelPrintContainer.innerHTML = labelHTML;
        elements.labelPrintContainer.style.display = 'block';
        
        // Trigger print
        window.print();
        
        // Hide container after print dialog closes
        setTimeout(() => {
            elements.labelPrintContainer.style.display = 'none';
        }, 1000);
    }
    
    return sampleData;
}

// Preview sample label (without printing)
function previewSampleLabel() {
    const sampleData = {
        customerName: 'ABC Pharmaceuticals Pvt Ltd',
        customerCode: 'CUST-12345',
        itemDescription: 'Premium Quality Printed Cartons for Medicine Packaging - 300gsm',
        fgCode: 'FG-2024-00123',
        jobNo: 'PO-2024-001234',
        quantity: 500,
        totalQuantity: 2500,
        packedOn: formatDateForLabel(new Date()),
            operator: 'Rajesh/Amit',
        batchNo: 'BATCH-2024-0313-001',
        numLabels: 5
    };
    
    // Generate label HTML
    const labelHTML = generateLabelHTML(sampleData, 1, 5);
    
    // Put label in print container with preview mode
    if (elements.labelPrintContainer) {
        elements.labelPrintContainer.innerHTML = `
            <div style="text-align: center; margin-bottom: 15px;">
                <button onclick="document.getElementById('label-print-container').style.display='none'; document.getElementById('label-print-container').classList.remove('preview-mode');" 
                    style="padding: 10px 20px; background: #ef4444; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; margin-right: 10px;">
                    Close Preview
                </button>
                <button onclick="window.print();" 
                    style="padding: 10px 20px; background: #10b981; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px;">
                    Print Label
                </button>
            </div>
            ${labelHTML}
        `;
        elements.labelPrintContainer.classList.add('preview-mode');
        elements.labelPrintContainer.style.display = 'block';
    }
    
    return sampleData;
}

// Expose functions globally for console testing
window.generateSampleLabel = generateSampleLabel;
window.previewSampleLabel = previewSampleLabel;
