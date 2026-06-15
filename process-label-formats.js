/**
 * Unit 1 process output label formats — FG-style layout (150mm × 100mm).
 * Each process has its own slip title; HTML structure matches finished-goods packing slip.
 */
(function (global) {
    const PROCESS_LABEL_CONFIG = {
        EMB: { slipTitle: 'EMBOSSING OUTPUT', quantityLabel: 'Output (KGS)', processName: 'Embossing' },
        MET: { slipTitle: 'METALLISATION OUTPUT', quantityLabel: 'Output (KGS)', processName: 'Metallisation' },
        COT: { slipTitle: 'COATING OUTPUT', quantityLabel: 'Output (KGS)', processName: 'Coating' },
        SLT: { slipTitle: 'SLITTING OUTPUT', quantityLabel: 'Output (KGS)', processName: 'Slitting' },
        REW: { slipTitle: 'REWINDING OUTPUT', quantityLabel: 'Output (KGS)', processName: 'Rewinding' },
        default: { slipTitle: 'PROCESS OUTPUT', quantityLabel: 'Output (KGS)', processName: 'Process' }
    };

    /** Per-process HTML templates — same FG-style grid; title/labels from config above. */
    const PROCESS_LABEL_TEMPLATES = {
        EMB: renderStandardProcessLabel,
        MET: renderStandardProcessLabel,
        COT: renderStandardProcessLabel,
        SLT: renderStandardProcessLabel,
        REW: renderStandardProcessLabel,
        default: renderStandardProcessLabel
    };

    function escapeHtml(text) {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function inferProcessTag(job, machineInfo) {
        const u = String(job?.uPCode || '').toUpperCase();
        if (u.includes('EMB')) return 'EMB';
        if (u.includes('MET') || u.includes('MTL')) return 'MET';
        if (u.includes('COT')) return 'COT';
        if (u.includes('SLT')) return 'SLT';
        if (u.includes('REW')) return 'REW';
        const proc = String(machineInfo?.process || '').toLowerCase();
        if (proc.includes('emboss')) return 'EMB';
        if (proc.includes('metall')) return 'MET';
        if (proc.includes('coat')) return 'COT';
        if (proc.includes('slit')) return 'SLT';
        if (proc.includes('rewind')) return 'REW';
        const item = String(job?.itemNo || job?.itemCode || '').toUpperCase();
        if (item.endsWith('-EMB')) return 'EMB';
        if (item.endsWith('-MET') || item.endsWith('-MTL')) return 'MET';
        if (item.endsWith('-COT')) return 'COT';
        if (item.endsWith('-SLT')) return 'SLT';
        if (item.endsWith('-REW')) return 'REW';
        return 'default';
    }

    function getConfig(processTag) {
        return PROCESS_LABEL_CONFIG[processTag] || PROCESS_LABEL_CONFIG.default;
    }

    function formatKgs(n) {
        const v = Number(n) || 0;
        return Math.abs(v - Math.round(v)) < 0.001 ? String(Math.round(v)) : v.toFixed(2);
    }

    function formatMachineDisplayName(name) {
        const raw = String(name || '').trim();
        if (!raw) return '';
        return raw
            .split('-')
            .map((word) => {
                const w = word.trim();
                if (!w) return '';
                return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
            })
            .filter(Boolean)
            .join('-');
    }

    function formatProcessDisplayName(processTag, fallback) {
        const cfg = getConfig(processTag);
        if (cfg.processName) return cfg.processName;
        const fb = String(fallback || '').trim();
        if (fb) return fb.charAt(0).toUpperCase() + fb.slice(1).toLowerCase();
        return 'Process';
    }

    function buildLabelDataFromFinish({
        job,
        machineInfo,
        poNumber,
        outputBatch,
        actualOutput,
        roleUsages,
        operator,
        customerName,
        itemDescription,
        packedOn
    }) {
        const processTag = inferProcessTag(job, machineInfo);
        const cfg = getConfig(processTag);
        const batch = outputBatch || '';
        const barcodeValue = batch.toUpperCase().replace(/[^0-9A-Z \-\.\$\/\+%]/g, '');
        let packedOnStr = packedOn || '';
        if (!packedOnStr) {
            packedOnStr = new Date().toLocaleDateString('en-IN');
        } else if (packedOn instanceof Date || !isNaN(new Date(packedOn).getTime())) {
            const dt = new Date(packedOn);
            if (!isNaN(dt)) packedOnStr = dt.toLocaleDateString('en-IN');
        }
        return {
            processTag,
            slipTitle: cfg.slipTitle,
            quantityLabel: cfg.quantityLabel,
            customerName: customerName || job?.customerName || '—',
            itemDescription: itemDescription || job?.jobName || job?.itemNo || '—',
            fgCode: job?.itemNo || job?.itemCode || '—',
            jobNo: poNumber || job?.poNumber || job?.jobNumber || '—',
            batchNo: batch,
            quantity: formatKgs(actualOutput),
            packedOn: packedOnStr,
            operator: operator || '—',
            machineName: formatMachineDisplayName(machineInfo?.name) || machineInfo?.name || '—',
            processName: formatProcessDisplayName(processTag, machineInfo?.process),
            rolesUsed: Array.isArray(roleUsages) ? roleUsages : [],
            barcodeValue,
            barcodeDisplay: batch || job?.itemNo || ''
        };
    }

    function renderCode39Svg(value) {
        const normalized = String(value || '').toUpperCase();
        if (!normalized) return '';
        const encoded = `*${normalized}*`;
        const patterns = {
            '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
            '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
            'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
            'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
            'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
            'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
            'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
            'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn'
        };
        const narrow = 1;
        const wide = 3;
        let x = 0;
        const bars = [];
        for (let i = 0; i < encoded.length; i++) {
            const pattern = patterns[encoded[i]];
            if (!pattern) continue;
            for (let j = 0; j < pattern.length; j++) {
                if (j % 2 === 0) bars.push({ x, w: pattern[j] === 'w' ? wide : narrow });
                x += pattern[j] === 'w' ? wide : narrow;
            }
            x += 1;
        }
        const height = 60;
        const width = x;
        const rects = bars.map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="${height}" fill="#000"/>`).join('');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects}</svg>`;
    }

    function rolesSummaryHtml(roles) {
        if (!roles.length) return '—';
        return roles.slice(0, 4).map((r) => {
            const bn = r.batch_number || r.batchNumber || '—';
            const q = formatKgs(r.quantity_used ?? r.quantityUsed ?? 0);
            return `${escapeHtml(bn)}: ${q} KGS`;
        }).join('<br/>') + (roles.length > 4 ? `<br/>+${roles.length - 4} more` : '');
    }

    /** FG-style process output label — matches packing slip layout (see finished-goods generateLabelHTML). */
    function renderStandardProcessLabel(data) {
        const barcodeSvg = data.barcodeValue ? renderCode39Svg(data.barcodeValue) : '';
        const rolesHtml = rolesSummaryHtml(data.rolesUsed || []);
        return `
        <div class="label-page">
          <div class="label-page-inner">
            <div class="sap-label">
              <div class="sap-top">
                <div class="sap-logo">
                  <img src="/vk-logo.png" alt="VK logo" onerror="this.style.display='none'">
                </div>
                <div class="sap-company">
                  <strong>VK GLOBAL DIGITAL PRIVATE LIMITED</strong>
                  PLOT NO. 928, SECTOR-68, IMT FARIDABAD,<br/>
                  FARIDABAD - 121004, INDIA
                </div>
              </div>
              <div class="sap-title">${escapeHtml(data.slipTitle || 'PROCESS OUTPUT')}</div>
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
                    <col class="col-k"><col class="col-v"><col class="col-rk"><col class="col-rv">
                  </colgroup>
                  <tr>
                    <td class="k">FG Code</td><td class="v">${escapeHtml(data.fgCode)}</td>
                    <td class="barcode-cell" colspan="2" rowspan="3">
                      <div class="sap-barcode-title">Batch No</div>
                      <div class="sap-barcode">
                        ${barcodeSvg}
                        <div class="code-text">${escapeHtml(data.barcodeDisplay)}</div>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td class="k">Job No</td><td class="v">${escapeHtml(data.jobNo)}</td>
                  </tr>
                  <tr>
                    <td class="k">${escapeHtml(data.quantityLabel || 'Output (KGS)')}</td><td class="v">${escapeHtml(data.quantity)} KGS</td>
                  </tr>
                  <tr>
                    <td class="k">Packed On</td><td class="v">${escapeHtml(data.packedOn)}</td>
                    <td class="rk">Machine</td><td class="rv">${escapeHtml(data.machineName)}</td>
                  </tr>
                  <tr>
                    <td class="k">Operator</td><td class="v">${escapeHtml(data.operator)}</td>
                    <td class="rk">Process</td><td class="rv">${escapeHtml(data.processName)}</td>
                  </tr>
                  <tr>
                    <td class="k">Inputs Used</td><td class="v" colspan="3">${rolesHtml}</td>
                  </tr>
                </table>
              </div>
            </div>
          </div>
        </div>`;
    }

    function generateProcessLabelHTML(data) {
        const tag = data.processTag || inferProcessTag({ itemNo: data.fgCode, uPCode: '' }, { process: data.processName });
        const render = PROCESS_LABEL_TEMPLATES[tag] || PROCESS_LABEL_TEMPLATES.default;
        const cfg = getConfig(tag);
        const merged = {
            ...data,
            slipTitle: data.slipTitle || cfg.slipTitle,
            quantityLabel: data.quantityLabel || cfg.quantityLabel,
            processName: data.processName || cfg.processName
        };
        return render(merged);
    }

    global.ProcessLabelFormats = {
        PROCESS_LABEL_CONFIG,
        PROCESS_LABEL_TEMPLATES,
        inferProcessTag,
        getConfig,
        buildLabelDataFromFinish,
        generateProcessLabelHTML,
        renderStandardProcessLabel,
        renderCode39Svg,
        formatMachineDisplayName,
        formatProcessDisplayName
    };
})(typeof window !== 'undefined' ? window : global);
