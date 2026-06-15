// Material Traceability — embedded on home page (index.html)

(function initTraceability() {
    const poInput = document.getElementById('trace-po-input');
    const batchPoInput = document.getElementById('trace-batch-po-input');
    const batchInput = document.getElementById('trace-batch-input');
    const batchHintEl = document.getElementById('trace-batch-hint');
    const statusEl = document.getElementById('trace-status');
    const resultsEl = document.getElementById('trace-results');
    const poSummaryEl = document.getElementById('trace-po-summary');
    const cardInputs = document.getElementById('trace-card-inputs');
    const cardOutputs = document.getElementById('trace-card-outputs');

    if (!poInput || !resultsEl) return;

    const API_ROOT = (window.location.protocol === 'file:' || !window.location.host)
        ? null
        : `${window.location.protocol}//${window.location.host}`;

    async function fetchJson(apiPath) {
        if (!API_ROOT) {
            throw new Error(
                'Open this page via the API server (e.g. http://localhost:5001/). Do not open the HTML file directly.'
            );
        }
        const url = `${API_ROOT}${apiPath.startsWith('/') ? apiPath : '/' + apiPath}`;
        const resp = await fetch(url);
        const text = await resp.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (_) {
            if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
                throw new Error(
                    `API returned HTML instead of JSON. Use npm start and open http://localhost:5001/`
                );
            }
            throw new Error(`Invalid JSON (HTTP ${resp.status})`);
        }
        if (!resp.ok) {
            throw new Error(json.message || json.error || `HTTP ${resp.status}`);
        }
        return json;
    }

    let poData = null;
    let poView = 'outputs';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function fmtDate(d) {
        if (!d) return '—';
        const dt = new Date(d);
        return isNaN(dt) ? '—' : dt.toLocaleString();
    }

    function setMode(mode) {
        document.querySelectorAll('.trace-mode-tab').forEach((t) => {
            t.classList.toggle('active', t.dataset.mode === mode);
        });
        document.getElementById('trace-panel-po').classList.toggle('active', mode === 'po');
        document.getElementById('trace-panel-batch').classList.toggle('active', mode === 'batch');
        if (batchHintEl) {
            batchHintEl.style.display = mode === 'batch' ? '' : 'none';
        }
        poSummaryEl.classList.remove('visible');
        resultsEl.innerHTML = '';
        statusEl.textContent = '';
    }

    document.querySelectorAll('.trace-mode-tab').forEach((tab) => {
        tab.addEventListener('click', () => setMode(tab.dataset.mode));
    });

    function inputTableRows(items) {
        return items.map((i) => {
            const usedIn = (i.usedInOutputs && i.usedInOutputs.length)
                ? esc(i.usedInOutputs.join(', '))
                : (i.usageStatus === 'issued' || i.usageStatus === 'unused'
                    ? '<span class="trace-warn-pill">Not used yet</span>'
                    : '—');
            const remaining = i.remainingQty != null
                ? i.remainingQty
                : (i.issuedQty != null && i.totalQtyUsed != null
                    ? Math.max(0, Number(i.issuedQty) - Number(i.totalQtyUsed))
                    : null);
            return `
            <tr class="${i.usageStatus === 'issued' || i.usageStatus === 'unused' ? 'trace-row-unused' : ''}">
                <td>${esc(i.itemCode || '—')}</td>
                <td class="trace-batch">${esc(i.batchNumber)}</td>
                <td class="trace-qty">${i.issuedQty != null ? i.issuedQty : '—'}</td>
                <td class="trace-qty">${remaining != null ? remaining : '—'}</td>
                <td>${esc(i.inputType === 'process_batch'
                    ? (i.sourcePoNum ? `PO ${i.sourcePoNum} output` : 'Prev. process output')
                    : (i.warehouse || 'Raw roll'))}</td>
                <td class="trace-meta">${usedIn}</td>
            </tr>`;
        }).join('');
    }

    function detailInputRows(inputs, inputBatchMap) {
        return inputs.map((i) => {
            const meta = inputBatchMap?.get(i.batchNumber) || {};
            const issued = meta.issuedQty != null ? meta.issuedQty : (i.issuedQty != null ? i.issuedQty : '—');
            const remaining = meta.remainingQty != null
                ? meta.remainingQty
                : (i.remainingQty != null ? i.remainingQty : '—');
            return `
            <tr>
                <td>${esc(i.itemCode || '—')}</td>
                <td class="trace-batch">${esc(i.batchNumber)}</td>
                <td class="trace-qty">${issued}</td>
                <td class="trace-qty">${remaining}</td>
                <td class="trace-qty">${i.quantity != null ? i.quantity : '—'}</td>
                <td>${esc(i.inputType === 'process_batch' ? 'Prev. process' : (i.warehouse || 'Raw roll'))}</td>
                <td>${esc(i.operator || '')}<div class="trace-meta">${esc(i.machine || '')}</div></td>
                <td class="trace-meta">${esc(fmtDate(i.usedAt))}</td>
            </tr>`;
        }).join('');
    }

    function renderPOView() {
        if (!poData) return;
        cardInputs.classList.toggle('selected', poView === 'inputs');
        cardOutputs.classList.toggle('selected', poView === 'outputs');

        if (poView === 'inputs') {
            const items = poData.inputBatches || [];
            if (!items.length) {
                resultsEl.innerHTML = '<div class="trace-empty">No input batches issued yet.<br>Issue material to this PO before running the job.</div>';
                return;
            }
            resultsEl.innerHTML = `
                <div class="trace-group">
                    <div class="trace-group-head">
                        <div><span class="trace-arrow">PO ${esc(poData.poNum)} →</span> <strong>Input Batches Issued</strong></div>
                        <span class="trace-pill">${items.length} batch(es)</span>
                    </div>
                    <table class="trace-table">
                        <thead>
                            <tr>
                                <th>Item</th><th>Input Batch</th>
                                <th style="text-align:right">Issued Quantity</th>
                                <th style="text-align:right">Remaining</th>
                                <th>Source</th><th>Used In Output(s)</th>
                            </tr>
                        </thead>
                        <tbody>${inputTableRows(items)}</tbody>
                    </table>
                </div>`;
            return;
        }

        const outputs = poData.outputBatches || [];
        if (!outputs.length) {
            resultsEl.innerHTML = '<div class="trace-empty">No output batches for this PO yet.</div>';
            return;
        }
        const inputBatchMap = new Map(
            (poData.inputBatches || []).map((b) => [b.batchNumber, b])
        );
        resultsEl.innerHTML = outputs.map((o) => {
            const rows = detailInputRows(o.inputs || [], inputBatchMap);
            const warn = o.noInputsRecorded
                ? '<span class="trace-warn-pill"> ⚠ No inputs linked — finish job with input selection</span>'
                : '';
            const completionMeta = (o.completionOperator || o.completionMachine)
                ? `<span class="trace-completion-meta">Report completed by: <strong>${esc(o.completionOperator || '—')}</strong>${o.completionMachine ? ` · ${esc(o.completionMachine)}` : ''}</span>`
                : '';
            return `
                <div class="trace-group">
                    <div class="trace-group-head">
                        <div>
                            <span class="trace-arrow">Output →</span>
                            <a class="trace-out-batch trace-batch-link" href="#" data-batch="${esc(o.outputBatch)}">${esc(o.outputBatch)}</a>
                            ${warn}
                            ${completionMeta}
                        </div>
                        <span class="trace-pill">${o.inputCount || 0} input(s) · ${o.totalInputQty || 0} KGS in${o.outputQty != null ? ` · ${o.outputQty} KGS out` : ''}</span>
                    </div>
                    ${rows ? `<table class="trace-table">
                        <thead>
                            <tr>
                                <th>Item</th><th>Input Batch</th>
                                <th style="text-align:right">Issued Quantity</th>
                                <th style="text-align:right">Remaining</th>
                                <th style="text-align:right">Used Here</th>
                                <th>Source</th><th>Operator</th><th>Used At</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>` : `<div class="trace-empty" style="padding:24px">No inputs linked for this output batch.${o.completionOperator ? `<br>Report completed by <strong>${esc(o.completionOperator)}</strong>${o.completionMachine ? ` (${esc(o.completionMachine)})` : ''}.` : ''}</div>`}
                </div>`;
        }).join('');

        resultsEl.querySelectorAll('a.trace-batch-link').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const bn = a.dataset.batch;
                if (bn) openBatchSearch(bn, poData?.poNum);
            });
        });
    }

    async function suggestBatchOwnerPO() {
        const batch = batchInput?.value.trim();
        if (!batch || !batchPoInput) return;
        try {
            const json = await fetchJson(`/api/traceability/batch-owner/${encodeURIComponent(batch)}`);
            if (json.ownerPo) {
                const current = batchPoInput.value.trim();
                if (!current) {
                    batchPoInput.value = json.ownerPo;
                    statusEl.textContent = `Batch ${batch} belongs to PO ${json.ownerPo}${json.processName ? ` (${json.processName})` : ''} — PO filled automatically.`;
                } else if (current !== json.ownerPo) {
                    statusEl.textContent = `❌ This batch belongs to PO ${json.ownerPo}${json.processName ? ` (${json.processName})` : ''}, not PO ${current}.`;
                    resultsEl.innerHTML = '';
                }
            }
        } catch (_) { /* unknown batch — ignore until search */ }
    }

    function openBatchSearch(batchNum, poNum) {
        setMode('batch');
        const po = String(poNum || poData?.poNum || poInput?.value || '').trim();
        if (batchPoInput) batchPoInput.value = po;
        batchInput.value = batchNum;
        if (!po) {
            statusEl.textContent = '⚠️ Please enter PO — batch trace needs PO number and batch number together.';
            resultsEl.innerHTML = '';
            poSummaryEl.classList.remove('visible');
            batchPoInput?.focus();
            return;
        }
        runBatchSearch();
    }

    async function runPOSearch() {
        const po = poInput.value.trim();
        if (!po) {
            statusEl.textContent = 'Enter a PO number.';
            return;
        }
        statusEl.textContent = 'Loading…';
        resultsEl.innerHTML = '';
        poSummaryEl.classList.remove('visible');
        try {
            const json = await fetchJson(`/api/traceability/by-po/${encodeURIComponent(po)}`);
            if (!json.success) throw new Error(json.message || 'Failed');
            poData = json;
            document.getElementById('trace-input-count').textContent = (json.inputBatches || []).length;
            document.getElementById('trace-output-count').textContent = (json.outputBatches || []).length;
            poSummaryEl.classList.add('visible');
            poView = 'outputs';
            const usedCount = (json.inputBatches || []).filter((b) => (b.totalQtyUsed || 0) > 0).length;
            statusEl.textContent = `PO ${po}: ${(json.inputBatches || []).length} input batch(es) issued (${usedCount} used in production), ${(json.outputBatches || []).length} output batch(es).`;
            renderPOView();
        } catch (e) {
            statusEl.textContent = '❌ ' + (e.message || e);
        }
    }

    async function runBatchSearch() {
        const batch = batchInput.value.trim();
        const po = batchPoInput?.value.trim() || '';
        if (!po) {
            statusEl.textContent = '⚠️ Please enter PO — batch trace needs PO number and batch number together.';
            batchPoInput?.focus();
            return;
        }
        if (!batch) {
            statusEl.textContent = 'Enter an output batch number.';
            batchInput?.focus();
            return;
        }

        // Resolve owning PO before search — batch must match the PO that produced it
        let ownerPo = null;
        let ownerProcess = null;
        try {
            const ownerJson = await fetchJson(`/api/traceability/batch-owner/${encodeURIComponent(batch)}`);
            ownerPo = ownerJson.ownerPo || null;
            ownerProcess = ownerJson.processName || null;
        } catch (_) {
            /* batch-owner API unavailable on older server — validated after by-batch */
        }
        if (ownerPo && ownerPo !== po) {
            const procHint = ownerProcess ? ` (${ownerProcess})` : '';
            statusEl.textContent = `❌ This batch belongs to PO ${ownerPo}${procHint}, not PO ${po}. Use PO ${ownerPo} to trace this batch.`;
            resultsEl.innerHTML = '';
            batchPoInput.value = ownerPo;
            batchPoInput?.focus();
            return;
        }

        statusEl.textContent = 'Loading…';
        resultsEl.innerHTML = '';
        poSummaryEl.classList.remove('visible');
        try {
            const qs = new URLSearchParams({ po: ownerPo || po });
            const json = await fetchJson(
                `/api/traceability/by-batch/${encodeURIComponent(batch)}?${qs}`
            );
            if (!json.success) throw new Error(json.message || 'Failed');
            if (json.poNum && String(json.poNum) !== String(po)) {
                throw new Error(
                    `This batch belongs to PO ${json.poNum}, not PO ${po}. Use PO ${json.poNum} to trace this batch.`
                );
            }
            const resolvedPo = json.poNum || ownerPo || po;
            const inputs = json.inputs || [];
            statusEl.textContent = inputs.length
                ? `PO ${resolvedPo}: ${inputs.length} input(s) used to produce ${batch}`
                : `PO ${resolvedPo}: no report-completion inputs linked for ${batch}. Finish job with input selection.`;

            const hero = `
                <div class="trace-batch-hero">
                    <div class="trace-hero-title">Output Batch</div>
                    <div class="trace-hero-batch-id">${esc(json.outputBatch)}</div>
                    <div class="trace-hero-meta">
                        ${resolvedPo ? `PO ${esc(resolvedPo)}` : ''}
                        ${json.outputQty != null ? ` · Output: <strong>${json.outputQty} KGS</strong>` : ''}
                        ${json.itemCode ? ` · Item: ${esc(json.itemCode)}` : ''}
                        ${json.completionOperator ? ` · Operator: <strong>${esc(json.completionOperator)}</strong>${json.completionMachine ? ` (${esc(json.completionMachine)})` : ''}` : ''}
                    </div>
                </div>`;

            if (!inputs.length) {
                resultsEl.innerHTML = hero + '<div class="trace-empty">No inputs linked at report completion.<br>Use Finish Job and select which rolls/batches were used.</div>';
                return;
            }

            resultsEl.innerHTML = hero + `
                <div class="trace-group">
                    <div class="trace-group-head">
                        <div><span class="trace-arrow">Made from →</span> <strong>Inputs Used</strong></div>
                        <span class="trace-pill">${inputs.length} input(s) · ${json.totalInputQty || 0} KGS used here</span>
                    </div>
                    <table class="trace-table">
                        <thead>
                            <tr>
                                <th>Item</th><th>Input Batch</th>
                                <th style="text-align:right">Issued Quantity</th>
                                <th style="text-align:right">Remaining</th>
                                <th style="text-align:right">Used Here</th>
                                <th>Source</th><th>Operator / Machine</th><th>Used At</th>
                            </tr>
                        </thead>
                        <tbody>${detailInputRows(inputs)}</tbody>
                    </table>
                </div>`;
        } catch (e) {
            statusEl.textContent = '❌ ' + (e.message || e);
        }
    }

    cardInputs.addEventListener('click', () => { poView = 'inputs'; renderPOView(); });
    cardOutputs.addEventListener('click', () => { poView = 'outputs'; renderPOView(); });

    document.getElementById('trace-search-po-btn').addEventListener('click', runPOSearch);
    document.getElementById('trace-search-batch-btn').addEventListener('click', runBatchSearch);
    poInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runPOSearch(); });
    batchInput?.addEventListener('blur', () => { suggestBatchOwnerPO(); });
    batchPoInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runBatchSearch(); });
    batchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runBatchSearch(); });

    window.traceabilityRunFromParams = function runFromParams() {
        const params = new URLSearchParams(location.search);
        if (params.get('batch')) {
            setMode('batch');
            if (batchPoInput) batchPoInput.value = params.get('po') || '';
            batchInput.value = params.get('batch');
            runBatchSearch();
        } else if (params.get('po')) {
            setMode('po');
            poInput.value = params.get('po');
            runPOSearch();
        }
    };
})();
