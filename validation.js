/**
 * Production Data Entry - Validation Module
 * 
 * This module contains all validation functions for the production tracking system.
 * See VALIDATION_RULES.md for detailed documentation of all validation rules.
 * 
 * @version 1.0
 */

// ==================== Configuration ====================

const VALIDATION_CONFIG = {
    // Quantity limits
    MAX_WASTE_PERCENT_WARNING: 10,      // Warn if waste > 10%
    MAX_WASTE_PERCENT_ERROR: 50,        // Error if waste > 50%
    
    // Time limits (in seconds)
    MAX_MAKEREADY_SECONDS_WARNING: 14400, // 4 hours
    MAX_TOTAL_JOB_SECONDS: 43200,         // 12 hours (shift)
    MIN_RUNNING_SECONDS: 1,               // At least 1 second of running
    
    // Speed limits (sheets/hour)
    MIN_SPEED: 100,
    MAX_SPEED: 20000,
    SPEED_TOLERANCE_PERCENT: 50,        // ±50% variance allowed
    
    // Efficiency thresholds
    MIN_EFFICIENCY_PERCENT: 30,
    MAX_EFFICIENCY_PERCENT: 120,
    
    // Production thresholds
    MIN_PRODUCTION_PERCENT: 10          // Warn if < 10% of planned
};

// ==================== Validation Result Classes ====================

/**
 * Represents a single validation error or warning
 */
class ValidationIssue {
    constructor(code, message, severity = 'error', field = null) {
        this.code = code;
        this.message = message;
        this.severity = severity; // 'error' or 'warning'
        this.field = field;
        this.timestamp = new Date().toISOString();
    }
}

/**
 * Represents the result of a validation check
 */
class ValidationResult {
    constructor() {
        this.errors = [];
        this.warnings = [];
    }

    addError(code, message, field = null) {
        this.errors.push(new ValidationIssue(code, message, 'error', field));
    }

    addWarning(code, message, field = null) {
        this.warnings.push(new ValidationIssue(code, message, 'warning', field));
    }

    get hasErrors() {
        return this.errors.length > 0;
    }

    get hasWarnings() {
        return this.warnings.length > 0;
    }

    get isValid() {
        return !this.hasErrors;
    }

    merge(otherResult) {
        this.errors.push(...otherResult.errors);
        this.warnings.push(...otherResult.warnings);
        return this;
    }

    getErrorMessages() {
        return this.errors.map(e => e.message);
    }

    getWarningMessages() {
        return this.warnings.map(w => w.message);
    }

    getAllMessages() {
        return {
            errors: this.getErrorMessages(),
            warnings: this.getWarningMessages()
        };
    }
}

// ==================== Quantity Validations ====================

/**
 * Validate quantity-related fields
 * @param {Object} data - { sheetsProcessed, wastedSheets, plannedQuantity }
 * @returns {ValidationResult}
 */
function validateQuantities(data) {
    const result = new ValidationResult();
    const { sheetsProcessed, wastedSheets, plannedQuantity } = data;

    // QTY_004: Check for positive numbers
    if (sheetsProcessed < 0) {
        result.addError('QTY_004', 'Sheets processed must be a positive number', 'sheetsProcessed');
    }
    if (wastedSheets < 0) {
        result.addError('QTY_004', 'Wasted sheets must be a positive number', 'wastedSheets');
    }
    if (plannedQuantity < 0) {
        result.addError('QTY_004', 'Planned quantity must be a positive number', 'plannedQuantity');
    }

    // Skip other checks if basic validation failed
    if (result.hasErrors) return result;

    // QTY_001: Sheets processed cannot exceed planned quantity
//    if (sheetsProcessed > plannedQuantity) {
//        result.addError(
//            'QTY_001',
//            `Sheets processed (${sheetsProcessed.toLocaleString()}) cannot exceed planned quantity (${plannedQuantity.toLocaleString()})`,
//            'sheetsProcessed'
//        );
//    }

    // QTY_002: Wasted sheets cannot exceed sheets processed
    if (wastedSheets > sheetsProcessed) {
        result.addError(
            'QTY_002',
            `Wasted sheets (${wastedSheets.toLocaleString()}) cannot exceed sheets processed (${sheetsProcessed.toLocaleString()})`,
            'wastedSheets'
        );
    }

    // QTY_003: Wasted sheets cannot exceed planned quantity
    if (wastedSheets > plannedQuantity) {
        result.addError(
            'QTY_003',
            `Wasted sheets (${wastedSheets.toLocaleString()}) cannot exceed planned quantity (${plannedQuantity.toLocaleString()})`,
            'wastedSheets'
        );
    }

    // QTY_005: High waste warning - DISABLED
    // This warning has been removed to reduce unnecessary popups

    return result;
}

// ==================== Time Validations ====================

/**
 * Validate time-related fields
 * @param {Object} data - { makereadySeconds, runningSeconds, totalSeconds }
 * @returns {ValidationResult}
 */
function validateTimes(data) {
    const result = new ValidationResult();
    const { makereadySeconds = 0, runningSeconds = 0, totalSeconds = 0 } = data;

    // TIME_001: Running time required
    if (runningSeconds < VALIDATION_CONFIG.MIN_RUNNING_SECONDS) {
        result.addError(
            'TIME_001',
            'Running time is required to complete a job',
            'runningTime'
        );
    }

    // TIME_002: Make ready time limit warning - DISABLED
    // TIME_003: Total time exceeds shift duration - DISABLED
    // These warnings have been removed to reduce unnecessary popups

    return result;
}

/**
 * Validate time format (HH:MM:SS)
 * @param {string} timeString - Time string to validate
 * @returns {ValidationResult}
 */
function validateTimeFormat(timeString) {
    const result = new ValidationResult();
    const pattern = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;

    if (!pattern.test(timeString)) {
        result.addError(
            'TIME_004',
            'Invalid time format. Please use HH:MM:SS (e.g., 01:30:45)',
            'time'
        );
    }

    return result;
}

/**
 * Convert time string (HH:MM:SS) to seconds
 * @param {string} timeString 
 * @returns {number}
 */
function timeStringToSeconds(timeString) {
    const parts = timeString.split(':');
    if (parts.length !== 3) return 0;
    const hours = parseInt(parts[0]) || 0;
    const minutes = parseInt(parts[1]) || 0;
    const seconds = parseInt(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Convert seconds to time string (HH:MM:SS)
 * @param {number} totalSeconds 
 * @returns {string}
 */
function secondsToTimeString(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ==================== Speed/Efficiency Validations ====================

/**
 * Validate machine speed
 * @param {Object} data - { machineSpeed, runningSeconds, sheetsProcessed }
 * @returns {ValidationResult}
 */
function validateSpeed(data) {
    const result = new ValidationResult();
    const { machineSpeed, runningSeconds = 0, sheetsProcessed = 0 } = data;

    // SPEED_003: Positive speed required
    if (machineSpeed <= 0) {
        result.addError(
            'SPEED_003',
            'Machine speed must be greater than 0',
            'machineSpeed'
        );
        return result;
    }

    // SPEED_001: Speed range check - DISABLED
    // This warning has been removed to reduce unnecessary popups

    // SPEED_002: Speed vs output consistency - REMOVED
    // This check was causing unnecessary popups and has been disabled

    return result;
}

/**
 * Calculate and validate efficiency
 * @param {Object} data - { runningSeconds, totalSeconds, sheetsProcessed, plannedQuantity }
 * @returns {ValidationResult}
 */
function validateEfficiency(data) {
    const result = new ValidationResult();
    // SPEED_004: Efficiency threshold warning - DISABLED
    // This warning has been removed to reduce unnecessary popups
    return result;
}

// ==================== Job State Validations ====================

/**
 * Validate job state for finishing
 * @param {Object} job - Job object with isActive, state, timeBreakdown
 * @returns {ValidationResult}
 */
function validateJobState(job) {
    const result = new ValidationResult();

    // STATE_001: Job must be started
    if (!job || !job.isActive) {
        result.addError(
            'STATE_001',
            'This job has not been started yet. Start with Make Ready or Running first.',
            'jobState'
        );
        return result;
    }

    // BIZ_005: Check for activity time
    const timeBreakdown = job.timeBreakdown || {};
    const totalActivityTime = Object.values(timeBreakdown).reduce((sum, time) => sum + (time || 0), 0);
    
    if (totalActivityTime === 0) {
        result.addError(
            'BIZ_005',
            'Job has no recorded activity time. Click Make Ready or Running and wait a few seconds before finishing.',
            'activityTime'
        );
    }

    return result;
}

/**
 * Validate state change
 * @param {Object} data - { newState, selectedJob, activeJobNumber, activeJobState }
 * @returns {ValidationResult}
 */
function validateStateChange(data) {
    const result = new ValidationResult();
    const { newState, selectedJob, activeJobNumber, activeJobState } = data;

    // STATE_003: Job selection required for production states
    const jobRequiredStates = ['running', 'makeready'];
    if (jobRequiredStates.includes(newState) && !selectedJob) {
        result.addError(
            'STATE_003',
            'Please select a job first to track Make Ready or Running time',
            'jobSelection'
        );
        return result;
    }

    // STATE_002: One active job rule
    if ((newState === 'running' || newState === 'makeready') &&
        activeJobNumber && selectedJob && activeJobNumber !== selectedJob.jobNumber) {
        const currentStateName = activeJobState === 'running' ? 'Running' : 'in Make Ready';
        result.addError(
            'STATE_002',
            `Cannot start this job. Job ${activeJobNumber} is currently ${currentStateName}. Finish or cancel that job first.`,
            'activeJob'
        );
    }

    // STATE_004: Sequential state recommendation - REMOVED
    // This warning was incorrectly triggering when switching from makeready to running
    // because the makeready time might not be saved to timeBreakdown yet during the transition.
    // The check is not reliable and causes confusion, so it has been removed.

    return result;
}

// ==================== Data Integrity Validations ====================

/**
 * Validate required fields for job data
 * @param {Object} data - Job data object
 * @returns {ValidationResult}
 */
function validateRequiredFields(data) {
    const result = new ValidationResult();

    // DATA_001: Production Order number required (SAP OWOR DocumentNumber)
    if (!data.poNumber && !data.po_num && !data.jobNumber) {
        result.addError(
            'DATA_001',
            'Production Order number is required',
            'poNumber'
        );
    }

    // DATA_002: Machine name required
    if (!data.machineName && !data.machine_name) {
        result.addError(
            'DATA_002',
            'Machine name is required',
            'machineName'
        );
    }

    return result;
}

/**
 * Validate numeric field
 * @param {*} value - Value to check
 * @param {string} fieldName - Name of the field
 * @returns {ValidationResult}
 */
function validateNumericField(value, fieldName) {
    const result = new ValidationResult();

    if (value === null || value === undefined || value === '') {
        result.addError(
            'DATA_003',
            `${fieldName} is required`,
            fieldName
        );
        return result;
    }

    const numValue = Number(value);
    if (isNaN(numValue)) {
        result.addError(
            'DATA_003',
            `${fieldName} must be a valid number`,
            fieldName
        );
    }

    return result;
}

/**
 * Check for duplicate production order in queue
 * @param {string} poNumber - SAP production order document number
 * @param {Array} currentJobs - Current job queue
 * @returns {ValidationResult}
 */
function validateDuplicatePO(poNumber, currentJobs) {
    const result = new ValidationResult();

    const existing = currentJobs.find(job => 
        job.jobNumber === poNumber || job.poNumber === poNumber
    );

    if (existing) {
        result.addWarning(
            'DATA_004',
            `Production order ${poNumber} is already in the queue. Add another instance?`,
            'poNumber'
        );
    }

    return result;
}

/**
 * Validate cancel reason
 * @param {string} reason - Cancellation reason
 * @returns {ValidationResult}
 */
function validateCancelReason(reason) {
    const result = new ValidationResult();

    if (!reason || reason.trim() === '') {
        result.addError(
            'DATA_005',
            'Please provide a reason for cancellation',
            'cancelReason'
        );
    }

    return result;
}

// ==================== Business Logic Validations ====================

/**
 * Validate business rules for job completion
 * @param {Object} data - Complete job data
 * @returns {ValidationResult}
 */
function validateBusinessRules(data) {
    const result = new ValidationResult();
    const { 
        sheetsProcessed = 0, 
        wastedSheets = 0, 
        plannedQuantity = 0,
        makereadySeconds = 0,
        runningSeconds = 0,
        startShift,
        currentShift
    } = data;

    // BIZ_001: Waste percentage alert - DISABLED
    // This warning has been removed to reduce unnecessary popups

    // BIZ_002: Make ready vs running ratio (KEPT)
    if (makereadySeconds > 0 && runningSeconds > 0 && makereadySeconds > runningSeconds) {
        result.addWarning(
            'BIZ_002',
            `Make ready time (${secondsToTimeString(makereadySeconds)}) exceeds running time (${secondsToTimeString(runningSeconds)}). Please verify.`,
            'timeRatio'
        );
    }

    // BIZ_003: Shift consistency (KEPT)
    if (startShift && currentShift && startShift !== currentShift) {
        result.addWarning(
            'BIZ_003',
            `Job started in ${startShift} shift but finishing in ${currentShift} shift`,
            'shift'
        );
    }

    // BIZ_004: Minimum production check - DISABLED
    // This warning has been removed to reduce unnecessary popups

    return result;
}

// ==================== Combined Validation Functions ====================

/**
 * Validate all fields for job completion
 * @param {Object} data - Complete job completion data
 * @returns {ValidationResult}
 */
function validateJobCompletion(data) {
    const result = new ValidationResult();

    // Extract and normalize data
    const normalizedData = {
        sheetsProcessed: parseInt(data.sheetsProcessed) || 0,
        wastedSheets: parseInt(data.wastedSheets) || 0,
        plannedQuantity: parseInt(data.plannedQuantity) || 0,
        machineSpeed: parseInt(data.machineSpeed) || 0,
        makereadySeconds: data.makereadySeconds || 0,
        runningSeconds: data.runningSeconds || 0,
        totalSeconds: data.totalSeconds || 0,
        startShift: data.startShift,
        currentShift: data.currentShift
    };

    // Run all validations
    result.merge(validateQuantities(normalizedData));
    result.merge(validateTimes(normalizedData));
    // Machine speed is optional (UI field removed). Validate only if provided.
    if (normalizedData.machineSpeed > 0) {
        result.merge(validateSpeed(normalizedData));
    }
    result.merge(validateEfficiency(normalizedData));
    result.merge(validateBusinessRules(normalizedData));

    return result;
}

/**
 * Validate finish job form data
 * @param {Object} formData - Form data from finish job modal
 * @param {Object} jobData - Current job data
 * @returns {ValidationResult}
 */
function validateFinishJobForm(formData, jobData) {
    const result = new ValidationResult();

    // Validate required numeric fields
    result.merge(validateNumericField(formData.sheetsProcessed, 'Sheets Processed'));
    result.merge(validateNumericField(formData.wastedSheets, 'Wasted Sheets'));

    if (result.hasErrors) return result;

    // Validate quantities
    result.merge(validateQuantities({
        sheetsProcessed: parseInt(formData.sheetsProcessed),
        wastedSheets: parseInt(formData.wastedSheets),
        plannedQuantity: jobData.plannedQuantity || 0
    }));

    // Speed validation removed (field is optional / no longer collected)

    return result;
}

/**
 * Validate job summary form data (editable summary)
 * @param {Object} formData - Form data from job summary modal
 * @param {Object} jobData - Current job data
 * @returns {ValidationResult}
 */
function validateJobSummaryForm(formData, jobData) {
    const result = new ValidationResult();

    // Validate time formats
    if (formData.makereadyTime) {
        const makereadyValidation = validateTimeFormat(formData.makereadyTime);
        if (makereadyValidation.hasErrors) {
            makereadyValidation.errors.forEach(e => {
                e.field = 'makereadyTime';
                e.message = 'Make Ready Time: ' + e.message;
            });
        }
        result.merge(makereadyValidation);
    }

    if (formData.runningTime) {
        const runningValidation = validateTimeFormat(formData.runningTime);
        if (runningValidation.hasErrors) {
            runningValidation.errors.forEach(e => {
                e.field = 'runningTime';
                e.message = 'Running Time: ' + e.message;
            });
        }
        result.merge(runningValidation);
    }

    if (result.hasErrors) return result;

    // Convert times to seconds and validate
    const makereadySeconds = formData.makereadyTime ? timeStringToSeconds(formData.makereadyTime) : 0;
    const runningSeconds = formData.runningTime ? timeStringToSeconds(formData.runningTime) : 0;

    // validateJobCompletion includes validateTimes — do not call validateTimes twice
    result.merge(validateJobCompletion({
        sheetsProcessed: formData.sheetsProcessed,
        wastedSheets: formData.wastedSheets,
        plannedQuantity: jobData.plannedQuantity,
        machineSpeed: formData.machineSpeed,
        makereadySeconds,
        runningSeconds
    }));

    return result;
}

// ==================== Utility Functions ====================

/**
 * Format validation result for display
 * @param {ValidationResult} result 
 * @returns {string}
 */
function formatValidationMessages(result) {
    let message = '';

    if (result.hasErrors) {
        message += '❌ Errors:\n';
        result.errors.forEach(e => {
            message += `• ${e.message}\n`;
        });
    }

    if (result.hasWarnings) {
        if (message) message += '\n';
        message += '⚠️ Warnings:\n';
        result.warnings.forEach(w => {
            message += `• ${w.message}\n`;
        });
    }

    return message;
}

/**
 * Show validation result as alert
 * @param {ValidationResult} result 
 * @returns {boolean} - true if user confirms (or no warnings), false if cancelled
 */
function showValidationAlert(result) {
    if (result.hasErrors) {
        alert('❌ Validation Errors:\n\n' + result.getErrorMessages().join('\n'));
        return false;
    }

    if (result.hasWarnings) {
        return confirm('⚠️ Warnings:\n\n' + result.getWarningMessages().join('\n') + '\n\nDo you want to continue?');
    }

    return true;
}

// ==================== Export ====================

// For browser (global scope)
if (typeof window !== 'undefined') {
    window.ProductionValidation = {
        // Configuration
        VALIDATION_CONFIG,
        
        // Classes
        ValidationResult,
        ValidationIssue,
        
        // Quantity validations
        validateQuantities,
        
        // Time validations
        validateTimes,
        validateTimeFormat,
        timeStringToSeconds,
        secondsToTimeString,
        
        // Speed validations
        validateSpeed,
        validateEfficiency,
        
        // State validations
        validateJobState,
        validateStateChange,
        
        // Data validations
        validateRequiredFields,
        validateNumericField,
        validateDuplicatePO,
        validateCancelReason,
        
        // Business validations
        validateBusinessRules,
        
        // Combined validations
        validateJobCompletion,
        validateFinishJobForm,
        validateJobSummaryForm,
        
        // Utilities
        formatValidationMessages,
        showValidationAlert
    };
}

// For Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // Configuration
        VALIDATION_CONFIG,
        
        // Classes
        ValidationResult,
        ValidationIssue,
        
        // Quantity validations
        validateQuantities,
        
        // Time validations
        validateTimes,
        validateTimeFormat,
        timeStringToSeconds,
        secondsToTimeString,
        
        // Speed validations
        validateSpeed,
        validateEfficiency,
        
        // State validations
        validateJobState,
        validateStateChange,
        
        // Data validations
        validateRequiredFields,
        validateNumericField,
        validateDuplicatePO,
        validateCancelReason,
        
        // Business validations
        validateBusinessRules,
        
        // Combined validations
        validateJobCompletion,
        validateFinishJobForm,
        validateJobSummaryForm,
        
        // Utilities
        formatValidationMessages,
        showValidationAlert
    };
}

