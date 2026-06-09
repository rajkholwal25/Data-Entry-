/**
 * Shared helpers for multi-output (jumbled) production orders.
 * Used by data-entry.js and manual-machine.js.
 */
(function (global) {
    const MATERIAL_PREFIXES = ['PMT', 'FIL', 'ADH', 'RMC', 'TAP'];

    function isJumbledMaterialItemNo(itemNo) {
        const upper = String(itemNo || '').toUpperCase();
        return MATERIAL_PREFIXES.some((prefix) => upper.startsWith(prefix));
    }

    function isJumbledJobFromData(job) {
        if (!job) return false;
        if (job.isJumbledJob === true || job.is_jumbled_job === true) return true;
        const fg = job.fgLines || job.fg_lines;
        return Array.isArray(fg) && fg.length > 1;
    }

    function getFgLinesFromJob(job) {
        if (!job) return [];
        return job.fgLines || job.fg_lines || [];
    }

    /**
     * Resolve main-product base qty for jumbled sheet→carton math.
     * SAP often leaves header/main FG line baseQuantity as 0; fall back to co-product line or job baseQuantities.
     * @param {Object} mainLine
     * @param {Array<Object>} lines
     * @param {{ baseQuantities?: number[] }} options
     * @returns {number}
     */
    function resolveMainBaseQty(mainLine, lines, options = {}) {
        const fromMain = Math.abs(Number(mainLine?.baseQuantity) || 0);
        if (fromMain > 0) return fromMain;

        const coLine = (lines || []).find((l) => l && l.isByProduct === true);
        const coBq = Math.abs(Number(coLine?.baseQuantity) || 0);
        if (coBq > 0) return coBq;

        const fromFgLines = (lines || [])
            .map((l) => Math.abs(Number(l.baseQuantity) || 0))
            .filter((v) => v > 0);
        if (fromFgLines.length > 0) {
            return Math.max(...fromFgLines);
        }

        const baseQuantities = options.baseQuantities || [];
        if (baseQuantities.length > 0) {
            return Math.max(...baseQuantities.map((bq) => Math.abs(Number(bq) || 0)));
        }

        return 0;
    }

    /**
     * Compute completion quantity per FG line from sheets processed.
     * @param {number} sheetsProcessed
     * @param {Array<Object>} fgLines
     * @param {{ applyDieDivision?: boolean, baseQuantities?: number[] }} options
     * @returns {Array<Object>}
     */
    function calculateFgLinesQuantities(sheetsProcessed, fgLines, options = {}) {
        const sheets = Number(sheetsProcessed) || 0;
        const lines = Array.isArray(fgLines) ? fgLines : [];
        const applyDieDivision = !!options.applyDieDivision;

        const header = lines.find((l) => l.isHeader) || lines[0];
        const mainLine = lines.find((l) => l && l.isByProduct !== true) || header;
        const headerPlanned = Math.abs(Number(header?.plannedQuantity) || 0);
        const mainBaseQty = resolveMainBaseQty(mainLine, lines, options);

        return lines.map((line) => {
            const coBq = Math.abs(Number(line.baseQuantity) || 0);
            let quantity = 0;

            if (applyDieDivision && mainBaseQty > 0) {
                if (line && line.isByProduct !== true) {
                    // Main: sheets ÷ main base qty (e.g. 1190 sheets, bq 0.5 → 2380 cartons)
                    quantity = Math.round(sheets / mainBaseQty);
                } else {
                    // Co-product: (row base qty ÷ main base qty) × sheets (e.g. ratio 1 → same as sheets)
                    quantity = Math.round((coBq / mainBaseQty) * sheets);
                }
            } else if (line.isHeader || (line && line.isByProduct !== true)) {
                quantity = sheets;
            } else if (headerPlanned > 0 && line.plannedQuantity) {
                quantity = Math.round(sheets * (Math.abs(Number(line.plannedQuantity)) / headerPlanned));
            } else {
                quantity = sheets;
            }

            return {
                ...line,
                quantity: Math.max(0, quantity)
            };
        });
    }

    /**
     * @param {number} sheetsProcessed
     * @param {Array<Object>} fgLinesWithQty - from calculateFgLinesQuantities
     * @param {{ applyDieDivision?: boolean, baseQuantities?: number[], issuedQuantity?: number, completedQuantity?: number, skipRemainingCheck?: boolean }} options
     * @returns {{ valid: boolean, message?: string }}
     */
    function validateJumbledCompletion(sheetsProcessed, fgLinesWithQty, options = {}) {
        const sheets = Number(sheetsProcessed) || 0;
        if (sheets <= 0) {
            return { valid: false, message: 'Please enter quantity processed.' };
        }

        const lines = Array.isArray(fgLinesWithQty) ? fgLinesWithQty : [];
        if (lines.length < 2) {
            return { valid: false, message: 'Jumbled job requires at least two FG outputs.' };
        }

        const header = lines.find((l) => l.isHeader) || lines[0];
        const applyDieDivision = !!options.applyDieDivision;
        const baseQuantities = options.baseQuantities || [];
        const skipRemaining = !!options.skipRemainingCheck;

        if (!skipRemaining) {
            const rawIssued = Number(options.issuedQuantity) || 0;
            const completedQty = Number(options.completedQuantity) || 0;

            let issuedForCheck = rawIssued;
            let headerQty = header?.quantity || 0;

            if (options.headerCompletionQty != null) {
                headerQty = Number(options.headerCompletionQty) || 0;
            } else if (applyDieDivision && baseQuantities.length > 0) {
                // Jumbled jobs: validate remaining for the MAIN product in the same unit we post to SAP (cartons).
                // For DIE/EMB+P contexts, SAP issues are in sheets but completions are in cartons.
                // Use the MAIN (header) base quantity as the conversion factor.
                const mainLine = lines.find((l) => l && l.isByProduct !== true) || header;
                const mainBq = resolveMainBaseQty(mainLine, lines, { baseQuantities });

                if (mainBq > 0) {
                    issuedForCheck = Math.round(rawIssued / mainBq);
                    headerQty = Math.round(sheets / mainBq);
                } else if (typeof global.calculateDieCuttingQuantityForSAP === 'function') {
                    // Fallback: legacy multi-base calculation
                    headerQty = global.calculateDieCuttingQuantityForSAP(sheets, baseQuantities);
                } else if (typeof global.calculateDieCuttingQuantityForSAPManual === 'function') {
                    headerQty = global.calculateDieCuttingQuantityForSAPManual(sheets, baseQuantities);
                }
            }

            const remaining = issuedForCheck - completedQty;
            if (issuedForCheck > 0 && headerQty > remaining) {
                const unit = applyDieDivision ? 'cartons' : 'units';
                return {
                    valid: false,
                    message: `Quantity exceeds remaining (${Math.max(0, remaining)} ${unit}) for the main product. Please reduce sheets processed.`
                };
            }
        }

        for (const line of lines) {
            const qty = line.quantity || 0;
            if (qty <= 0) continue;

            const planned = Math.abs(Number(line.plannedQuantity) || 0);
            const completed = Math.abs(Number(line.completedQuantity) || 0);
            const headerPlanned = Math.abs(Number(header?.plannedQuantity) || 0);
            const headerCompleted = Math.abs(Number(options.completedQuantity) || Number(header?.completedQuantity) || 0);

            let remainingLine;
            if (line.isByProduct) {
                // Co-product remaining is proportional to main product remaining, not co-product line issued qty
                // (SAP stores co-product issued as negative allocation after receipt — not a completion cap)
                if (headerPlanned > 0 && planned > 0) {
                    const headerRemaining = Math.max(0, headerPlanned - headerCompleted);
                    remainingLine = Math.round(headerRemaining * (planned / headerPlanned));
                } else {
                    remainingLine = Math.max(0, planned - completed);
                }
            } else {
                const issued = Number(line.issuedQuantity) || 0;
                remainingLine = planned - completed;
                if (issued > 0) {
                    remainingLine = issued - completed;
                }
            }

            if (!skipRemaining && remainingLine >= 0 && qty > remainingLine) {
                const tag = line.isByProduct ? 'Co-product' : 'Product';
                return {
                    valid: false,
                    message: `${tag} ${line.itemNo} quantity (${qty}) exceeds remaining (${Math.max(0, remainingLine)}).`
                };
            }
        }

        const totalFgQty = lines.reduce((sum, l) => sum + (l.quantity || 0), 0);
        if (totalFgQty <= 0) {
            return { valid: false, message: 'Calculated FG quantities are zero. Check sheets processed.' };
        }

        return { valid: true };
    }

    function formatFgLineLabel(line) {
        const tag = line.isByProduct ? 'Co-product' : 'Main';
        return `${line.itemNo} (${tag})`;
    }

    function renderFgLinesHtml(fgLinesWithQty) {
        if (!fgLinesWithQty.length) {
            return '<div style="color:#94a3b8;font-size:0.85rem;">No FG lines</div>';
        }

        return fgLinesWithQty.map((line) => {
            const planned = Math.abs(line.plannedQuantity || 0);
            const completed = Math.abs(line.completedQuantity || 0);
            const headerPlanned = Math.abs((fgLinesWithQty.find((l) => l.isHeader) || fgLinesWithQty[0])?.plannedQuantity || 0);
            const headerCompleted = Math.abs((fgLinesWithQty.find((l) => l.isHeader) || fgLinesWithQty[0])?.completedQuantity || 0);
            let remaining;
            if (line.isByProduct && headerPlanned > 0 && planned > 0) {
                remaining = Math.max(0, Math.round((headerPlanned - headerCompleted) * (planned / headerPlanned)));
            } else {
                remaining = Math.max(0, planned - completed);
            }
            return `
                <div class="jumbled-fg-row" data-item-no="${line.itemNo}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(148,163,184,0.2);font-size:0.9rem;">
                    <div>
                        <div style="font-weight:600;color:var(--text-primary,#e2e8f0);">${line.itemNo}</div>
                        <div style="font-size:0.75rem;color:#94a3b8;">${line.isByProduct ? 'Co-product / by-product' : 'Main output'} · Planned ${planned.toLocaleString()} · Done ${completed.toLocaleString()}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:700;color:#3b82f6;">${(line.quantity || 0).toLocaleString()}</div>
                        <div style="font-size:0.7rem;color:#64748b;">to complete</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function refreshJumbledFinishUI(job, sheetsProcessed, options = {}) {
        const section = document.getElementById('jumbled-job-section');
        const details = document.getElementById('jumbledJobDetails');
        const container = document.getElementById('fgLinesContainer');
        const empty = document.getElementById('fgLinesEmpty');
        const checkbox = document.getElementById('isJumbledJob');

        const fgLines = getFgLinesFromJob(job);
        const isJumbled = fgLines.length > 1;

        if (!section) return { isJumbled, fgLinesWithQty: [] };

        if (isJumbled) {
            section.style.display = 'block';
            if (checkbox) {
                checkbox.checked = true;
                checkbox.disabled = true;
            }
            if (details) details.style.display = 'block';

            const calcOptions = {
                applyDieDivision: options.applyDieDivision,
                baseQuantities: options.baseQuantities || job.baseQuantities || job.base_quantities || []
            };
            const fgLinesWithQty = calculateFgLinesQuantities(sheetsProcessed, fgLines, calcOptions);
            if (container) {
                container.innerHTML = renderFgLinesHtml(fgLinesWithQty);
                container.style.display = 'block';
            }
            if (empty) empty.style.display = 'none';
            return { isJumbled, fgLinesWithQty };
        }

        section.style.display = 'none';
        if (checkbox) {
            checkbox.checked = false;
            checkbox.disabled = false;
        }
        if (details) details.style.display = 'none';
        if (container) container.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return { isJumbled: false, fgLinesWithQty: [] };
    }

    function refreshJumbledSummaryUI(fgLinesWithQty) {
        const section = document.getElementById('summary-jumbled-section');
        const container = document.getElementById('summary-fg-lines');
        if (!section || !container) return;

        if (fgLinesWithQty && fgLinesWithQty.length > 1) {
            section.style.display = 'block';
            container.innerHTML = renderFgLinesHtml(fgLinesWithQty);
        } else {
            section.style.display = 'none';
            container.innerHTML = '';
        }
    }

    /**
     * Recalculate jumbled FG qty on the final submission (summary) form from quantity processed.
     * @param {Object} jobData - pendingJobData or similar
     * @returns {Array<Object>}
     */
    function refreshJumbledSummaryFromJob(jobData) {
        if (!jobData) return [];
        const sheets = Number(jobData.sheetsProcessed) || 0;
        const applyDie = !!jobData.applyDieDivision;
        const fgLinesWithQty = calculateFgLinesQuantities(
            sheets,
            getFgLinesFromJob(jobData),
            {
                applyDieDivision: applyDie,
                baseQuantities: jobData.baseQuantities || []
            }
        );
        refreshJumbledSummaryUI(fgLinesWithQty);
        return fgLinesWithQty;
    }

    function displayJumbledJobResults(autoIssue) {
        const el = document.getElementById('autoIssueResults');
        if (!el || !autoIssue) return;

        const results = autoIssue.results || [];
        const ok = Number(autoIssue.successfulIssues || 0);
        const total = Number(autoIssue.totalFGItems || results.length);

        let html = `<div style="padding:12px;border-radius:8px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.3);">`;
        html += `<div style="font-weight:600;margin-bottom:8px;">Jumbled job — auto-issue ${ok}/${total}</div>`;
        html += '<ul style="margin:0;padding-left:18px;font-size:0.85rem;">';
        for (const r of results) {
            const icon = r.success ? '✅' : (r.skipped ? '⏭️' : '❌');
            const detail = r.success
                ? `Issued ${r.totalIssued || 0} → ${r.targetProcess || ''} PO ${r.targetPO || ''}`
                : (r.error || 'Failed');
            html += `<li>${icon} <strong>${r.fgItemCode || '?'}</strong>: ${detail}</li>`;
        }
        html += '</ul></div>';

        el.innerHTML = html;
        el.style.display = 'block';
    }

    function buildFgLinesPayload(fgLinesWithQty) {
        return (fgLinesWithQty || []).map((line) => ({
            itemNo: line.itemNo,
            itemName: line.itemName || line.itemNo,
            lineNumber: line.lineNumber ?? null,
            isHeader: !!line.isHeader,
            isByProduct: !!line.isByProduct,
            plannedQuantity: line.plannedQuantity || 0,
            baseQuantity: line.baseQuantity || 0,
            quantity: line.quantity || 0,
            warehouse: line.warehouse || null
        }));
    }

    function toggleJumbledJobUI() {
        const checkbox = document.getElementById('isJumbledJob');
        const details = document.getElementById('jumbledJobDetails');
        if (!checkbox || !details) return;
        details.style.display = checkbox.checked ? 'block' : 'none';
        if (checkbox.checked) {
            const sheets = parseInt(document.getElementById('sheets-processed')?.value, 10) || 0;
            if (typeof global.updateJumbledFGQuantities === 'function') {
                global.updateJumbledFGQuantities(sheets);
            }
        }
    }

    const api = {
        isJumbledMaterialItemNo,
        isJumbledJobFromData,
        getFgLinesFromJob,
        calculateFgLinesQuantities,
        resolveMainBaseQty,
        validateJumbledCompletion,
        formatFgLineLabel,
        renderFgLinesHtml,
        refreshJumbledFinishUI,
        refreshJumbledSummaryUI,
        refreshJumbledSummaryFromJob,
        displayJumbledJobResults,
        buildFgLinesPayload
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.JumbledJob = api;
    global.toggleJumbledJobUI = toggleJumbledJobUI;
})(typeof window !== 'undefined' ? window : global);
