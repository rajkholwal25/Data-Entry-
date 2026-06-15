require('dotenv').config();
// Load environment variables
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const net = require('net');  // For raw socket printing to IP printers
const puppeteer = require('puppeteer');
const { PNG } = require('pngjs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const execFileAsync = (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
        execFile(cmd, args, { ...opts, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
const {
    pool,
    testConnection,
    insertJobActivities,
    getActivitiesByBatchNum,
    getBatchesByPO,
    getEmbossingQuantitiesByPO,
    getJobSummary,
    getShiftSummary,
    getActivitiesByMachineAndDate,
    updateBatchActivities,
    getBestPerformance,
    getBatchNum,
    inferUnit1ProcessTagFromItemCode,
    getUnit1ProcessBatchTag,
    parseUnit1BatchSeq,
    deleteRecordsByPO,
    clearPOLocalReset,
    isPOLocallyReset,
    findRecentDuplicateJobCompletion,
    recordMaterialIssues,
    recordMaterialIssueIfAbsent,
    linkOutputBatchToIssues,
    linkIssuesToOutputBatch,
    getIssuedRolesWithRemaining,
    getProcessInputsWithRemaining,
    recordRoleBatchUsages,
    backfillRoleBatchUsageOperators,
    getUnit1BatchNum,
    getGenealogyByPO,
    getGenealogyByOutputBatch,
    getOutputBatchOwnerPO,
    outputBatchBelongsToPO,
    getPOTraceabilitySummary,
    getProcessLabelDataFromDB,
    listOutputBatchesForPO,
    derivePrevProcessInputItemCode,
    getPreviousUnit1ProcessTag,
    formatMachineDisplayName,
    isTerminalUnit1Process,
    isDownstreamUnit1Process
} = require('./db-config');

// Live tracking (operator shift sessions + live machine status/state)
const liveTracking = require('./live-tracking-db');

// Import validation module
const {
    validateQuantities,
    validateTimes,
    validateSpeed,
    validateRequiredFields,
    validateJobCompletion,
    VALIDATION_CONFIG
} = require('./validation');

const path = require('path');
const fs = require('fs');

const app = express();
// Some endpoints (e.g., rendered label printing) legitimately send large payloads.
// Keep this bounded but above the default 100kb.
app.use(express.json({ limit: process.env.EXPRESS_JSON_LIMIT || '15mb' }));
app.use(cors()); // Enable CORS for frontend

// SAP Business One Configuration
const SAP_BASE_URL = process.env.SAP_BASE_URL || 'https://192.168.3.6:50000/b1s/v1';
const SAP_COMPANY_DB = process.env.SAP_COMPANY_DB || 'VKFINALLIVE';
const SAP_USERNAME = process.env.SAP_USERNAME || 'manager';
const SAP_PASSWORD = process.env.SAP_PASSWORD || '8686';
const SAP_POSTING_DATE = process.env.SAP_POSTING_DATE || '';
const SAP_BPL_ID = Number(process.env.SAP_BPL_ID || 1);
const PORT = process.env.PORT || 4000;

// Label printing mode:
// - ZPL: send raw ZPL to printer IP:9100 (existing path)
// - PDF: render a true-size PDF and print via CUPS `lp` (highest fidelity)
let LABEL_PRINT_MODE = String(process.env.LABEL_PRINT_MODE || 'ZPL').toUpperCase();
const CUPS_PRINTER_NAME = (process.env.CUPS_PRINTER_NAME || '').toString().trim();
const CUPS_OPTIONS_RAW = (process.env.CUPS_OPTIONS || '').toString().trim();
/** ZT411 is often a "Local Raw Printer" (socket://IP:9100) — it cannot print PDF; send ZPL with -o raw. */
const LABEL_CUPS_RAW_QUEUE = process.env.LABEL_CUPS_RAW_QUEUE !== 'false';
/** For raw-queue ZPL: render via PDF rasterization (PDF|PNG). PDF keeps layout/barcode aligned with preview. */
const LABEL_ZPL_RENDER_SOURCE = String(process.env.LABEL_ZPL_RENDER_SOURCE || 'PDF').toUpperCase();

// Windows doesn’t ship with CUPS / `lp`. For PDF printing on Windows we use
// Chrome kiosk printing (default) or SumatraPDF CLI (fallback).
const WINDOWS_PDF_PRINTER_NAME = (process.env.WINDOWS_PDF_PRINTER_NAME || CUPS_PRINTER_NAME || '').toString().trim();
const WINDOWS_PDF_PRINT_ENGINE = String(process.env.WINDOWS_PDF_PRINT_ENGINE || 'CHROME').toUpperCase(); // CHROME | SUMATRA
const SUMATRA_PDF_PATH = (process.env.SUMATRA_PDF_PATH || '').toString().trim();
const CHROME_PRINT_PATH = (process.env.CHROME_PRINT_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '').toString().trim();

/** Normalize CUPS server target. Empty = default local socket (/run/cups/cups.sock). */
function resolveCupsServer() {
    let s = (process.env.CUPS_SERVER || '').trim();
    if (!s) return '';
    // libcups does NOT treat "unix://" as a socket URI — it becomes a bogus hostname.
    if (s.startsWith('unix://')) s = s.slice('unix://'.length);
    return s;
}

function getCupsClientEnv() {
    const cupsServer = resolveCupsServer();
    const env = { ...process.env };
    if (cupsServer) {
        env.CUPS_SERVER = cupsServer;
    } else {
        delete env.CUPS_SERVER;
    }
    return env;
}

function withLpServerArgs(args) {
    const server = resolveCupsServer();
    // Host:port → use -h. Unix socket path → use -h /run/cups/cups.sock (CUPS 2.x).
    if (!server) return args;
    return ['-h', server, ...args];
}

function resolveLpCommand() {
    // In minimal containers, `lp` is provided by cups-client and typically lives in /usr/bin/lp.
    const candidates = [
        (process.env.LP_COMMAND || '').toString().trim(),
        '/usr/bin/lp',
        '/bin/lp',
        'lp'
    ].filter(Boolean);

    for (const c of candidates) {
        if (c === 'lp') return 'lp'; // rely on PATH
        try {
            if (fs.existsSync(c)) return c;
        } catch {
            // ignore
        }
    }
    return 'lp';
}

function getSAPPostingDate() {
    const raw = SAP_POSTING_DATE.trim();
    if (!raw) return new Date().toISOString().split('T')[0];

    const ddmmyy = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    if (ddmmyy) {
        const [, dd, mm, yy] = ddmmyy;
        return `20${yy}-${mm}-${dd}`;
    }

    return raw;
}

/** Set DEBUG_PO_LOG=true to log every production order line (verbose; slows busy servers). */
const DEBUG_PO_LOG = process.env.DEBUG_PO_LOG === 'true';

/** Shared https agent — reuses TLS connections to SAP instead of creating a new socket per request. */
const sapHttpsAgent = new (require('https').Agent)({
    rejectUnauthorized: false,
    keepAlive: true,
    maxSockets: 10
});
const SAP_REQUEST_TIMEOUT_MS = parseInt(process.env.SAP_REQUEST_TIMEOUT_MS || '60000', 10);

/** ManBtchNum cache — master data flag that rarely changes. 10-minute TTL avoids repeated SAP calls. */
const batchManagedCache = new Map();
const BATCH_MANAGED_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * In-memory cache for repeated SAP lookups (same session).
 * Only static master/job data is cached here (customer name, job no, item UOM,
 * OSCN substitute, target width) — live values like issued/completed quantity are
 * always fetched fresh, so this never serves stale stock numbers.
 * Default 5 minutes: makes repeat PO searches near-instant. Set 0 to disable.
 */
const SAP_LOOKUP_CACHE_TTL_MS = Math.max(
    0,
    parseInt(process.env.SAP_LOOKUP_CACHE_TTL_MS || '300000', 10) || 0
);
const sapLookupCache = new Map();

/**
 * Some SAP systems don't expose U_CustName/U_CustCode UDFs on ProductionOrder, so the
 * "extended select" 400s on every full PO load (two wasted round-trips before falling back).
 * Once detected, remember it for the session and go straight to the base select.
 */
let poExtendedSelectUnsupported = false;

/**
 * SQL queries (by stable label) that failed with a structural error — missing table/column or
 * no permission. These never recover within a session, yet the SQLQueries round-trip (POST + GET
 * + DELETE) is slow, so re-running them on every new PO is a major drag. Once a label fails
 * structurally we short-circuit it for the rest of the session.
 */
const sqlLabelsKnownUnsupported = new Set();
function isStructuralSqlError(err) {
    const status = err?.response?.status;
    const code = err?.response?.data?.error?.code;
    const msg = (err?.response?.data?.error?.message?.value || err?.message || '').toLowerCase();
    return (
        status === 400 &&
        (code === 702 || code === 703 ||
            msg.includes('not accessible') ||
            msg.includes('not exist') ||
            msg.includes('is invalid'))
    );
}

function getSapLookupCache(key) {
    if (!SAP_LOOKUP_CACHE_TTL_MS) return undefined;
    const e = sapLookupCache.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
        sapLookupCache.delete(key);
        return undefined;
    }
    return e.val;
}

function setSapLookupCache(key, val) {
    if (!SAP_LOOKUP_CACHE_TTL_MS) return;
    sapLookupCache.set(key, { exp: Date.now() + SAP_LOOKUP_CACHE_TTL_MS, val });
    if (sapLookupCache.size > 800) {
        const iter = sapLookupCache.keys();
        const first = iter.next().value;
        if (first !== undefined) sapLookupCache.delete(first);
    }
}

/**
 * Caps how long a single (uncached) enrichment lookup may block PO load.
 * The 5 enrichment lookups run in parallel, so the slowest one decides total time;
 * without this, one slow SAP query could stall a search for 10s+. On timeout we
 * resolve with a safe fallback so the rest of the job still loads instantly.
 */
const ENRICH_LOOKUP_TIMEOUT_MS = parseInt(process.env.ENRICH_LOOKUP_TIMEOUT_MS || '4000', 10);

function withLookupTimeout(promise, fallback, label) {
    if (!ENRICH_LOOKUP_TIMEOUT_MS || ENRICH_LOOKUP_TIMEOUT_MS <= 0) return promise;
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            console.warn(`   ⏱️ Enrichment lookup "${label}" exceeded ${ENRICH_LOOKUP_TIMEOUT_MS}ms — using fallback`);
            resolve(fallback);
        }, ENRICH_LOOKUP_TIMEOUT_MS);
    });
    return Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        timeout
    ]).finally(() => clearTimeout(timer));
}

// ==================== Label Printer Configuration ====================
// Zebra ZT411 Printer Configuration
const LABEL_PRINTER_CONFIG = {
    // Auto-print should be explicitly enabled via env
    enabled: process.env.LABEL_PRINTER_ENABLED === 'true',
    ip: process.env.LABEL_PRINTER_IP || '192.168.3.50',  // Zebra ZT411 IP
    port: parseInt(process.env.LABEL_PRINTER_PORT) || 9100,  // Standard RAW printing port
    timeout: parseInt(process.env.LABEL_PRINTER_TIMEOUT) || 5000,
    printerType: process.env.LABEL_PRINTER_TYPE || 'ZPL',  // Zebra uses ZPL
    dpi: parseInt(process.env.LABEL_PRINTER_DPI) || 203,  // ZT411 is typically 203 or 300 DPI
    // Stock is 10cm (reel width) x 15cm (feed length)
    labelWidth: parseInt(process.env.LABEL_WIDTH_MM) || 100,   // 10cm = 100mm (width)
    labelHeight: parseInt(process.env.LABEL_HEIGHT_MM) || 150, // 15cm = 150mm (length)
    // Layout matches SAP (landscape) printed on portrait stock by rotating fields
    layout: process.env.LABEL_LAYOUT || 'SAP_PACKING_SLIP'
};

console.log(`🖨️ Label Printer: Zebra ZT411 @ ${LABEL_PRINTER_CONFIG.ip}:${LABEL_PRINTER_CONFIG.port} (${LABEL_PRINTER_CONFIG.enabled ? 'ENABLED' : 'DISABLED'})`);
console.log(`   Label Size: ${LABEL_PRINTER_CONFIG.labelWidth}mm x ${LABEL_PRINTER_CONFIG.labelHeight}mm`);
/** When true, FG entry does not print until the client confirms via POST /api/fg-print-labels (preview step). */
const FG_LABEL_PREVIEW_BEFORE_PRINT = process.env.FG_LABEL_PREVIEW_BEFORE_PRINT === 'true';
console.log(`   FG label preview before print: ${FG_LABEL_PREVIEW_BEFORE_PRINT ? 'ON' : 'OFF'}`);
const zplViaCupsRaw = LABEL_CUPS_RAW_QUEUE && !!CUPS_PRINTER_NAME && process.platform !== 'win32';
console.log(`   Label print mode: ${LABEL_PRINT_MODE}${LABEL_PRINT_MODE === 'PDF' ? ` (CUPS queue: ${CUPS_PRINTER_NAME || 'NOT SET'}${LABEL_CUPS_RAW_QUEUE ? `, raw queue → HTML→${LABEL_ZPL_RENDER_SOURCE}→ZPL` : ''})` : zplViaCupsRaw ? ` (pure/native ZPL → raw CUPS: ${CUPS_PRINTER_NAME})` : ' (TCP :9100)'}`);
/**
 * How to generate ZPL for Zebra:
 * - "PURE": generate ZPL directly (no browser/Chromium required) via generateZPLLabel()
 * - "MASTER": render HTML master-template (Puppeteer) -> image -> ZPL (requires Chromium)
 */
const FG_ZPL_RENDER_MODE = String(process.env.FG_ZPL_RENDER_MODE || 'PURE').toUpperCase();
console.log(`   FG ZPL render mode: ${FG_ZPL_RENDER_MODE}`);
/** Overlay native ZPL barcode on MASTER/rendered labels (best scan quality vs rasterized SVG). */
const LABEL_NATIVE_BARCODE = process.env.LABEL_NATIVE_BARCODE !== 'false';
const LABEL_BARCODE_SYMBOLOGY = String(process.env.LABEL_BARCODE_SYMBOLOGY || 'CODE39').toUpperCase();
console.log(`   Label native barcode: ${LABEL_NATIVE_BARCODE ? `ON (pixel-draw ${LABEL_BARCODE_SYMBOLOGY}, PNG path only)` : 'OFF (SVG in HTML/PDF)'}`);
/** Label typography — Calibri requires fonts/*.ttf in Docker build (see fonts/README.md). Carlito is a free fallback. */
const LABEL_FONT_FAMILY = (process.env.LABEL_FONT_FAMILY || 'Calibri, Carlito, Arial, Helvetica, sans-serif').trim();
console.log(`   Label font stack: ${LABEL_FONT_FAMILY}`);
if (LABEL_CUPS_RAW_QUEUE && LABEL_PRINT_MODE === 'PDF') {
    console.log(`   ZPL render source: ${LABEL_ZPL_RENDER_SOURCE} (HTML → ${LABEL_ZPL_RENDER_SOURCE} → bitmap → ^GFA → raw CUPS)`);
}

function extractBarcodeValue(labelData) {
    const itemCodeLabelRaw = (labelData?.itemCodeLabel || '').toString().trim();
    const fromLabel = itemCodeLabelRaw.split(',')[0].trim().toUpperCase().replace(/[^0-9A-Z \-\.\$\/\+%]/g, '');
    if (fromLabel) return fromLabel;
    return (labelData?.fgCode || '').toString().trim().toUpperCase();
}

/** FG label quantity (Unit 1): total produced qty in inventory UOM (e.g. KGS). */
function getLabelQuantityLabel(data) {
    const uom = (data?.inventoryUOM || data?.uom || 'KGS').toString().trim();
    return uom ? `Quantity (${uom})` : 'Quantity';
}

function getLabelQuantityValue(data) {
    const qty = Number(data?.quantity ?? data?.totalQuantity ?? data?.fgQuantity);
    if (!Number.isFinite(qty) || qty <= 0) return '';
    return String(qty);
}

function buildCode39BarSegments(value) {
    const normalized = (value || '').toUpperCase();
    const encoded = `*${normalized}*`;
    const patterns = {
        '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
        '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
        'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
        'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
        'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
        'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
        'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
        'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
        '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
    };
    const narrow = 1;
    const wide = 2;
    const gap = 1;
    const quiet = 10;
    let x = quiet;
    const bars = [];
    for (const ch of encoded) {
        const pattern = patterns[ch];
        if (!pattern) continue;
        for (let i = 0; i < pattern.length; i++) {
            const isBar = i % 2 === 0;
            const w = pattern[i] === 'w' ? wide : narrow;
            if (isBar) bars.push({ start: x, end: x + w });
            x += w;
        }
        x += gap;
    }
    return { bars, totalWidth: x + quiet };
}

function setPngPixelBlack(png, px, py) {
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) return;
    const i = (py * png.width + px) * 4;
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
}

/** Draw crisp Code39 bars directly onto a landscape label PNG at device-pixel coordinates. */
function drawCode39OnPng(png, value, x, y, w, h) {
    const { bars, totalWidth } = buildCode39BarSegments(value);
    if (!bars.length || !totalWidth || w <= 0 || h <= 0) return;
    const barH = Math.max(1, Math.round(h * 0.88));
    for (const bar of bars) {
        const x0 = x + Math.round((bar.start / totalWidth) * w);
        const x1 = x + Math.round((bar.end / totalWidth) * w);
        if (x1 <= x0) continue;
        for (let px = x0; px < x1; px++) {
            for (let py = y; py < y + barH; py++) {
                setPngPixelBlack(png, px, py);
            }
        }
    }
}

function drawCode128OnPng(png, value, x, y, w, h) {
    // Code128 is complex; fall back to Code39 drawing for pixel path unless extended later.
    drawCode39OnPng(png, value, x, y, w, h);
}

function buildBarcodeCellHtml(labelData, options = {}) {
    const itemCodeLabelRaw = (labelData.itemCodeLabel || '').toString().trim();
    const barcodeValue = extractBarcodeValue(labelData);
    const useNative = !!options.nativeBarcode;
    const barcodeGraphic = useNative
        ? '<div class="barcode-placeholder" aria-hidden="true"></div>'
        : (barcodeValue ? renderCode39Svg(barcodeValue) : '');
    const displayCode = itemCodeLabelRaw || (labelData?.fgCode || '').toString().trim();
    const humanText = `<div class="code-text">${escapeHtml(displayCode)}</div>`;
    return `
            <div class="btitle">ItemCode</div>
            <div class="barcode-wrap">${barcodeGraphic}${humanText}</div>`;
}

/**
 * Zebra ZT411 - Label size: 150mm x 100mm (15cm x 10cm) - Landscape
 * 203 DPI = 8 dots/mm, 300 DPI = 12 dots/mm
 * @param {Object} data - Label data
 * @param {number} boxNum - Current box number
 * @param {number} totalBoxes - Total number of boxes
 * @returns {string} ZPL code
 */
function generateZPLLabel(data, boxNum, totalBoxes) {
    // Calculate dimensions in dots
    // 203 DPI: 8 dots/mm, 300 DPI: 12 dots/mm
    const dpmm = LABEL_PRINTER_CONFIG.dpi === 300 ? 12 : 8;
    const labelWidthDots = LABEL_PRINTER_CONFIG.labelWidth * dpmm;   // 150mm = 1200 dots (203dpi)
    const labelHeightDots = LABEL_PRINTER_CONFIG.labelHeight * dpmm; // 100mm = 800 dots (203dpi)
    
    // Truncate long text to fit label
    const truncate = (str, maxLen) => {
        if (!str) return '';
        return str.length > maxLen ? str.substring(0, maxLen - 2) + '..' : str;
    };
    
    const customerName = truncate(data.customerName || '', 45);
    const itemDesc = truncate(data.itemDescription || '', 55);
    const fgCode = truncate(data.fgCode || '', 25);
    const customerCode = truncate(data.customerCode || '', 25);
    const jobNo = truncate(data.jobNo || '', 25);
    const operator = truncate(data.operator || '', 25);
    const batchNo = truncate(data.batchNo || '', 25);

    // Barcode should match the "ItemCode" field shown on the FG label UI.
    // Prefer the first token of itemCodeLabel (same as client), otherwise fall back to FG Code.
    const rawItemCodeLabel = (data.itemCodeLabel || '').toString().trim();
    const barcodeValue = (rawItemCodeLabel.split(',')[0] || '')
        .trim()
        .toUpperCase()
        .replace(/[^0-9A-Z \-\.\$\/\+%]/g, '');
    const barcodeFallback = (data.fgCode || '').toString().trim().toUpperCase();
    const barcodeText = truncate(barcodeValue || barcodeFallback, 32);
    
    // Font sizes for 203 DPI (scale up by 1.5x for 300 DPI)
    const fontScale = LABEL_PRINTER_CONFIG.dpi === 300 ? 1.5 : 1;
    const titleFont = Math.round(36 * fontScale);
    const headerFont = Math.round(26 * fontScale);
    const labelFont = Math.round(22 * fontScale);
    const valueFont = Math.round(26 * fontScale);
    const boxNumFont = Math.round(44 * fontScale);
    const smallFont = Math.round(18 * fontScale);
    
    // Stock is portrait: width = labelWidthDots (100mm), length = labelHeightDots (150mm).
    // Desired SAP layout is landscape. We'll print the SAP layout rotated 90°,
    // but use the FULL label area by scaling the landscape canvas to fit.
    const mm = (v) => Math.round(v * dpmm);
    // Landscape canvas size (SAP reference)
    const W_L_MM = 150;
    const H_L_MM = 100;
    // Fit landscape into portrait by uniform scale (so it fills length; width is reel-limited)
    const scale = Math.min(LABEL_PRINTER_CONFIG.labelHeight / W_L_MM, LABEL_PRINTER_CONFIG.labelWidth / H_L_MM);
    const mapFO = (xMm, yMm) => {
        // scale first (landscape mm -> portrait mm after rotation)
        const xs = xMm * scale;
        const ys = yMm * scale;
        // rotate clockwise: (x,y) -> (y, H - x)
        const xDots = mm(ys);
        const yDots = mm(LABEL_PRINTER_CONFIG.labelHeight - xs);
        return `${xDots},${yDots}`;
    };

    const padMm = 2.5;
    const zpl = `
^XA
^CI28
^PW${labelWidthDots}
^LL${labelHeightDots}
^LH0,0
^FW R

^FX --- Outer border (full 10cm x 15cm) ---
^FO${mm(padMm)},${mm(padMm)}^GB${labelWidthDots - mm(padMm) * 2},${labelHeightDots - mm(padMm) * 2},3,B,28^FS

^FX --- Header / logo in SAP landscape coordinates (150mm x 100mm canvas) ---
^FO${mapFO(5,6)}^A0N,60,60^FDVK^FS
^FO${mapFO(20,7)}^A0N,22,22^FDVK Global^FS
^FO${mapFO(20,14)}^A0N,22,22^FDDigital^FS
^FO${mapFO(20,20)}^A0N,18,18^FDSince 2014^FS

^FO${mapFO(75,6)}^A0N,24,24^FDVK GLOBAL DIGITAL PRIVATE LIMITED^FS
^FO${mapFO(75,12)}^A0N,18,18^FDPLOT NO. 928,SECTOR-68, IMT FARIDABAD,^FS
^FO${mapFO(75,18)}^A0N,18,18^FDFARIDABAD - 121004, India^FS

^FO${mapFO(60,26)}^A0N,40,40^FDPACKING SLIP^FS

^FX --- Fields (SAP order) ---
^FO${mapFO(8,38)}^A0N,26,26^FDCustomer Name^FS
^FO${mapFO(38,38)}^A0N,32,32^FD${customerName}^FS

^FO${mapFO(8,48)}^A0N,26,26^FDItem Description^FS
^FO${mapFO(38,48)}^A0N,30,30^FD${itemDesc}^FS

^FO${mapFO(8,60)}^A0N,26,26^FDFG Code^FS
^FO${mapFO(38,60)}^A0N,32,32^FD${fgCode}^FS

^FO${mapFO(8,70)}^A0N,26,26^FDJob No^FS
^FO${mapFO(38,70)}^A0N,32,32^FD${jobNo}^FS

^FO${mapFO(8,80)}^A0N,26,26^FD${truncate(getLabelQuantityLabel(data), 22)}^FS
^FO${mapFO(38,80)}^A0N,32,32^FD${truncate(getLabelQuantityValue(data), 16)}^FS

^FO${mapFO(8,90)}^A0N,26,26^FDPacked On^FS
^FO${mapFO(38,90)}^A0N,32,32^FD${data.packedOn || ''}^FS

^FO${mapFO(8,100)}^A0N,26,26^FDOperator^FS
^FO${mapFO(38,100)}^A0N,32,32^FD${operator}^FS

^FX --- Right block (barcode + batch) ---
^FO${mapFO(95,60)}^A0N,26,26^FDItemCode^FS
^FO${mapFO(95,66)}^BY3,2,90^B3N,N,90,Y,N^FD${barcodeText}^FS

^FO${mapFO(95,90)}^A0N,26,26^FDBatch No^FS
^FO${mapFO(122,90)}^A0N,32,32^FD${batchNo}^FS

^XZ
`;
    return zpl;
}

/** Unit 1 process output label (embossing etc.) — output batch + input roles used. */
function generateProcessZPLLabel(data) {
    const dpmm = LABEL_PRINTER_CONFIG.dpi === 300 ? 12 : 8;
    const labelWidthDots = LABEL_PRINTER_CONFIG.labelWidth * dpmm;
    const labelHeightDots = LABEL_PRINTER_CONFIG.labelHeight * dpmm;
    const truncate = (str, maxLen) => {
        if (!str) return '';
        const s = String(str);
        return s.length > maxLen ? s.substring(0, maxLen - 2) + '..' : s;
    };
    const mapFO = (xMm, yMm) => {
        const scale = Math.min(LABEL_PRINTER_CONFIG.labelHeight / 150, LABEL_PRINTER_CONFIG.labelWidth / 100);
        const xs = xMm * scale;
        const ys = yMm * scale;
        const mm = (v) => Math.round(v * dpmm);
        return `${mm(ys)},${mm(LABEL_PRINTER_CONFIG.labelHeight - xs)}`;
    };
    const po = truncate(data.poNumber || data.jobNo || '', 20);
    const process = truncate(data.processName || 'Process', 18);
    const batch = truncate(data.outputBatch || data.batchNo || '', 28);
    const output = truncate(String(data.actualOutput ?? data.quantity ?? ''), 12);
    const operator = truncate(data.operator || '', 22);
    const roles = Array.isArray(data.rolesUsed) ? data.rolesUsed : [];
    let roleLines = '';
    let y = 52;
    for (let i = 0; i < Math.min(roles.length, 5); i++) {
        const r = roles[i];
        const line = `${truncate(r.batch_number || r.batchNumber || '', 18)} ${Number(r.quantity_used || r.quantityUsed || 0)} KGS`;
        roleLines += `^FO${mapFO(8, y)}^A0N,22,22^FD${truncate(line, 38)}^FS\n`;
        y += 8;
    }
    if (roles.length > 5) {
        roleLines += `^FO${mapFO(8, y)}^A0N,18,18^FD+${roles.length - 5} more roll(s)^FS\n`;
    }
    const padMm = 2.5;
    const mm = (v) => Math.round(v * dpmm);
    return `
^XA
^CI28
^PW${labelWidthDots}
^LL${labelHeightDots}
^LH0,0
^FW R
^FO${mm(padMm)},${mm(padMm)}^GB${labelWidthDots - mm(padMm) * 2},${labelHeightDots - mm(padMm) * 2},3,B,28^FS
^FO${mapFO(8, 8)}^A0N,36,36^FDPROCESS OUTPUT LABEL^FS
^FO${mapFO(8, 18)}^A0N,24,24^FD${process}^FS
^FO${mapFO(8, 28)}^A0N,26,26^FDPO: ${po}^FS
^FO${mapFO(8, 38)}^A0N,26,26^FDOutput Batch:^FS
^FO${mapFO(42, 38)}^A0N,28,28^FD${batch}^FS
^FO${mapFO(8, 46)}^A0N,24,24^FDRoles Used:^FS
${roleLines}
^FO${mapFO(8, 88)}^A0N,26,26^FDOutput Qty: ${output} KGS^FS
^FO${mapFO(8, 96)}^A0N,22,22^FDOperator: ${operator}^FS
^FO${mapFO(8, 104)}^A0N,20,20^FD${data.packedOn || new Date().toLocaleDateString('en-IN')}^FS
^XZ
`;
}

async function printProcessLabel(labelData, numLabels = 1) {
    const n = Math.max(1, Math.ceil(Number(numLabels) || 1));
    if (!LABEL_PRINTER_CONFIG.enabled) {
        return { success: false, message: 'Auto-printing is disabled', printed: 0 };
    }
    const jobName = `PROC-${String(labelData?.poNumber || 'label')}`.replace(/[^\w.-]+/g, '_');
    let printedCount = 0;
    const errors = [];
    for (let i = 1; i <= n; i++) {
        try {
            const printData = generateProcessZPLLabel(labelData);
            if (LABEL_CUPS_RAW_QUEUE && CUPS_PRINTER_NAME && process.platform !== 'win32') {
                await printRawBufferViaCups(printData, jobName);
            } else {
                await sendToPrinter(printData);
            }
            printedCount++;
        } catch (err) {
            errors.push({ label: i, error: err.message });
        }
    }
    return {
        success: printedCount > 0,
        message: `${printedCount}/${n} process label(s) printed`,
        printed: printedCount,
        total: n,
        errors: errors.length ? errors : null
    };
}

// ---------- HTML master-template auto-print (image -> ZPL) ----------
let browserInstance = null;

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function pickFirstNonEmpty(...values) {
    for (const v of values) {
        if (v === null || v === undefined) continue;
        const s = String(v).trim();
        if (s) return s;
    }
    return '';
}

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

async function fetchOscnSubstitute(itemCode) {
    const code = (itemCode || '').toString().trim();
    if (!code) return '';
    const k = code.replace(/'/g, "''");
    const cacheKey = `oscn:${k}`;
    const cached = getSapLookupCache(cacheKey);
    if (cached !== undefined) return cached;

    const extractSubs = (rows) => {
        const out = [];
        for (const r of rows || []) {
            const cand = pickFirstNonEmpty(
                r.Substitute,
                r.substitute,
                r.CatalogNumber,
                r.catalogNumber,
                r.BpCatalogNumber,
                r.BPcatalogNumber,
                r.BPCatalogNumber,
                r.BP_CatalogNumber
            );
            if (cand && !out.includes(cand)) out.push(cand);
        }
        return out;
    };

    const entities = [
        'AlternateCatNum',
        'ItemCatalogNumbers',
        'BusinessPartnerCatalogNumbers',
        'CatalogNumbers',
        'ItemsCatalogNumbers',
        'ItemCatalogNumberCollection'
    ];

    // 1) Fire all Service Layer OSCN-related requests in parallel (was sequential — high latency).
    const restResults = await Promise.all(
        entities.map(async (entity) => {
            try {
                const select =
                    entity === 'AlternateCatNum'
                        ? 'ItemCode,CardCode,Substitute'
                        : 'Substitute,CatalogNumber,BPCatalogNumber,BpCatalogNumber';
                const data = await sapGetRequest(`/${entity}?$filter=ItemCode eq '${k}'&$select=${select}&$top=20`);
                return extractSubs(data?.value || []);
            } catch {
                return [];
            }
        })
    );
    for (const subs of restResults) {
        if (subs.length) {
            const out = subs.slice(0, 5).join(', ');
            setSapLookupCache(cacheKey, out);
            return out;
        }
    }

    // 2) SQL fallback directly against OSCN (BP Catalog Numbers).
    // This is the most reliable across SL naming/permission differences.
    try {
        const rows = await runSapSqlQuery(
            `SELECT T0."Substitute" FROM OSCN T0 WHERE T0."ItemCode" = '${k}' AND IFNULL(T0."Substitute",'') <> ''`,
            'OSCN_Substitute'
        );
        const subs = (rows || [])
            .map(r => pickFirstNonEmpty(r?.Substitute, r?.substitute))
            .filter(Boolean);
        if (subs.length) {
            const out = [...new Set(subs)].slice(0, 5).join(', ');
            setSapLookupCache(cacheKey, out);
            return out;
        }
    } catch {
        // ignore
    }

    // 3) Fallback to OITM.SupplierCatalogNo if OSCN not populated/accessible
    try {
        const row = await sapGetRequest(`/Items('${k}')?$select=ItemCode,SupplierCatalogNo`);
        const sub = pickFirstNonEmpty(row?.SupplierCatalogNo, row?.supplierCatalogNo);
        if (sub) {
            setSapLookupCache(cacheKey, sub);
            return sub;
        }
    } catch {
        // ignore
    }

    setSapLookupCache(cacheKey, '');
    return '';
}

async function fetchCustomerNameFromOITM_OMRC(itemCode) {
    const code = (itemCode || '').toString().trim();
    if (!code) return '';
    const k = code.replace(/'/g, "''");
    const cacheKey = `custfirm:${k}`;
    const cached = getSapLookupCache(cacheKey);
    if (cached !== undefined) return cached;

    try {
        // Service Layer mapping (typical):
        // - OITM.FirmCode  -> Items.Manufacturer
        // - OMRC.FirmName  -> Manufacturers.ManufacturerName (key usually Manufacturers(Code))
        let manufacturerCode = NaN;
        try {
            const itemRow = await sapGetRequest(`/Items('${k}')?$select=ItemCode,Manufacturer`);
            const v = itemRow?.Manufacturer ?? itemRow?.manufacturer;
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) manufacturerCode = n;
        } catch {
            // ignore
        }

        // Try Service Layer manufacturers endpoint if available in this SAP.
        if (Number.isFinite(manufacturerCode) && manufacturerCode > 0) {
            for (const entity of ['Manufacturers', 'Manufacturer']) {
                try {
                    // Try direct key access first (common)
                    const mf = await sapGetRequest(`/${entity}(${manufacturerCode})?$select=Code,ManufacturerName`);
                    const name = pickFirstNonEmpty(mf?.ManufacturerName, mf?.manufacturerName, mf?.FirmName, mf?.firmName);
                    if (name) {
                        setSapLookupCache(cacheKey, name);
                        return name;
                    }
                } catch {
                    // ignore
                }

                try {
                    // Try filtered collection access
                    const mfData = await sapGetRequest(`/${entity}?$select=Code,ManufacturerName&$filter=Code eq ${manufacturerCode}&$top=1`);
                    const row = (mfData?.value || [])[0];
                    const name = pickFirstNonEmpty(row?.ManufacturerName, row?.manufacturerName, row?.FirmName, row?.firmName);
                    if (name) {
                        setSapLookupCache(cacheKey, name);
                        return name;
                    }
                } catch {
                    // ignore
                }
            }
        }

        // Reliable fallback: one SQL round-trip (was two sequential queries).
        try {
            const joined = await runSapSqlQuery(
                `SELECT T1."FirmName" AS "FirmName" FROM OITM T0 INNER JOIN OMRC T1 ON T0."FirmCode" = T1."FirmCode" WHERE T0."ItemCode" = '${k}'`,
                'OITM_OMRC_FirmName'
            );
            const name = pickFirstNonEmpty(joined?.[0]?.FirmName);
            if (name) {
                setSapLookupCache(cacheKey, name);
                return name;
            }
        } catch {
            // ignore and try legacy two-step
        }
        const rows1 = await runSapSqlQuery(
            `SELECT T0."FirmCode" FROM OITM T0 WHERE T0."ItemCode" = '${k}'`,
            'OITM_FirmCode'
        );
        const firmCodeSql = Number(rows1?.[0]?.FirmCode);
        if (!Number.isFinite(firmCodeSql) || firmCodeSql <= 0) {
            setSapLookupCache(cacheKey, '');
            return '';
        }

        const rows2 = await runSapSqlQuery(
            `SELECT T0."FirmName" FROM OMRC T0 WHERE T0."FirmCode" = ${firmCodeSql}`,
            'OMRC_FirmName'
        );
        const name2 = pickFirstNonEmpty(rows2?.[0]?.FirmName);
        setSapLookupCache(cacheKey, name2 || '');
        return name2;
    } catch {
        setSapLookupCache(cacheKey, '');
        return '';
    }
}

/** Customer name/code from Production Order header UDFs (when present on SL response). */
function pickPoCustomerFields(productionOrder) {
    if (!productionOrder || typeof productionOrder !== 'object') {
        return { name: '', code: '' };
    }
    const name = pickFirstNonEmpty(
        productionOrder.U_CustName,
        productionOrder.u_CustName,
        productionOrder.U_CUSTNAME,
        productionOrder.U_Custname
    );
    const code = pickFirstNonEmpty(
        productionOrder.U_CustCode,
        productionOrder.u_CustCode,
        productionOrder.U_CUSTCODE,
        productionOrder.U_Custcode
    );
    return { name: name || '', code: code || '' };
}

/** Customer name from OMJD line collection: PO.U_JobEnt → OMJD → MJD1.U_PrNa */
function pickCustomerNameFromOmjd(doc) {
    const lines = doc?.MJD1Collection || doc?.mjd1Collection || [];
    if (!Array.isArray(lines)) return '';
    for (const line of lines) {
        const name = pickFirstNonEmpty(line.U_PrNa, line.u_PrNa, line.U_PRNA);
        if (name) return name;
    }
    return '';
}

/** First non-empty sales-order doc num from OMJD MJD1 lines (U_SoNo). */
function pickSoDocNumFromOmjd(doc) {
    const lines = doc?.MJD1Collection || doc?.mjd1Collection || [];
    if (!Array.isArray(lines)) return '';
    for (const line of lines) {
        const soNo = pickFirstNonEmpty(line.U_SoNo, line.u_SoNo, line.U_SONO);
        if (soNo) return soNo;
    }
    return '';
}

/**
 * PO.U_JobEnt → OMJD (Service Layer) → MJD1.U_PrNa (+ optional ORDR.CardCode via MJD1.U_SoNo).
 */
async function fetchCustomerFromOmjdJob(uJobEnt) {
    const docEntry = Number((uJobEnt || '').toString().trim());
    if (!Number.isFinite(docEntry) || docEntry <= 0) {
        return { name: '', code: '' };
    }

    const cacheKey = `omjdcust:${docEntry}`;
    const cached = getSapLookupCache(cacheKey);
    if (cached !== undefined) return cached;

    const tryFetchJobDoc = async (entity) => {
        try {
            return await sapGetRequest(`/${entity}(${docEntry})?$select=DocEntry,MJD1Collection`);
        } catch {
            return null;
        }
    };

    const doc = (await tryFetchJobDoc('OMJD'))
        || (await tryFetchJobDoc('ORJD'))
        || (await tryFetchJobDoc('OCJD'));

    const name = pickCustomerNameFromOmjd(doc);
    let code = '';

    const soDocNum = Number(pickSoDocNumFromOmjd(doc));
    if (Number.isFinite(soDocNum) && soDocNum > 0) {
        try {
            const rows = await runSapSqlQuery(
                `SELECT T0."CardCode" FROM ORDR T0 WHERE T0."DocNum" = ${soDocNum}`,
                'ORDR_CardCode'
            );
            code = pickFirstNonEmpty(rows?.[0]?.CardCode, rows?.[0]?.cardCode) || '';
        } catch {
            try {
                const ord = await sapGetRequest(
                    `/Orders?$select=CardCode&$filter=DocNum eq ${soDocNum}&$top=1`
                );
                code = pickFirstNonEmpty(ord?.value?.[0]?.CardCode) || '';
            } catch {
                // SO lookup optional
            }
        }
    }

    const result = { name: name || '', code: code || '' };
    setSapLookupCache(cacheKey, result);
    return result;
}

/**
 * Resolve customer name for a production order (FG labels, finished-goods page).
 * Priority: PO U_CustName → OMJD MJD1.U_PrNa (via U_JobEnt) → OWOR SQL → OITM FirmName fallback.
 */
async function fetchCustomerNameFromProductionOrder(productionOrder) {
    const fromPo = pickPoCustomerFields(productionOrder);
    if (fromPo.name) return fromPo.name;

    const absEntry = Number(productionOrder?.AbsoluteEntry);
    const jobEnt = Number(productionOrder?.U_JobEnt);
    const cacheKey = `pocustname:${Number.isFinite(absEntry) ? absEntry : 'x'}:${Number.isFinite(jobEnt) ? jobEnt : 'x'}`;
    const cached = getSapLookupCache(cacheKey);
    if (cached !== undefined) return cached;

    if (Number.isFinite(jobEnt) && jobEnt > 0) {
        const fromOmjd = await fetchCustomerFromOmjdJob(jobEnt);
        if (fromOmjd.name) {
            setSapLookupCache(cacheKey, fromOmjd.name);
            return fromOmjd.name;
        }
    }

    if (Number.isFinite(absEntry) && absEntry > 0) {
        try {
            const rows = await runSapSqlQuery(
                `SELECT T0."U_CustName", T0."U_CustCode" FROM OWOR T0 WHERE T0."DocEntry" = ${absEntry}`,
                'OWOR_CustName'
            );
            const row = rows?.[0];
            const name = pickFirstNonEmpty(
                row?.U_CustName, row?.u_CustName, row?.Name, row?.NAME
            );
            if (name) {
                setSapLookupCache(cacheKey, name);
                return name;
            }
        } catch {
            // UDF may not exist on OWOR in this SAP
        }
    }

    setSapLookupCache(cacheKey, '');
    return '';
}

/**
 * Fetch the target produced width (mm) for a production order.
 * Tries the Production Order header UDF (OWOR.U_Width) first, then falls back to the
 * output item master (OITM.U_Width). Returns a positive number or null when unavailable.
 * Used by the first-process (FBD-RM) RM issue dialog to estimate produced qty after slitting.
 */
async function fetchProductionOrderTargetWidth(absoluteEntry, itemCode) {
    const absEntry = Number(absoluteEntry);
    const code = (itemCode || '').toString().trim();
    const cacheKey = `powidth:${Number.isFinite(absEntry) ? absEntry : 'x'}:${code}`;
    const cached = getSapLookupCache(cacheKey);
    if (cached !== undefined) return cached;

    const toPositiveNumber = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    const pickWidth = (row) => {
        if (!row || typeof row !== 'object') return null;
        const candidates = ['U_Width', 'u_width', 'U_WIDTH', 'Width', 'width'];
        for (const key of candidates) {
            if (Object.prototype.hasOwnProperty.call(row, key)) {
                const n = toPositiveNumber(row[key]);
                if (n !== null) return n;
            }
        }
        return null;
    };

    let width = null;

    // 1) Production Order header UDF (OWOR.U_Width), keyed by DocEntry (== AbsoluteEntry).
    if (Number.isFinite(absEntry) && absEntry > 0) {
        try {
            const rows = await runSapSqlQuery(
                `SELECT T0."U_Width" FROM OWOR T0 WHERE T0."DocEntry" = ${absEntry}`,
                'OWOR_U_Width'
            );
            width = pickWidth(rows?.[0]);
        } catch {
            // ignore — UDF may not exist on OWOR in this SAP
        }
    }

    // 2) Fallback: output item master width (OITM.U_Width).
    if (width === null && code) {
        const k = code.replace(/'/g, "''");
        try {
            const rows = await runSapSqlQuery(
                `SELECT T0."U_Width" FROM OITM T0 WHERE T0."ItemCode" = '${k}'`,
                'OITM_U_Width'
            );
            width = pickWidth(rows?.[0]);
        } catch {
            // ignore — UDF may not exist on OITM in this SAP
        }
    }

    setSapLookupCache(cacheKey, width);
    return width;
}

/** Job Num = COALESCE(U_VerEntry, DocNum) from SAP job document row (OMJD / ORJD / OCJD). */
function pickJobNumFromJobDocRow(row, options = {}) {
    if (!row || typeof row !== 'object') return '';
    const verEntry = pickFirstNonEmpty(row.U_VerEntry, row.u_VerEntry);
    if (verEntry) return verEntry;
    const docNum = pickFirstNonEmpty(row.DocNum, row.docNum);
    if (docNum) return docNum;
    if (options.includeUDocNum) {
        return pickFirstNonEmpty(row.U_DocNum, row.u_DocNum);
    }
    return '';
}

function pickJobNumFromUOmjdRow(row) {
    if (!row) return '';
    const fromDoc = pickJobNumFromJobDocRow(row, { includeUDocNum: true });
    if (fromDoc) return fromDoc;
    return pickFirstNonEmpty(row.Name, row.Code);
}

async function fetchJobNoFromUJobEnt(uJobEnt) {
    const docEntry = Number((uJobEnt || '').toString().trim());
    if (!Number.isFinite(docEntry) || docEntry <= 0) return '';

    const cacheKey = `jobno:${docEntry}`;
    const cached = getSapLookupCache(cacheKey);
    if (cached !== undefined) return cached;

    const tryGet = async (endpoint, pick) => {
        try {
            const data = await sapGetRequest(endpoint);
            return pick(data);
        } catch {
            return '';
        }
    };

    const jobDocSelect = 'DocEntry,DocNum,U_VerEntry';
    const jobDocEntities = ['OMJD', 'ORJD', 'OCJD'];
    const attempts = [];

    for (const entity of jobDocEntities) {
        attempts.push(
            tryGet(`/${entity}(${docEntry})?$select=${jobDocSelect}`, (d) => pickJobNumFromJobDocRow(d)),
            tryGet(
                `/${entity}?$select=${jobDocSelect}&$filter=DocEntry eq ${docEntry}&$top=1`,
                (d) => pickJobNumFromJobDocRow(d?.value?.[0])
            )
        );
    }

    attempts.push(
        tryGet(
            `/U_OMJD?$select=DocEntry,DocNum,U_VerEntry,U_DocNum&$filter=DocEntry eq ${docEntry}&$top=1`,
            (d) => pickJobNumFromUOmjdRow(d?.value?.[0])
        ),
        tryGet(
            `/U_OMJD?$select=Code,Name,U_VerEntry,U_DocNum,DocNum&$filter=Code eq '${docEntry}'&$top=1`,
            (d) => pickJobNumFromUOmjdRow(d?.value?.[0])
        )
    );

    const results = await Promise.all(attempts);

    for (const v of results) {
        if (v) {
            const out = String(v).trim();
            setSapLookupCache(cacheKey, out);
            return out;
        }
    }
    setSapLookupCache(cacheKey, '');
    return '';
}

/** Inventory UOM from OITM (same unit as PO planned/issued qty for FG item). */
async function fetchItemInventoryUOM(itemCode) {
    const code = (itemCode || '').toString().trim();
    if (!code) return '';

    const cacheKey = `itemuom:${code}`;
    const cached = getSapLookupCache(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const data = await sapGetRequest(
            `/Items('${encodeURIComponent(code)}')?$select=ItemCode,InventoryUOM`
        );
        const uom = pickFirstNonEmpty(data?.InventoryUOM, data?.inventoryUOM) || '';
        setSapLookupCache(cacheKey, uom);
        return uom;
    } catch {
        setSapLookupCache(cacheKey, '');
        return '';
    }
}

function renderCode39Svg(value) {
    const { bars, totalWidth } = buildCode39BarSegments(value);
    const rects = bars.map(b => `<rect x="${b.start}" y="0" width="${b.end - b.start}" height="60" fill="#000"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(totalWidth, 1)} 60" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`;
}

let cachedLogoDataUri = undefined;
function getLogoDataUri() {
    if (cachedLogoDataUri !== undefined) return cachedLogoDataUri;
    try {
        const p = path.join(__dirname, 'vk-logo.png');
        const buf = fs.readFileSync(p);
        cachedLogoDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
        cachedLogoDataUri = '';
    }
    return cachedLogoDataUri;
}

function buildMasterLabelHTML(data, boxNum, totalBoxes, options = {}) {
    const nativeBarcode = options.nativeBarcode === true;
    const logoSrc = getLogoDataUri();
    const barcodePlaceholderCss = nativeBarcode
        ? '.barcode-placeholder{height:12mm;width:55mm;margin:0 auto}'
        : '';
    // Render in LANDSCAPE (150mm x 100mm) — NO rotation. Rotation happens in code after screenshot.
    return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:150mm;height:100mm;background:#fff;font-family:${LABEL_FONT_FAMILY};color:#000;font-weight:400}
  .label{
    width:150mm;height:100mm;padding:5mm 6mm;
    border:1.5px solid #222;border-radius:3mm;
  }
  .top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2mm}
  .logo-block{display:flex;align-items:flex-start}
  .logo-img{width:28.75mm;height:auto;display:block}
  .company{text-align:right;font-size:3.3mm;line-height:1.25}
  .company b{display:block;font-size:3.4mm;letter-spacing:0.15mm;font-weight:700}
  .title{text-align:center;font-weight:700;font-size:6.2mm;margin:2.2mm 0 3mm;letter-spacing:0.25mm}
  .fields{font-size:4.2mm}
  table{border-collapse:collapse}
  .fields-table{width:100%}
  .fields-table td{padding:0.8mm 0;vertical-align:baseline}
  .fields-table .k{width:30mm;color:#333}
  .fields-table .v{font-weight:600}
  .two{margin-top:1mm}
  .details-grid{width:100%;table-layout:fixed}
  .details-grid .barcode-cell{width:58mm;text-align:center;vertical-align:top;padding-left:2mm}
  .details-grid td{padding:0.8mm 0;vertical-align:top}
  .details-grid .k{width:30mm;color:#333;vertical-align:baseline}
  .details-grid .v{font-weight:600;vertical-align:baseline}
  .details-grid .rk{width:22mm;color:#333;vertical-align:baseline}
  .details-grid .rv{font-weight:600;vertical-align:baseline}
  .btitle{font-size:3.8mm;font-weight:500;margin:0 0 0.8mm 0;text-align:center}
  .barcode-wrap{text-align:center}
  .barcode-wrap svg{width:55mm;height:12mm;display:block;margin:0 auto}
  .code-text{font-size:3.9mm;letter-spacing:0.45mm;font-weight:500;text-align:center;margin-top:0.5mm}
  ${barcodePlaceholderCss}
</style></head>
<body>
<div class="label">
  <div class="top">
    <div class="logo-block">
      ${logoSrc ? `<img class="logo-img" src="${logoSrc}" alt="VK logo">` : ''}
    </div>
    <div class="company"><b>VK GLOBAL DIGITAL PRIVATE LIMITED</b>PLOT NO. 928, SECTOR-68, IMT FARIDABAD,<br>FARIDABAD - 121004, INDIA</div>
  </div>
  <div class="title">PACKING SLIP</div>
  <div class="fields">
    <table class="fields-table">
      <tr><td class="k">Customer Name</td><td class="v">${escapeHtml(data.customerName)}</td></tr>
      <tr><td class="k">Item Description</td><td class="v">${escapeHtml(data.itemDescription)}</td></tr>
    </table>
    <div class="two">
      <table class="details-grid">
        <tr>
          <td class="k">FG Code</td><td class="v">${escapeHtml(data.fgCode)}</td>
          <td class="barcode-cell" colspan="2" rowspan="3">
            ${buildBarcodeCellHtml(data, { nativeBarcode })}
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
</body></html>`;
}

function buildMasterLabelDocumentHeadCss() {
    return `
  *{margin:0;padding:0;box-sizing:border-box}
  /* Each PDF page is exactly the label size */
  @page{size:150mm 100mm;margin:0}
  html,body{width:150mm;height:100mm;background:#fff;font-family:${LABEL_FONT_FAMILY};color:#000;font-weight:400}
  .page{width:150mm;height:100mm;page-break-after:always}
  .page:last-child{page-break-after:auto}
  .label{
    width:150mm;height:100mm;padding:5mm 6mm;
    border:1.5px solid #222;border-radius:3mm;
  }
  .top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2mm}
  .logo-block{display:flex;align-items:flex-start}
  .logo-img{width:28.75mm;height:auto;display:block}
  .company{text-align:right;font-size:3.3mm;line-height:1.25}
  .company b{display:block;font-size:3.4mm;letter-spacing:0.15mm;font-weight:700}
  .title{text-align:center;font-weight:700;font-size:6.2mm;margin:2.2mm 0 3mm;letter-spacing:0.25mm}
  .fields{font-size:4.2mm}
  table{border-collapse:collapse}
  .fields-table{width:100%}
  .fields-table td{padding:0.8mm 0;vertical-align:baseline}
  .fields-table .k{width:30mm;color:#333}
  .fields-table .v{font-weight:600}
  .two{margin-top:1mm}
  .details-grid{width:100%;table-layout:fixed}
  .details-grid .barcode-cell{width:58mm;text-align:center;vertical-align:top;padding-left:2mm}
  .details-grid td{padding:0.8mm 0;vertical-align:top}
  .details-grid .k{width:30mm;color:#333;vertical-align:baseline}
  .details-grid .v{font-weight:600;vertical-align:baseline}
  .details-grid .rk{width:22mm;color:#333;vertical-align:baseline}
  .details-grid .rv{font-weight:600;vertical-align:baseline}
  .btitle{font-size:3.8mm;font-weight:500;margin:0 0 0.8mm 0;text-align:center}
  .barcode-wrap{text-align:center}
  /* Keep the barcode crisp in PDF */
  .barcode-wrap svg{width:55mm;height:12mm;display:block;margin:0 auto;shape-rendering:crispEdges}
  .code-text{font-size:3.9mm;letter-spacing:0.45mm;font-weight:500;text-align:center;margin-top:0.5mm}
`;
}

function buildMasterLabelInnerHTML(data, boxNum, totalBoxes) {
    const logoSrc = getLogoDataUri();
    return `
<div class="label">
  <div class="top">
    <div class="logo-block">
      ${logoSrc ? `<img class="logo-img" src="${logoSrc}" alt="VK logo">` : ''}
    </div>
    <div class="company"><b>VK GLOBAL DIGITAL PRIVATE LIMITED</b>PLOT NO. 928, SECTOR-68, IMT FARIDABAD,<br>FARIDABAD - 121004, INDIA</div>
  </div>
  <div class="title">PACKING SLIP</div>
  <div class="fields">
    <table class="fields-table">
      <tr><td class="k">Customer Name</td><td class="v">${escapeHtml(data.customerName)}</td></tr>
      <tr><td class="k">Item Description</td><td class="v">${escapeHtml(data.itemDescription)}</td></tr>
    </table>
    <div class="two">
      <table class="details-grid">
        <tr>
          <td class="k">FG Code</td><td class="v">${escapeHtml(data.fgCode)}</td>
          <td class="barcode-cell" colspan="2" rowspan="3">
            ${buildBarcodeCellHtml(data, { nativeBarcode: false })}
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
</div>`;
}

function buildMasterLabelsHTML(labelData, numLabels) {
    const pages = [];
    for (let i = 1; i <= numLabels; i++) {
        pages.push(`<div class="page">${buildMasterLabelInnerHTML(labelData, i, numLabels)}</div>`);
    }
    return `<!doctype html>
<html><head><meta charset="utf-8">
<style>${buildMasterLabelDocumentHeadCss()}</style></head>
<body>${pages.join('\n')}</body></html>`;
}

async function getBrowser() {
    // Puppeteer can occasionally crash/disconnect; keep this resilient so we don't fall back to legacy ZPL.
    try {
        if (browserInstance && typeof browserInstance.isConnected === 'function' && !browserInstance.isConnected()) {
            browserInstance = null;
        }
    } catch {
        browserInstance = null;
    }

    if (!browserInstance) {
        const fs = require('fs');
        const envPath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').toString().trim();
        const bundledPath =
            typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : '';

        let executablePath = envPath || bundledPath;
        if (executablePath && !fs.existsSync(executablePath)) {
            console.warn(
                `⚠️ Puppeteer executable not found at: ${executablePath}. ` +
                `Will try launching without explicit executablePath. ` +
                `Set PUPPETEER_EXECUTABLE_PATH to a valid Chrome/Chromium path to fix permanently.`
            );
            executablePath = '';
        }

        const launchOptions = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };
        if (executablePath) {
            launchOptions.executablePath = executablePath;
        }

        browserInstance = await puppeteer.launch(launchOptions);

        try {
            browserInstance.on('disconnected', () => {
                console.warn('⚠️ Puppeteer browser disconnected; will relaunch on next label render');
                browserInstance = null;
            });
        } catch {
            // ignore
        }
    }

    return browserInstance;
}

async function renderLabelPngBuffer(labelData, boxNum, totalBoxes) {
    // Render at LANDSCAPE size (150mm x 100mm) — the natural SAP layout.
    const landscapeWidthMm = 150;
    const landscapeHeightMm = 100;
    const cssPxPerMm = 96 / 25.4;
    const dpmm = LABEL_PRINTER_CONFIG.dpi === 300 ? 12 : 8;
    const deviceScaleFactor = dpmm / cssPxPerMm;

    const cssW = Math.round(landscapeWidthMm * cssPxPerMm);
    const cssH = Math.round(landscapeHeightMm * cssPxPerMm);

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: cssW, height: cssH, deviceScaleFactor });
        await page.emulateMediaType('screen');
        await page.setContent(buildMasterLabelHTML(labelData, boxNum, totalBoxes, {
            nativeBarcode: LABEL_NATIVE_BARCODE
        }), { waitUntil: 'domcontentloaded' });

        let barArea = null;
        if (LABEL_NATIVE_BARCODE) {
            barArea = await page.evaluate(() => {
                const el = document.querySelector('.barcode-placeholder');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, width: r.width, height: r.height };
            });
        }

        let pngBuffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: cssW, height: cssH } });

        if (LABEL_NATIVE_BARCODE && barArea && barArea.width > 0 && barArea.height > 0) {
            const value = extractBarcodeValue(labelData);
            if (value) {
                const landscapePng = PNG.sync.read(pngBuffer);
                const px = Math.round(barArea.x * deviceScaleFactor);
                const py = Math.round(barArea.y * deviceScaleFactor);
                const pw = Math.round(barArea.width * deviceScaleFactor);
                const ph = Math.round(barArea.height * deviceScaleFactor);
                if (LABEL_BARCODE_SYMBOLOGY === 'CODE128') {
                    drawCode128OnPng(landscapePng, value, px, py, pw, ph);
                } else {
                    drawCode39OnPng(landscapePng, value, px, py, pw, ph);
                }
                pngBuffer = PNG.sync.write(landscapePng);
                console.log(`   Barcode pixel-draw @ landscape (${px},${py}) ${pw}x${ph}px [${value}]`);
            }
        }

        return pngBuffer;
    } finally {
        await page.close();
    }
}

async function renderLabelPdfPageBuffer(labelData, boxNum, totalBoxes) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
        await page.emulateMediaType('screen');
        const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${buildMasterLabelDocumentHeadCss()}</style></head>
<body><div class="page">${buildMasterLabelInnerHTML(labelData, boxNum, totalBoxes)}</div></body></html>`;
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        return await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            width: '150mm',
            height: '100mm',
            margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
        });
    } finally {
        await page.close();
    }
}

function resolvePdftoppmCommand() {
    const candidates = ['/usr/bin/pdftoppm', 'pdftoppm'];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch {
            // ignore
        }
    }
    return 'pdftoppm';
}

/** Rasterize a single-page PDF to PNG at printer DPI (poppler pdftoppm). */
async function pdfBufferToPngBuffer(pdfBuffer, dpi = 300) {
    const pdftoppm = resolvePdftoppmCommand();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fg-label-pdf-'));
    const pdfPath = path.join(tmpDir, 'label.pdf');
    const outPrefix = path.join(tmpDir, 'page');
    const pngPath = `${outPrefix}.png`;
    try {
        await fs.promises.writeFile(pdfPath, pdfBuffer);
        await execFileAsync(pdftoppm, ['-png', '-r', String(dpi), '-singlefile', pdfPath, outPrefix]);
        return await fs.promises.readFile(pngPath);
    } finally {
        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

async function renderLabelsPdfBuffer(labelData, numLabels) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        // Use a reasonably large viewport so layout resolves consistently.
        // PDF page sizing is controlled by @page + explicit width/height below.
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
        await page.emulateMediaType('screen');
        await page.setContent(buildMasterLabelsHTML(labelData, numLabels), { waitUntil: 'domcontentloaded' });
        return await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            width: '150mm',
            height: '100mm',
            margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
        });
    } finally {
        await page.close();
    }
}

function parseCupsOptions(raw) {
    const s = (raw || '').toString().trim();
    if (!s) return [];
    // Accept "k=v,k2=v2" or "k=v; k2=v2" or "k=v k2=v2"
    return s
        .split(/[,;]\s*|\s{2,}/g)
        .map(x => x.trim())
        .filter(Boolean);
}

/** List CUPS printer queue names visible to `lp` (host or container). */
async function listCupsPrinterQueues() {
    const lpCmd = resolveLpCommand();
    const lpstat = lpCmd.replace(/lp$/i, 'lpstat');
    const lpstatCmd = fs.existsSync(lpstat) ? lpstat : 'lpstat';
    try {
        const { stdout } = await execFileAsync(lpstatCmd, withLpServerArgs(['-p']), { env: getCupsClientEnv() });
        const names = [];
        for (const line of stdout.split('\n')) {
            const m = line.match(/^printer\s+(\S+)/i);
            if (m) names.push(m[1]);
        }
        return names;
    } catch (e) {
        return { error: e.stderr || e.message || String(e) };
    }
}

async function printPdfBufferViaCups(pdfBuffer, jobName = 'fg-label') {
    if (!CUPS_PRINTER_NAME) {
        throw new Error('CUPS_PRINTER_NAME is not set (required for PDF printing)');
    }
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fg-label-'));
    const pdfPath = path.join(tmpDir, `${jobName}.pdf`);
    await fs.promises.writeFile(pdfPath, pdfBuffer);

    const cupsOptions = parseCupsOptions(CUPS_OPTIONS_RAW);
    let args = ['-d', CUPS_PRINTER_NAME, '-t', jobName];
    for (const opt of cupsOptions) {
        args.push('-o', opt);
    }
    args.push(pdfPath);
    args = withLpServerArgs(args);

    const lpCmd = resolveLpCommand();
    await new Promise((resolve, reject) => {
        const child = spawn(lpCmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: getCupsClientEnv() });
        let out = '';
        let err = '';
        child.stdout.on('data', d => (out += d.toString()));
        child.stderr.on('data', d => (err += d.toString()));
        child.on('error', (e) => {
            if (e && e.code === 'ENOENT') {
                return reject(
                    new Error(
                        `Cannot execute "${lpCmd}" (ENOENT). ` +
                        `Install CUPS client tools (Debian/Ubuntu: "apt-get update && apt-get install -y cups-client") ` +
                        `and make sure the container/image is rebuilt, or set LP_COMMAND to the full path of lp.`
                    )
                );
            }
            reject(e);
        });
        child.on('close', async (code) => {
            if (code === 0) {
                const jobInfo = (out || err || '').trim();
                if (jobInfo) console.log(`   lp: ${jobInfo}`);
                return resolve();
            }
            let msg = `lp failed (exit ${code}): ${err || out}`.trim();
            if (/does not exist/i.test(msg)) {
                const queues = await listCupsPrinterQueues();
                const list = Array.isArray(queues) ? queues : [];
                const hint = list.length
                    ? `Available CUPS queues: ${list.join(', ')}. Set CUPS_PRINTER_NAME to one of these (exact spelling).`
                    : 'No CUPS queues found. On Docker, mount the host CUPS socket (see docker-compose.yml). On Ubuntu, add the printer with lpadmin or the Printers UI, then run: lpstat -p';
                msg += `. ${hint}`;
            } else if (/scheduler is not running/i.test(msg)) {
                msg +=
                    '. Docker: mount /run/cups:/run/cups:ro, leave CUPS_SERVER empty (uses host socket), ' +
                    'or set CUPS_SERVER=host.docker.internal:631 and allow Docker in /etc/cups/cupsd.conf. ' +
                    'Rebuild: docker compose up -d --build';
            }
            reject(new Error(msg));
        });
    });

    // Best-effort cleanup
    try { await fs.promises.unlink(pdfPath); } catch {}
    try { await fs.promises.rmdir(tmpDir); } catch {}
}

/** Send raw bytes (ZPL) to a CUPS queue configured as "Local Raw Printer". */
async function printRawBufferViaCups(data, jobName = 'fg-label') {
    if (!CUPS_PRINTER_NAME) {
        throw new Error('CUPS_PRINTER_NAME is not set (required for raw CUPS printing)');
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fg-label-'));
    const filePath = path.join(tmpDir, `${jobName}.zpl`);
    await fs.promises.writeFile(filePath, buf);

    let args = ['-d', CUPS_PRINTER_NAME, '-o', 'raw', '-t', jobName, filePath];
    args = withLpServerArgs(args);

    const lpCmd = resolveLpCommand();
    await new Promise((resolve, reject) => {
        const child = spawn(lpCmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: getCupsClientEnv() });
        let out = '';
        let err = '';
        child.stdout.on('data', d => (out += d.toString()));
        child.stderr.on('data', d => (err += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                const jobInfo = (out || err || '').trim();
                if (jobInfo) console.log(`   lp (raw): ${jobInfo}`);
                return resolve();
            }
            reject(new Error(`lp raw failed (exit ${code}): ${err || out}`.trim()));
        });
    });

    try { await fs.promises.unlink(filePath); } catch {}
    try { await fs.promises.rmdir(tmpDir); } catch {}
}

/**
 * Print labels on a raw CUPS queue (lp -o raw).
 * @param {boolean} [options.useMaster] - true: HTML→bitmap ^GFA; false: native ZPL ^B3N barcode (best scan quality)
 */
async function printLabelsViaZplRawCups(labelData, numLabels, jobPrefix, options = {}) {
    const useMaster = options.useMaster === true;
    let printed = 0;
    const errors = [];
    for (let i = 1; i <= numLabels; i++) {
        try {
            const zpl = useMaster
                ? await generateZPLFromMasterTemplate(labelData, i, numLabels)
                : generateZPLLabel(labelData, i, numLabels);
            await printRawBufferViaCups(zpl, `${jobPrefix}-${i}`);
            printed++;
            console.log(`   ✅ Label ${i}/${numLabels} sent (${useMaster ? 'rendered' : 'pure'} ZPL, raw CUPS)`);
            if (i < numLabels) await new Promise(r => setTimeout(r, 300));
        } catch (e) {
            errors.push({ label: i, error: e.message });
            console.error(`   ❌ Label ${i}/${numLabels} failed:`, e.message);
        }
    }
    if (printed === 0) {
        throw new Error(errors[0]?.error || 'All labels failed to print');
    }
    return { printed, total: numLabels, errors: errors.length ? errors : null };
}

function resolveSumatraPdfPath() {
    const candidates = [
        SUMATRA_PDF_PATH,
        'C:\\\\Program Files\\\\SumatraPDF\\\\SumatraPDF.exe',
        'C:\\\\Program Files (x86)\\\\SumatraPDF\\\\SumatraPDF.exe'
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch {
            // ignore
        }
    }
    return null;
}

function resolveChromePath() {
    const candidates = [
        CHROME_PRINT_PATH,
        'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
        'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe'
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch {
            // ignore
        }
    }
    return null;
}

async function printPdfBufferViaChromeWindows(pdfBuffer, jobName = 'fg-label') {
    // Chrome kiosk printing prints to the Windows DEFAULT printer.
    const exe = resolveChromePath();
    if (!exe) {
        throw new Error(
            'Chrome executable not found for PDF printing. ' +
            'Set CHROME_PRINT_PATH (or PUPPETEER_EXECUTABLE_PATH) to chrome.exe.'
        );
    }

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fg-label-'));
    const pdfPath = path.join(tmpDir, `${jobName}.pdf`);
    await fs.promises.writeFile(pdfPath, pdfBuffer);

    // Convert to file:/// URL for Chrome.
    const pdfUrl = `file:///${pdfPath.replace(/\\\\/g, '/')}`;

    // IMPORTANT:
    // `--kiosk-printing` only suppresses the print dialog. It does NOT automatically
    // print a PDF just by opening it. We must open an HTML shim that calls window.print().
    const shimPath = path.join(tmpDir, `${jobName}.print.html`);
    const shimHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Printing...</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; }
      iframe { width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe id="pdf" src="${pdfUrl}"></iframe>
    <script>
      // Wait a bit for Chrome PDF viewer to initialize, then print.
      // Kiosk printing will route to the default printer without UI.
      function go() {
        try { window.focus(); } catch (e) {}
        setTimeout(() => {
          try { window.print(); } catch (e) {}
          // Give the spooler a moment, then close the window.
          setTimeout(() => { try { window.close(); } catch (e) {} }, 1200);
        }, 1200);
      }
      // Run on load; iframe load events are not reliable for PDF viewer.
      window.addEventListener('load', go);
    </script>
  </body>
</html>`;
    await fs.promises.writeFile(shimPath, shimHtml, 'utf8');
    const shimUrl = `file:///${shimPath.replace(/\\\\/g, '/')}`;

    // Use a dedicated profile dir so Chrome can run non-interactively.
    const profileDir = path.join(tmpDir, 'chrome-profile');

    // NOTE: Chrome cannot reliably force a specific printer name via CLI.
    // It prints to the Windows default printer when --kiosk-printing is set.
    const args = [
        '--kiosk-printing',
        '--disable-print-preview',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        '--new-window',
        shimUrl
    ];

    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Give Chrome time to open the PDF and spool the job, then close it.
    await new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        child.stdout.on('data', d => (out += d.toString()));
        child.stderr.on('data', d => (err += d.toString()));
        child.on('error', reject);

        const killAfterMs = Math.max(3000, parseInt(process.env.CHROME_PRINT_KILL_AFTER_MS || '8000', 10) || 8000);
        const t = setTimeout(() => {
            try { child.kill(); } catch {}
            resolve();
        }, killAfterMs);

        child.on('close', (code) => {
            clearTimeout(t);
            // Chrome might exit quickly or stay open; neither is a hard failure.
            // Only treat nonzero as error if it exited before our timeout.
            if (code && code !== 0) {
                return reject(new Error(`Chrome print exited (code ${code}): ${err || out}`.trim()));
            }
            resolve();
        });
    });

    // Best-effort cleanup
    try { await fs.promises.unlink(pdfPath); } catch {}
    try { await fs.promises.unlink(shimPath); } catch {}
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
}

async function printPdfBufferViaWindows(pdfBuffer, jobName = 'fg-label') {
    const printerName = WINDOWS_PDF_PRINTER_NAME;
    if (!printerName) {
        throw new Error('WINDOWS_PDF_PRINTER_NAME (or CUPS_PRINTER_NAME) is not set (required for PDF printing on Windows)');
    }

    const exe = resolveSumatraPdfPath();
    if (!exe) {
        throw new Error(
            'PDF printing on Windows requires SumatraPDF. ' +
            'Install SumatraPDF and set SUMATRA_PDF_PATH to SumatraPDF.exe, ' +
            'or install it to `C:\\Program Files\\SumatraPDF\\SumatraPDF.exe`.'
        );
    }

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fg-label-'));
    const pdfPath = path.join(tmpDir, `${jobName}.pdf`);
    await fs.promises.writeFile(pdfPath, pdfBuffer);

    // SumatraPDF command line:
    //   SumatraPDF.exe -print-to "Printer Name" -silent "file.pdf"
    const args = ['-print-to', printerName, '-silent', pdfPath];

    await new Promise((resolve, reject) => {
        const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', d => (out += d.toString()));
        child.stderr.on('data', d => (err += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) return resolve();
            reject(new Error(`SumatraPDF print failed (exit ${code}): ${err || out}`.trim()));
        });
    });

    // Best-effort cleanup
    try { await fs.promises.unlink(pdfPath); } catch {}
    try { await fs.promises.rmdir(tmpDir); } catch {}
}

function rotatePng90CW(png) {
    const srcW = png.width;
    const srcH = png.height;
    const dstW = srcH;
    const dstH = srcW;
    const dst = new PNG({ width: dstW, height: dstH });
    for (let sy = 0; sy < srcH; sy++) {
        for (let sx = 0; sx < srcW; sx++) {
            const si = (sy * srcW + sx) * 4;
            const dx = srcH - 1 - sy;
            const dy = sx;
            const di = (dy * dstW + dx) * 4;
            dst.data[di]     = png.data[si];
            dst.data[di + 1] = png.data[si + 1];
            dst.data[di + 2] = png.data[si + 2];
            dst.data[di + 3] = png.data[si + 3];
        }
    }
    return dst;
}

function scalePngNearest(srcPng, targetW, targetH) {
    // Nearest-neighbor scaling is fast and works well for monochrome thresholding later.
    const dst = new PNG({ width: targetW, height: targetH });
    const sx = srcPng.width / targetW;
    const sy = srcPng.height / targetH;
    for (let y = 0; y < targetH; y++) {
        const srcY = Math.min(srcPng.height - 1, Math.floor(y * sy));
        for (let x = 0; x < targetW; x++) {
            const srcX = Math.min(srcPng.width - 1, Math.floor(x * sx));
            const si = (srcY * srcPng.width + srcX) * 4;
            const di = (y * targetW + x) * 4;
            dst.data[di]     = srcPng.data[si];
            dst.data[di + 1] = srcPng.data[si + 1];
            dst.data[di + 2] = srcPng.data[si + 2];
            dst.data[di + 3] = srcPng.data[si + 3];
        }
    }
    return dst;
}

function pngToGFA(png) {
    // Lower threshold => fewer pixels become black => lighter/better bar separation.
    // Tune via env without redeploying code.
    const lumThreshold = Math.max(
        40,
        Math.min(240, parseInt(process.env.LABEL_GFA_LUMINANCE_THRESHOLD || '150', 10) || 150)
    );
    const bytesPerRow = Math.ceil(png.width / 8);
    const totalBytes = bytesPerRow * png.height;
    let hex = '';
    for (let y = 0; y < png.height; y++) {
        for (let byte = 0; byte < bytesPerRow; byte++) {
            let v = 0;
            for (let bit = 0; bit < 8; bit++) {
                const x = byte * 8 + bit;
                if (x >= png.width) continue;
                const i = (png.width * y + x) * 4;
                const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                if (a > 0 && lum < lumThreshold) v |= (1 << (7 - bit));
            }
            hex += v.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return { hex, bytesPerRow, totalBytes };
}

async function generateZPLFromMasterTemplate(labelData, boxNum, totalBoxes) {
    let pngBuffer;
    let renderVia = 'PNG';
    if (LABEL_ZPL_RENDER_SOURCE === 'PDF') {
        try {
            const pdfBuffer = await renderLabelPdfPageBuffer(labelData, boxNum, totalBoxes);
            pngBuffer = await pdfBufferToPngBuffer(pdfBuffer, LABEL_PRINTER_CONFIG.dpi);
            renderVia = 'PDF';
            console.log(`   Label render: PDF (${pdfBuffer.length} bytes) → PNG (${pngBuffer.length} bytes) @ ${LABEL_PRINTER_CONFIG.dpi} dpi`);
        } catch (e) {
            console.warn(`⚠️ PDF render failed (${e.message}); falling back to PNG screenshot`);
            pngBuffer = await renderLabelPngBuffer(labelData, boxNum, totalBoxes);
            renderVia = 'PNG-fallback';
        }
    } else {
        pngBuffer = await renderLabelPngBuffer(labelData, boxNum, totalBoxes);
    }
    const landscapePng = PNG.sync.read(pngBuffer);
    const portraitPng = rotatePng90CW(landscapePng);
    const dpmm = LABEL_PRINTER_CONFIG.dpi === 300 ? 12 : 8;
    const widthDots = LABEL_PRINTER_CONFIG.labelWidth * dpmm;
    const heightDots = LABEL_PRINTER_CONFIG.labelHeight * dpmm;
    const scaled = (portraitPng.width === widthDots && portraitPng.height === heightDots)
        ? portraitPng
        : scalePngNearest(portraitPng, widthDots, heightDots);
    const { hex, bytesPerRow, totalBytes } = pngToGFA(scaled);
    console.log(`🖨️ Rendered label (${renderVia}): ${landscapePng.width}x${landscapePng.height} -> rotated ${portraitPng.width}x${portraitPng.height} -> scaled ${scaled.width}x${scaled.height} (target ${widthDots}x${heightDots})`);
    return `^XA
^CI28
^PW${widthDots}
^LL${heightDots}
^LH0,0
^FO0,0^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hex}
^XZ`;
}

function generateZPLFromRenderedPngBuffer(pngBuffer) {
    const landscapePng = PNG.sync.read(pngBuffer);
    const portraitPng = rotatePng90CW(landscapePng);
    const dpmm = LABEL_PRINTER_CONFIG.dpi === 300 ? 12 : 8;
    const widthDots = LABEL_PRINTER_CONFIG.labelWidth * dpmm;
    const heightDots = LABEL_PRINTER_CONFIG.labelHeight * dpmm;
    const scaled = (portraitPng.width === widthDots && portraitPng.height === heightDots)
        ? portraitPng
        : scalePngNearest(portraitPng, widthDots, heightDots);
    const { hex, bytesPerRow, totalBytes } = pngToGFA(scaled);
    console.log(`🖨️ Rendered (client) label: ${landscapePng.width}x${landscapePng.height} -> rotated ${portraitPng.width}x${portraitPng.height} -> scaled ${scaled.width}x${scaled.height} (target ${widthDots}x${heightDots})`);
    return `^XA
^CI28
^PW${widthDots}
^LL${heightDots}
^LH0,0
^FO0,0^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hex}
^XZ`;
}

/**
 * Generate ESC/POS commands for thermal printers
 * @param {Object} data - Label data
 * @param {number} boxNum - Current box number
 * @param {number} totalBoxes - Total number of boxes
 * @returns {Buffer} ESC/POS commands
 */
function generateESCPOSLabel(data, boxNum, totalBoxes) {
    const ESC = '\x1B';
    const GS = '\x1D';
    
    // Truncate long text
    const truncate = (str, maxLen) => {
        if (!str) return '';
        return str.length > maxLen ? str.substring(0, maxLen - 2) + '..' : str;
    };
    
    let commands = '';
    
    // Initialize printer
    commands += ESC + '@';  // Initialize
    commands += ESC + 'a' + '\x01';  // Center alignment
    
    // Company header
    commands += ESC + '!' + '\x10';  // Double height
    commands += 'VK GLOBAL DIGITAL PVT LTD\n';
    commands += ESC + '!' + '\x00';  // Normal
    commands += 'PLOT NO. 928, SECTOR-68, IMT FARIDABAD\n';
    commands += 'FARIDABAD - 121004, India\n';
    commands += '================================\n';
    
    // Title
    commands += ESC + '!' + '\x18';  // Double width + height
    commands += 'PACKING SLIP\n';
    commands += ESC + '!' + '\x00';  // Normal
    commands += '================================\n';
    
    // Left alignment for details
    commands += ESC + 'a' + '\x00';
    
    // Details
    commands += `Customer: ${truncate(data.customerName, 30)}\n`;
    commands += `Item: ${truncate(data.itemDescription, 35)}\n`;
    commands += `FG Code: ${truncate(data.fgCode, 20)}\n`;
    commands += `Cust Code: ${truncate(data.customerCode, 20)}\n`;
    commands += `Job No: ${truncate(data.jobNo, 20)}\n`;
    commands += `Quantity: ${data.quantity}\n`;
    commands += `Packed On: ${data.packedOn}\n`;
    commands += ESC + '!' + '\x10';  // Double height
    commands += `Box No: ${boxNum}/${totalBoxes}\n`;
    commands += ESC + '!' + '\x00';  // Normal
    commands += `Operator: ${truncate(data.operator, 20)}\n`;
    commands += `Batch No: ${truncate(data.batchNo, 20)}\n`;
    
    // Cut paper
    commands += '\n\n\n';
    commands += GS + 'V' + '\x00';  // Full cut
    
    return Buffer.from(commands, 'binary');
}

/**
 * Send data to IP printer via raw socket (port 9100)
 * @param {string|Buffer} data - Print data (ZPL string or ESC/POS buffer)
 * @returns {Promise<Object>} Result object
 */
function sendToPrinter(data) {
    return new Promise((resolve, reject) => {
        if (!LABEL_PRINTER_CONFIG.enabled) {
            console.log('🖨️ Label printing is disabled');
            return resolve({ success: false, message: 'Label printing is disabled' });
        }
        
        const client = new net.Socket();
        let resolved = false;
        
        // Set timeout
        client.setTimeout(LABEL_PRINTER_CONFIG.timeout);
        
        client.connect(LABEL_PRINTER_CONFIG.port, LABEL_PRINTER_CONFIG.ip, () => {
            console.log(`🖨️ Connected to printer at ${LABEL_PRINTER_CONFIG.ip}:${LABEL_PRINTER_CONFIG.port}`);
            
            // Send data
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
            client.write(buffer, (err) => {
                if (err) {
                    console.error('🖨️ Error writing to printer:', err.message);
                    if (!resolved) {
                        resolved = true;
                        client.destroy();
                        reject(err);
                    }
                } else {
                    console.log('🖨️ Data sent to printer successfully');
                    // Give printer time to process before closing
                    setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            client.end();
                            resolve({ success: true, message: 'Label sent to printer' });
                        }
                    }, 500);
                }
            });
        });
        
        client.on('timeout', () => {
            console.error('🖨️ Printer connection timeout');
            if (!resolved) {
                resolved = true;
                client.destroy();
                reject(new Error('Printer connection timeout'));
            }
        });
        
        client.on('error', (err) => {
            console.error('🖨️ Printer connection error:', err.message);
            if (!resolved) {
                resolved = true;
                client.destroy();
                reject(err);
            }
        });
        
        client.on('close', () => {
            console.log('🖨️ Printer connection closed');
        });
    });
}

/**
 * Print FG labels automatically
 * @param {Object} labelData - Label data from FG entry
 * @param {number} numLabels - Number of labels to print
 * @returns {Promise<Object>} Print result
 */
async function printFGLabels(labelData, numLabels) {
    if (!LABEL_PRINTER_CONFIG.enabled) {
        console.log('🖨️ Auto-printing disabled - skipping label print');
        return { success: false, message: 'Auto-printing is disabled', printed: 0 };
    }

    if (LABEL_PRINT_MODE === 'PDF') {
        const jobName = `FG-${String(labelData?.jobNo || labelData?.poNumber || 'label')}`.replace(/[^\w.-]+/g, '_');

        // Raw socket CUPS queues (Local Raw Printer) cannot interpret PDF — use same HTML layout → ZPL.
        if (LABEL_CUPS_RAW_QUEUE && process.platform !== 'win32') {
            console.log(`\n🖨️ ========== PRINTING ${numLabels} LABELS (rendered ZPL → raw CUPS) ==========`);
            console.log(`   CUPS queue: ${CUPS_PRINTER_NAME} (Local Raw Printer — PDF not supported)`);
            const result = await printLabelsViaZplRawCups(labelData, numLabels, jobName, { useMaster: true });
            return {
                success: true,
                message: `${result.printed}/${numLabels} labels printed (rendered ZPL via raw CUPS)`,
                printed: result.printed,
                total: numLabels,
                errors: result.errors
            };
        }

        console.log(`\n🖨️ ========== PRINTING ${numLabels} LABELS (PDF) ==========`);
        console.log(`   CUPS queue: ${CUPS_PRINTER_NAME}`);
        const pdf = await renderLabelsPdfBuffer(labelData, numLabels);
        console.log(`   PDF rendered (${pdf.length} bytes, ${numLabels} page(s))`);
        if (process.platform === 'win32') {
            if (WINDOWS_PDF_PRINT_ENGINE === 'SUMATRA') {
                await printPdfBufferViaWindows(pdf, jobName);
            } else {
                await printPdfBufferViaChromeWindows(pdf, jobName);
            }
        } else {
            await printPdfBufferViaCups(pdf, jobName);
        }
        console.log(`   ✅ CUPS print job submitted to ${CUPS_PRINTER_NAME}`);
        return {
            success: true,
            message: `${numLabels}/${numLabels} labels printed (PDF)`,
            printed: numLabels,
            total: numLabels,
            errors: null
        };
    }
    
    const jobName = `FG-${String(labelData?.jobNo || labelData?.poNumber || 'label')}`.replace(/[^\w.-]+/g, '_');

    // Native ZPL via CUPS raw queue (lp -o raw) — best barcode quality, no PDF/PNG rasterization.
    if (LABEL_CUPS_RAW_QUEUE && CUPS_PRINTER_NAME && process.platform !== 'win32' && LABEL_PRINTER_CONFIG.printerType === 'ZPL') {
        const useMaster = FG_ZPL_RENDER_MODE === 'MASTER';
        console.log(`\n🖨️ ========== PRINTING ${numLabels} LABELS (${useMaster ? 'rendered' : 'pure'} ZPL → raw CUPS) ==========`);
        console.log(`   CUPS queue: ${CUPS_PRINTER_NAME}`);
        const result = await printLabelsViaZplRawCups(labelData, numLabels, jobName, { useMaster });
        console.log(`🖨️ Print complete: ${result.printed}/${numLabels} labels printed`);
        console.log('==========================================\n');
        return {
            success: result.printed > 0,
            message: `${result.printed}/${numLabels} labels printed (${useMaster ? 'rendered' : 'pure'} ZPL via raw CUPS)`,
            printed: result.printed,
            total: numLabels,
            errors: result.errors
        };
    }

    console.log(`\n🖨️ ========== PRINTING ${numLabels} LABELS ==========`);
    console.log(`   Printer: ${LABEL_PRINTER_CONFIG.ip}:${LABEL_PRINTER_CONFIG.port}`);
    console.log(`   Type: ${LABEL_PRINTER_CONFIG.printerType}`);
    
    let printedCount = 0;
    const errors = [];
    
    for (let i = 1; i <= numLabels; i++) {
        try {
            let printData;
            
            if (LABEL_PRINTER_CONFIG.printerType === 'ZPL') {
                // Default: PURE ZPL (no Chromium required). MASTER mode can be enabled explicitly.
                if (FG_ZPL_RENDER_MODE === 'MASTER') {
                    printData = await generateZPLFromMasterTemplate(labelData, i, numLabels);
                } else {
                    printData = generateZPLLabel(labelData, i, numLabels);
                }
            } else {
                printData = generateESCPOSLabel(labelData, i, numLabels);
            }
            
            await sendToPrinter(printData);
            printedCount++;
            console.log(`   ✅ Label ${i}/${numLabels} printed`);
            
            // Small delay between labels
            if (i < numLabels) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        } catch (err) {
            console.error(`   ❌ Label ${i}/${numLabels} failed:`, err.message);
            errors.push({ label: i, error: err.message });
        }
    }
    
    console.log(`🖨️ Print complete: ${printedCount}/${numLabels} labels printed`);
    console.log('==========================================\n');
    
    return {
        success: printedCount > 0,
        message: `${printedCount}/${numLabels} labels printed`,
        printed: printedCount,
        total: numLabels,
        errors: errors.length > 0 ? errors : null
    };
}

// In-memory session storage
let sapSession = {
    sessionId: null,
    cookie: null,
    expiresAt: null
};

/**
 * Authenticate with SAP Business One
 */
async function authenticateSAP() {
    // Check if session is still valid (refresh 5 minutes before expiry)
    if (sapSession.sessionId && sapSession.expiresAt && Date.now() < sapSession.expiresAt - 300000) {
        return sapSession;
    }

    try {
        console.log('Authenticating with SAP Business One...');
        const response = await axios.post(
            `${SAP_BASE_URL}/Login`,
            {
                CompanyDB: SAP_COMPANY_DB,
                UserName: SAP_USERNAME,
                Password: SAP_PASSWORD
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                // Disable SSL verification for self-signed certificates (adjust in production)
                httpsAgent: sapHttpsAgent,
                timeout: SAP_REQUEST_TIMEOUT_MS
            }
        );

        if (response.status === 200 && response.data.SessionId) {
            sapSession = {
                sessionId: response.data.SessionId,
                cookie: response.headers['set-cookie']?.join('; ') || null,
                expiresAt: Date.now() + (30 * 60 * 1000) // 30 minutes expiry
            };
            console.log('SAP authentication successful');
            return sapSession;
        } else {
            throw new Error('Authentication failed: Invalid response');
        }
    } catch (error) {
        console.error('SAP Authentication Error:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        throw new Error(`SAP Authentication failed: ${error.message}`);
    }
}

/**
 * Make authenticated GET request to SAP
 */
async function sapGetRequest(endpoint) {
    const session = await authenticateSAP();

    const headers = {
        'Content-Type': 'application/json'
    };

    // Add session ID as header (SAP B1 uses B1S-SessionId header)
    if (session.sessionId) {
        headers['B1S-SessionId'] = session.sessionId;
    }

    // Add cookie if available
    if (session.cookie) {
        headers['Cookie'] = session.cookie;
    }

    try {
        const response = await axios.get(`${SAP_BASE_URL}${endpoint}`, {
            headers,
            // Disable SSL verification for self-signed certificates
            httpsAgent: sapHttpsAgent,
            timeout: SAP_REQUEST_TIMEOUT_MS
        });

        return response.data;
    } catch (error) {
        // If unauthorized, try re-authenticating once
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.log('Session expired, re-authenticating...');
            sapSession = { sessionId: null, cookie: null, expiresAt: null };
            const newSession = await authenticateSAP();

            headers['B1S-SessionId'] = newSession.sessionId;
            if (newSession.cookie) {
                headers['Cookie'] = newSession.cookie;
            }

            const retryResponse = await axios.get(`${SAP_BASE_URL}${endpoint}`, {
                headers,
                httpsAgent: sapHttpsAgent,
                timeout: SAP_REQUEST_TIMEOUT_MS
            });

            return retryResponse.data;
        }

        console.error('SAP GET Request Error:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        throw error;
    }
}

function getSAPRequestHeaders(sessionOverride) {
    const session = sessionOverride || sapSession;
    const headers = { 'Content-Type': 'application/json' };
    if (session?.sessionId) headers['B1S-SessionId'] = session.sessionId;
    if (session?.cookie) headers['Cookie'] = session.cookie;
    return headers;
}

async function runSapSqlQuery(sqlText, label) {
    // Short-circuit queries already known to fail structurally this session (missing table/column/permission).
    if (label && sqlLabelsKnownUnsupported.has(label)) {
        const skipErr = new Error(`SQL "${label}" skipped (known unsupported this session)`);
        skipErr.sqlSkipped = true;
        throw skipErr;
    }
    const queryCode = `${label || 'Q'}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    try {
        await sapPostRequest('/SQLQueries', {
            SqlCode: queryCode,
            SqlName: `Auto ${label || 'Query'} ${Date.now()}`,
            SqlText: sqlText
        });
        const result = await sapGetRequest(`/SQLQueries('${queryCode}')/List`);
        return result?.value || [];
    } catch (err) {
        if (label && isStructuralSqlError(err)) {
            sqlLabelsKnownUnsupported.add(label);
            console.warn(`   ⏭️ SQL "${label}" unsupported on this SAP — skipping it for the rest of the session`);
        }
        throw err;
    } finally {
        // Fire-and-forget cleanup — don't block the response waiting for DELETE to finish.
        authenticateSAP().then(session => {
            axios.delete(`${SAP_BASE_URL}/SQLQueries('${queryCode}')`, {
                headers: getSAPRequestHeaders(session),
                httpsAgent: sapHttpsAgent
            }).catch(() => {});
        }).catch(() => {});
    }
}

/** Highest 3-digit seq in SAP for Unit 1 batches (PBP-12-1003-ALO-EMB-001 → 1). */
async function getSapMaxItemBatchSeq(itemCode, processTag) {
    const code = String(itemCode || '').trim();
    const tag = String(processTag || '').trim().toUpperCase();
    if (!code || !tag) return 0;

    const k = code.replace(/'/g, "''");
    const sql = `SELECT T0."DistNumber" FROM OBTN T0 WHERE T0."ItemCode" = '${k}' ORDER BY T0."DistNumber" DESC`;
    let rows = [];
    try {
        rows = await runSapSqlQuery(sql, 'item_batch_seq');
    } catch (err) {
        console.warn(`   SAP batch seq lookup failed for ${code}-${tag}:`, err.message);
        return 0;
    }

    let maxSeq = 0;
    for (const row of rows || []) {
        const dist = row.DistNumber ?? row.distNumber ?? row.DISTNUMBER;
        const seq = parseUnit1BatchSeq(dist, code, tag);
        if (seq !== null && seq > maxSeq) maxSeq = seq;
    }
    return maxSeq;
}

/**
 * Make authenticated POST request to SAP
 */
async function sapPostRequest(endpoint, data) {
    const session = await authenticateSAP();

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Prefer': 'return-no-content'  // SAP B1 often uses this
    };

    // Add session ID as header (SAP B1 uses B1S-SessionId header)
    if (session.sessionId) {
        headers['B1S-SessionId'] = session.sessionId;
    }

    // Add cookie if available
    if (session.cookie) {
        headers['Cookie'] = session.cookie;
    }

    if (DEBUG_PO_LOG) {
        console.log('🔧 SAP POST Request Debug:');
        console.log('   URL:', `${SAP_BASE_URL}${endpoint}`);
        console.log('   Headers:', JSON.stringify(headers, null, 2));
        console.log('   Payload:', JSON.stringify(data, null, 2));
    }

    try {
        const response = await axios.post(`${SAP_BASE_URL}${endpoint}`, data, {
            headers,
            // Disable SSL verification for self-signed certificates
            httpsAgent: sapHttpsAgent,
            timeout: SAP_REQUEST_TIMEOUT_MS,
            // Ensure proper JSON serialization
            transformRequest: [(data) => JSON.stringify(data)],
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        if (DEBUG_PO_LOG) console.log('✅ SAP POST Response Status:', response.status);
        return response.data;
    } catch (error) {
        // If unauthorized, try re-authenticating once
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.log('Session expired, re-authenticating...');
            sapSession = { sessionId: null, cookie: null, expiresAt: null };
            const newSession = await authenticateSAP();

            headers['B1S-SessionId'] = newSession.sessionId;
            if (newSession.cookie) {
                headers['Cookie'] = newSession.cookie;
            }

            const retryResponse = await axios.post(`${SAP_BASE_URL}${endpoint}`, data, {
                headers,
                httpsAgent: sapHttpsAgent,
                timeout: SAP_REQUEST_TIMEOUT_MS,
                transformRequest: [(data) => JSON.stringify(data)],
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            return retryResponse.data;
        }

        console.error('❌ SAP POST Request Error:', error.message);
        if (error.response) {
            console.error('   Response status:', error.response.status);
            console.error('   Response headers:', JSON.stringify(error.response.headers, null, 2));
            console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
        }
        if (error.request) {
            console.error('   Request was made but no response received');
        }
        throw error;
    }
}

/**
 * Make authenticated PATCH request to SAP
 */
async function sapPatchRequest(endpoint, data, options = {}) {
    const session = await authenticateSAP();

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };

    if (options.replaceCollectionsOnPatch) {
        headers['B1S-ReplaceCollectionsOnPatch'] = 'true';
    }

    if (session.sessionId) {
        headers['B1S-SessionId'] = session.sessionId;
    }

    if (session.cookie) {
        headers['Cookie'] = session.cookie;
    }

    try {
        const response = await axios.patch(`${SAP_BASE_URL}${endpoint}`, data, {
            headers,
            httpsAgent: sapHttpsAgent,
            timeout: SAP_REQUEST_TIMEOUT_MS,
            transformRequest: [(data) => JSON.stringify(data)]
        });

        return response.data;
    } catch (error) {
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.log('Session expired, re-authenticating...');
            sapSession = { sessionId: null, cookie: null, expiresAt: null };
            const newSession = await authenticateSAP();

            headers['B1S-SessionId'] = newSession.sessionId;
            if (newSession.cookie) {
                headers['Cookie'] = newSession.cookie;
            }

            const retryResponse = await axios.patch(`${SAP_BASE_URL}${endpoint}`, data, {
                headers,
                httpsAgent: sapHttpsAgent,
                timeout: SAP_REQUEST_TIMEOUT_MS,
                transformRequest: [(data) => JSON.stringify(data)]
            });

            return retryResponse.data;
        }

        console.error('❌ SAP PATCH Request Error:', error.message);
        if (error.response) {
            console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

function extractSapErrorMessage(error) {
    return error?.response?.data?.error?.message?.value
        || error?.response?.data?.error?.message
        || error?.message
        || 'Unknown SAP error';
}

/** Default receiving bin for bin-managed warehouses (e.g. OHJW-U1 coating). */
async function getReceivingBinAbsEntry(warehouseCode, itemCode) {
    const wh = String(warehouseCode || '').trim().replace(/'/g, "''");
    const ic = String(itemCode || '').trim().replace(/'/g, "''");
    if (!wh) return null;

    try {
        if (ic) {
            const dfltRows = await runSapSqlQuery(
                `SELECT T0."DfltBinAbs" AS "BinAbs" FROM OITW T0 WHERE T0."WhsCode" = '${wh}' AND T0."ItemCode" = '${ic}' AND IFNULL(T0."DfltBinAbs", 0) > 0`,
                'item_default_bin'
            );
            const dflt = dfltRows[0]?.BinAbs ?? dfltRows[0]?.binAbs;
            if (dflt) return Number(dflt);
        }

        const binRows = await runSapSqlQuery(
            `SELECT T0."AbsEntry" AS "BinAbs", T0."BinCode" AS "BinCode", T0."SysBin" AS "SysBin" FROM OBIN T0 WHERE T0."WhsCode" = '${wh}' ORDER BY T0."BinCode"`,
            'warehouse_bins'
        );
        // Skip the warehouse SYSTEM bin — receipts cannot be fully allocated to it,
        // which is what triggers SAP error 1470000341 ("Fully allocate item ... to bin locations").
        const isSystemBin = (r) => {
            const sys = String(r?.SysBin ?? r?.sysBin ?? '').toUpperCase();
            if (sys === 'Y' || sys === 'TYES') return true;
            return String(r?.BinCode ?? r?.binCode ?? '').toUpperCase().includes('SYSTEM');
        };
        const usable = binRows.find((r) => !isSystemBin(r)) || binRows[0];
        const first = usable?.BinAbs ?? usable?.binAbs;
        return first ? Number(first) : null;
    } catch (err) {
        console.warn(`   Bin lookup failed for ${wh}/${itemCode}:`, err.message);
        return null;
    }
}

/**
 * Post job completion to SAP InventoryGenEntries
 * @param {Object} completionData - Job completion data
 * @returns {Object} SAP response
 */
async function postJobCompletionToSAP(completionData) {
    const currentDate = getSAPPostingDate();

    let baseLine = completionData.baseLine;
    let warehouseCode = completionData.warehouseCode || null;
    const itemCode = completionData.itemCode || '';

    if (completionData.absoluteEntry && (baseLine == null || !warehouseCode)) {
        try {
            const poData = await sapGetRequest(
                `/ProductionOrders(${completionData.absoluteEntry})?$select=ItemNo,ProductionOrderLines`
            );
            const resolved = resolveMainProductCompletionLine(poData, itemCode || poData.ItemNo);
            if (baseLine == null) baseLine = resolved.baseLine;
            const mainLine = (poData.ProductionOrderLines || []).find(
                (line) => line.LineNumber === resolved.baseLine
            );
            warehouseCode = mainLine?.Warehouse || mainLine?.WarehouseCode || warehouseCode;
        } catch (poErr) {
            console.warn('   Could not resolve PO line/warehouse for completion:', poErr.message);
        }
    }

    // All coating FG (HRI / ALO / TRI / TR …) receipts go to OHJW-U1
    if (isUnit1CoatingJob(completionData.uPCode, itemCode)) {
        warehouseCode = UNIT1_WAREHOUSES.COT;
        console.log(`   🎨 Coating output → warehouse ${warehouseCode} (${itemCode || 'item n/a'})`);
    }

    const binAbsEntry = warehouseCode
        ? await getReceivingBinAbsEntry(warehouseCode, itemCode)
        : null;
    if (binAbsEntry) {
        console.log(`   📦 Using bin AbsEntry ${binAbsEntry} for warehouse ${warehouseCode}`);
    }

    // Build SAP payload - Note: UDFs like U_Operator may not work in BatchNumbers during creation
    // We'll update them via PATCH after the batch is created
    const linePayload = {
        BaseType: 202,
        BaseEntry: completionData.absoluteEntry,  // AbsoluteEntry from production order
        Quantity: completionData.quantity,
        TransactionType: 'botrntComplete',
        ...(baseLine !== null && baseLine !== undefined ? { BaseLine: baseLine } : {}),
        BatchNumbers: [
            {
                BatchNumber: completionData.batchNumber,
                Quantity: completionData.quantity,
                ManufacturingDate: currentDate,
                Notes: completionData.batchComments || '',
                U_BatchDt1: completionData.batchMachineLabel || completionData.machineName || '',
                U_BatchDt2: completionData.startTime || '',
                U_BatchDt3: completionData.endTime || '',
                ...(completionData.packingDetails ? { U_nopkg: completionData.packingDetails } : {}),
                U_BatchDt5: completionData.batchAppLabel || 'Data Entry WebApp',
                ...(completionData.customerName ? { U_PrNa: completionData.customerName } : {})
            }
        ],
        ...(binAbsEntry ? {
            DocumentLinesBinAllocations: [{
                BinAbsEntry: binAbsEntry,
                Quantity: completionData.quantity,
                AllowNegativeQuantity: 'tNO'
            }]
        } : {})
    };

    const sapPayload = {
        DocDate: currentDate,
        BPLID: SAP_BPL_ID,
        BPL_IDAssignedToInvoice: SAP_BPL_ID,
        Comments: completionData.remarks || 'Production completion from Data Entry WebApp',
        DocumentLines: [linePayload]
    };

    console.log('📤 Posting to SAP InventoryGenEntries:', JSON.stringify(sapPayload, null, 2));

    try {
        const result = await sapPostRequest('/InventoryGenEntries', sapPayload);
        console.log('✅ SAP posting successful:', result.DocEntry || result);
        
        // Step 2: Update batch UDFs via PATCH
        // Query BatchNumberDetails to find the batch and its available properties
        if (completionData.operatorName && completionData.itemCode && completionData.batchNumber) {
            console.log('📝 Updating U_Operator on batch...');
            
            const batchUpdatePayload = {
                U_Operator: completionData.operatorName
            };

            // Witty/Wity extra UDFs (if provided)
            if (completionData.U_Length !== undefined) batchUpdatePayload.U_Length = completionData.U_Length;
            if (completionData.U_Width !== undefined) batchUpdatePayload.U_Width = completionData.U_Width;
            if (completionData.U_MILL !== undefined) batchUpdatePayload.U_MILL = completionData.U_MILL;
            if (completionData.U_GRADE !== undefined) batchUpdatePayload.U_GRADE = completionData.U_GRADE;
            if (completionData.U_GSM !== undefined) batchUpdatePayload.U_GSM = completionData.U_GSM;
            
            try {
                // First, query to find the batch and see available properties
                const queryEndpoint = `/BatchNumberDetails?$filter=ItemCode eq '${encodeURIComponent(completionData.itemCode)}' and Batch eq '${encodeURIComponent(completionData.batchNumber)}'`;
                console.log(`   Querying batch: ${queryEndpoint}`);
                
                const batchQuery = await sapGetRequest(queryEndpoint);
                console.log(`   Query result:`, JSON.stringify(batchQuery, null, 2));
                
                if (batchQuery.value && batchQuery.value.length > 0) {
                    const batchData = batchQuery.value[0];
                    console.log(`   Found batch. Available keys:`, Object.keys(batchData));
                    
                    // Try to find the primary key - could be DocEntry, AbsoluteEntry, or composite
                    const docEntry = batchData.DocEntry;
                    const absEntry = batchData.AbsoluteEntry;
                    
                    let patchEndpoint = null;
                    if (docEntry) {
                        patchEndpoint = `/BatchNumberDetails(${docEntry})`;
                    } else if (absEntry) {
                        patchEndpoint = `/BatchNumberDetails(${absEntry})`;
                    }
                    
                    if (patchEndpoint) {
                        console.log(`   PATCH Endpoint: ${patchEndpoint}`);
                        console.log(`   Payload: ${JSON.stringify(batchUpdatePayload)}`);
                        
                        await sapPatchRequest(patchEndpoint, batchUpdatePayload);
                        console.log('✅ U_Operator updated successfully on batch');
                    } else {
                        console.log(`   ⚠️ Could not determine primary key for batch PATCH`);
                    }
                } else {
                    console.log(`   ⚠️ Batch not found in BatchNumberDetails`);
                }
            } catch (batchError) {
                console.warn('⚠️ Failed to update U_Operator on batch:', batchError.message);
                if (batchError.response?.data) {
                    console.warn('   SAP Error:', JSON.stringify(batchError.response.data, null, 2));
                }
                // Don't fail the whole operation - the main posting succeeded
            }
        } else {
            console.log('ℹ️ Skipping U_Operator update - missing operatorName, itemCode, or batchNumber');
            console.log(`   operatorName: ${completionData.operatorName || 'N/A'}`);
            console.log(`   itemCode: ${completionData.itemCode || 'N/A'}`);
            console.log(`   batchNumber: ${completionData.batchNumber || 'N/A'}`);
        }
        
        return {
            success: true,
            data: result,
            batchNumber: completionData.batchNumber,
            warehouseCode: warehouseCode || null
        };
    } catch (error) {
        const sapMessage = extractSapErrorMessage(error);
        console.error('❌ SAP posting failed:', sapMessage);
        // Log detailed SAP error
        if (error.response?.data) {
            console.error('❌ SAP Error Details:', JSON.stringify(error.response.data, null, 2));
        }
        return {
            success: false,
            error: sapMessage,
            details: error.response?.data || null
        };
    }
}

/**
 * Build finished-good output lines for multi-output (jumbled) production orders.
 * Header item = primary output; PO lines with negative PlannedQuantity = co-products/by-products.
 * @param {Object} productionOrder - SAP Production Order
 * @param {Function} isExcludedMaterialItemNo
 * @returns {Array<Object>}
 */
function buildFgLinesFromProductionOrder(productionOrder, isExcludedMaterialItemNo) {
    if (!productionOrder) return [];

    const headerItem = String(productionOrder.ItemNo || '').trim();
    const lines = productionOrder.ProductionOrderLines || [];
    const headerPlanned = productionOrder.PlannedQuantity || 0;
    const headerCompleted = Math.floor(productionOrder.CompletedQuantity || 0);

    const mainLine = lines.find((line) => {
        if (!isSapItemLine(line)) return false;
        const item = String(line.ItemNo || '').trim();
        return item === headerItem && (line.PlannedQuantity || 0) > 0;
    }) || lines.find((line) => {
        if (!isSapItemLine(line)) return false;
        return String(line.ItemNo || '').trim() === headerItem;
    });

    const fgLines = [];

    if (headerItem) {
        const mainIssued = mainLine?.IssuedQuantity > 0
            ? mainLine.IssuedQuantity
            : lines
                .filter((line) => isSapItemLine(line) && String(line.ItemNo || '').trim() === headerItem && (line.IssuedQuantity || 0) > 0)
                .reduce((sum, line) => sum + (line.IssuedQuantity || 0), 0);

        fgLines.push({
            itemNo: headerItem,
            itemName: productionOrder.ProductDescription || headerItem,
            lineNumber: mainLine?.LineNumber ?? null,
            isHeader: true,
            isByProduct: false,
            plannedQuantity: Math.abs(Math.floor(headerPlanned || mainLine?.PlannedQuantity || 0)),
            baseQuantity: mainLine?.BaseQuantity ?? 0,
            issuedQuantity: mainIssued || 0,
            completedQuantity: headerCompleted,
            warehouse: mainLine?.Warehouse || mainLine?.WarehouseCode || null
        });
    }

    for (const line of lines) {
        if (!isSapItemLine(line)) continue;

        const plannedQty = line.PlannedQuantity || 0;
        if (plannedQty >= 0) continue;

        const itemNo = String(line.ItemNo || '').trim();
        if (!itemNo || isExcludedMaterialItemNo(itemNo)) continue;
        if (itemNo === headerItem) continue;
        if (fgLines.some((fg) => fg.itemNo === itemNo)) continue;

        fgLines.push({
            itemNo,
            itemName: line.ItemName || itemNo,
            lineNumber: line.LineNumber ?? null,
            isHeader: false,
            isByProduct: true,
            plannedQuantity: Math.abs(Math.floor(plannedQty)),
            baseQuantity: line.BaseQuantity ?? 0,
            issuedQuantity: Math.abs(line.IssuedQuantity || 0),
            completedQuantity: Math.floor(line.CompletedQuantity || 0),
            warehouse: line.Warehouse || line.WarehouseCode || null
        });
    }

    // SAP often leaves header/main line BaseQuantity at 0; use co-product base qty for sheet→carton math
    const mainFg = fgLines.find((fg) => fg.isByProduct !== true);
    if (mainFg && !(Number(mainFg.baseQuantity) > 0)) {
        const coBq = fgLines
            .filter((fg) => fg.isByProduct)
            .map((fg) => Math.abs(Number(fg.baseQuantity) || 0))
            .find((v) => v > 0);
        if (coBq > 0) mainFg.baseQuantity = coBq;
    }

    return fgLines;
}

/** Resolve main product PO line for report completion (not component/co-product lines). */
function resolveMainProductCompletionLine(productionOrder, itemCode) {
    const headerItem = String(productionOrder?.ItemNo || itemCode || '').trim();
    const lines = productionOrder?.ProductionOrderLines || [];
    const targetItem = String(itemCode || headerItem).trim();

    const mainLine = lines.find((line) => {
        if (!isSapItemLine(line)) return false;
        const item = String(line.ItemNo || '').trim();
        return item === headerItem && (line.PlannedQuantity || 0) > 0;
    }) || lines.find((line) => {
        if (!isSapItemLine(line)) return false;
        return String(line.ItemNo || '').trim() === headerItem;
    }) || lines.find((line) => {
        if (!isSapItemLine(line)) return false;
        return String(line.ItemNo || '').trim() === targetItem;
    });

    return {
        baseLine: mainLine?.LineNumber ?? null,
        headerItem,
        matchedItemNo: mainLine ? String(mainLine.ItemNo || '').trim() : targetItem
    };
}

/**
 * Compute co-product/by-product issue quantity from sheets processed and PO base quantities.
 * @param {number} sheetsProcessed
 * @param {Object} byProductLine - FG line with isByProduct true
 * @param {Object} headerLine - main output FG line
 * @returns {number}
 */
function calculateJumbledCoProductIssueQty(sheetsProcessed, byProductLine, headerLine) {
    const sheets = Number(sheetsProcessed) || 0;
    if (sheets <= 0) return 0;

    const byProductBase = Math.abs(Number(byProductLine?.baseQuantity) || 0);
    const headerPlanned = Math.abs(Number(headerLine?.plannedQuantity) || 0);
    const byProductPlanned = Math.abs(Number(byProductLine?.plannedQuantity) || 0);

    if (byProductPlanned > 0 && headerPlanned > 0) {
        return Math.round(sheets * (byProductPlanned / headerPlanned));
    }
    if (byProductBase > 0) {
        return Math.round(sheets * byProductBase);
    }
    return byProductLine?.quantity || 0;
}

/**
 * Co-product/by-product pre-receipt before main report completion.
 * SAP does not allow co-products on Goods Issue (InventoryGenExits) — they must be received first
 * via InventoryGenEntries on the co-product PO line (no TransactionType), then the main product
 * is completed in a separate receipt with TransactionType botrntComplete.
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function issueJumbledCoProductsBeforeCompletion(params) {
    const {
        absoluteEntry,
        documentNumber,
        sheetsProcessed,
        fgLines,
        batchNumber,
        batchComments,
        machineName,
        startTime,
        endTime,
        packingDetails,
        remarks
    } = params;

    const lines = (fgLines || []).filter((fg) => (fg.quantity || 0) > 0);
    const headerLine = lines.find((fg) => fg.isHeader) || lines[0];
    const byProductLines = lines.filter((fg) => fg.isByProduct);
    const fgLinesOrdered = [
        ...lines.filter((fg) => fg.isHeader),
        ...lines.filter((fg) => !fg.isHeader)
    ];

    const results = [];
    if (!absoluteEntry || byProductLines.length === 0) {
        return { success: true, skipped: true, results };
    }

    console.log(`\n📦 ========== JUMBLED CO-PRODUCT PRE-RECEIPT (${byProductLines.length} line(s)) ==========`);

    let poLines = [];
    try {
        const poData = await sapGetRequest(
            `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,ProductionOrderStatus,ProductionOrderLines`
        );
        poLines = poData?.ProductionOrderLines || [];

        if (poData?.ProductionOrderStatus !== 'boposReleased') {
            await releaseProductionOrder(absoluteEntry, documentNumber);
        }
    } catch (fetchErr) {
        console.warn('⚠️ Could not fetch PO for co-product pre-receipt:', fetchErr.message);
    }

    const currentDate = getSAPPostingDate();
    let allSucceeded = true;

    for (const fg of byProductLines) {
        const itemNo = String(fg.itemNo || fg.item_no || '').trim();
        const receiptQty = Number(fg.quantity) || calculateJumbledCoProductIssueQty(sheetsProcessed, fg, headerLine);
        const lineIndex = fgLinesOrdered.findIndex((l) => (l.itemNo || l.item_no) === itemNo);
        const batchForItem = jumbledFgBatchNumber(batchNumber, fg, lineIndex >= 0 ? lineIndex : 1);

        if (!itemNo || receiptQty <= 0) {
            results.push({ itemNo, success: false, skipped: true, error: 'Zero co-product quantity' });
            continue;
        }

        const poLine = poLines.find((line) => String(line.ItemNo || '').trim() === itemNo);
        const baseLine = fg.lineNumber ?? fg.line_number ?? poLine?.LineNumber;
        const warehouseCode = fg.warehouse || poLine?.Warehouse || poLine?.WarehouseCode || null;

        console.log(`   Co-product ${itemNo}: qty ${receiptQty}, BaseLine ${baseLine}, batch ${batchForItem}`);

        const receiptLine = {
            BaseType: 202,
            BaseEntry: absoluteEntry,
            Quantity: receiptQty,
            BatchNumbers: [{
                BatchNumber: batchForItem,
                Quantity: receiptQty,
                ManufacturingDate: currentDate,
                Notes: batchComments || '',
                U_BatchDt1: machineName || '',
                U_BatchDt2: startTime || '',
                U_BatchDt3: endTime || '',
                U_nopkg: packingDetails || '',
                U_BatchDt5: 'Data Entry WebApp'
            }]
        };

        if (baseLine !== null && baseLine !== undefined) {
            receiptLine.BaseLine = baseLine;
        }
        if (warehouseCode) {
            receiptLine.WarehouseCode = warehouseCode;
        }

        try {
            const receiptResult = await sapPostRequest('/InventoryGenEntries', {
                DocDate: currentDate,
                BPLID: SAP_BPL_ID,
                BPL_IDAssignedToInvoice: SAP_BPL_ID,
                Comments: remarks || `Jumbled co-product pre-receipt PO ${documentNumber || absoluteEntry}`,
                DocumentLines: [receiptLine]
            });
            console.log(`   ✅ Co-product pre-receipt posted for ${itemNo} (DocEntry ${receiptResult?.DocEntry || 'n/a'})`);
            results.push({
                itemNo,
                success: true,
                quantity: receiptQty,
                batchNumber: batchForItem,
                docEntry: receiptResult?.DocEntry || null
            });
        } catch (receiptErr) {
            allSucceeded = false;
            const errMsg = receiptErr.response?.data?.error?.message?.value || receiptErr.message;
            console.error(`   ❌ Co-product pre-receipt failed for ${itemNo}: ${errMsg}`);
            results.push({
                itemNo,
                success: false,
                quantity: receiptQty,
                error: errMsg
            });
        }
    }

    console.log('=================================================\n');

    return {
        success: allSucceeded && results.every((r) => r.success || r.skipped),
        results
    };
}

/**
 * Batch number for a jumbled FG output line (main vs co-product must not share the same batch id).
 * @param {string} baseBatch
 * @param {Object} fg
 * @param {number} index
 * @returns {string}
 */
function jumbledFgBatchNumber(baseBatch, fg, index) {
    if (fg.isHeader || index === 0) {
        return baseBatch;
    }
    const itemSuffix = String(fg.itemNo || fg.item_no || 'CP').replace(/[^A-Za-z0-9]/g, '').slice(-8);
    return `${baseBatch}-${itemSuffix || 'CP'}`;
}

/**
 * Post main product report completion for a jumbled job (co-products must be pre-received first).
 * @param {Object} completionData
 * @returns {Promise<Object>}
 */
async function postJumbledJobCompletionToSAP(completionData) {
    const currentDate = getSAPPostingDate();
    const absoluteEntry = completionData.absoluteEntry;
    const fgLinesRaw = (completionData.fgLines || []).filter((fg) => (fg.quantity || 0) > 0);
    const headerFg = fgLinesRaw.find((fg) => fg.isHeader) || fgLinesRaw[0];

    if (!absoluteEntry) {
        return { success: false, error: 'Missing production order AbsoluteEntry' };
    }
    if (!headerFg || (headerFg.quantity || 0) <= 0) {
        return { success: false, error: 'No main product quantity to post for jumbled job' };
    }

    const qty = headerFg.quantity || 0;
    const batchNumber = jumbledFgBatchNumber(completionData.batchNumber, headerFg, 0);

    const linePayload = {
        BaseType: 202,
        BaseEntry: absoluteEntry,
        Quantity: qty,
        TransactionType: 'botrntComplete',
        BatchNumbers: [
            {
                BatchNumber: batchNumber,
                Quantity: qty,
                ManufacturingDate: currentDate,
                Notes: completionData.batchComments || '',
                U_BatchDt1: completionData.machineName || '',
                U_BatchDt2: completionData.startTime || '',
                U_BatchDt3: completionData.endTime || '',
                U_nopkg: completionData.packingDetails || '',
                U_BatchDt5: 'Data Entry WebApp'
            }
        ]
    };

    const sapPayload = {
        DocDate: currentDate,
        BPLID: SAP_BPL_ID,
        BPL_IDAssignedToInvoice: SAP_BPL_ID,
        Comments: completionData.remarks || 'Jumbled job main product completion from Data Entry WebApp',
        DocumentLines: [linePayload]
    };

    console.log('📤 Posting JUMBLED main product completion to SAP InventoryGenEntries:', JSON.stringify(sapPayload, null, 2));

    try {
        const result = await sapPostRequest('/InventoryGenEntries', sapPayload);
        console.log('✅ Jumbled main product SAP posting successful');

        const fgLinesOrdered = [
            ...fgLinesRaw.filter((fg) => fg.isHeader),
            ...fgLinesRaw.filter((fg) => !fg.isHeader)
        ];

        if (completionData.operatorName) {
            for (let index = 0; index < fgLinesOrdered.length; index++) {
                const fg = fgLinesOrdered[index];
                const itemCode = fg.itemNo || fg.item_no;
                const batchForItem = jumbledFgBatchNumber(completionData.batchNumber, fg, index);
                if (!itemCode || !batchForItem) continue;
                try {
                    const queryEndpoint = `/BatchNumberDetails?$filter=ItemCode eq '${encodeURIComponent(itemCode)}' and Batch eq '${encodeURIComponent(batchForItem)}'`;
                    const batchQuery = await sapGetRequest(queryEndpoint);
                    if (batchQuery.value?.length > 0) {
                        const batchData = batchQuery.value[0];
                        const docEntry = batchData.DocEntry || batchData.AbsoluteEntry;
                        if (docEntry) {
                            await sapPatchRequest(`/BatchNumberDetails(${docEntry})`, {
                                U_Operator: completionData.operatorName
                            });
                        }
                    }
                } catch (batchErr) {
                    console.warn(`⚠️ U_Operator update skipped for ${itemCode}:`, batchErr.message);
                }
            }
        }

        const coProductCount = fgLinesRaw.filter((fg) => fg.isByProduct).length;
        return {
            success: true,
            data: result,
            batchNumber: completionData.batchNumber,
            linesPosted: 1 + coProductCount
        };
    } catch (error) {
        console.error('❌ Jumbled main product SAP posting failed:', error.message);
        if (error.response?.data) {
            console.error('❌ SAP Error Details:', JSON.stringify(error.response.data, null, 2));
        }
        return {
            success: false,
            error: error.message,
            details: error.response?.data || null
        };
    }
}

/**
 * Auto-issue each FG output from a jumbled job to its respective next-process PO.
 * @param {Object} jobData
 * @param {Object} sapResult
 * @param {string} uJobEnt
 * @param {string} batchNum
 * @returns {Promise<Object>}
 */
async function processJumbledJobAutoIssue(jobData, sapResult, uJobEnt, batchNum) {
    const fgLinesRaw = jobData.fg_lines || [];
    const fgLines = [
        ...fgLinesRaw.filter((fg) => fg.isHeader),
        ...fgLinesRaw.filter((fg) => !fg.isHeader)
    ];
    const results = [];
    let successfulIssues = 0;
    const uPCode = jobData.u_p_code || jobData.process_code || '';

    console.log(`\n🔄 ========== JUMBLED AUTO-ISSUE (${fgLines.length} FG items) ==========`);

    for (let index = 0; index < fgLines.length; index++) {
        const fg = fgLines[index];
        const itemCode = fg.itemNo || fg.item_no;
        const qty = fg.quantity || fg.quantityForSap || 0;
        const fgBatchNum = jumbledFgBatchNumber(batchNum, fg, index);

        if (!itemCode) {
            results.push({ fgItemCode: itemCode, success: false, error: 'Missing item code' });
            continue;
        }
        if (qty <= 0) {
            results.push({
                fgItemCode: itemCode,
                success: false,
                skipped: true,
                error: 'Zero quantity — skipped'
            });
            continue;
        }

        console.log(`   Processing FG: ${itemCode}, Qty: ${qty}, Batch: ${fgBatchNum}`);

        const nextPO = await findNextProcessByItemRequired(
            uJobEnt,
            itemCode,
            jobData.absolute_entry,
            uPCode
        );

        if (!nextPO) {
            results.push({
                fgItemCode: itemCode,
                success: false,
                skipped: true,
                error: 'No next process PO found requiring this item'
            });
            continue;
        }

        const releaseResult = await releaseProductionOrder(nextPO.absoluteEntry, nextPO.documentNumber);
        if (!releaseResult.success) {
            results.push({
                fgItemCode: itemCode,
                success: false,
                error: `Failed to release PO ${nextPO.documentNumber}: ${releaseResult.error}`,
                targetPO: nextPO.documentNumber,
                targetProcess: nextPO.uPCode
            });
            continue;
        }

        const issueResult = await issueToNextProcessFIFO({
            nextPOAbsoluteEntry: nextPO.absoluteEntry,
            nextPODocNumber: nextPO.documentNumber,
            nextPOPlannedQty: nextPO.plannedQuantity,
            nextPOLines: nextPO.productionOrderLines,
            targetLine: nextPO.targetLine,
            itemCode,
            producedQty: qty,
            batchNumber: fgBatchNum,
            remarks: `Jumbled auto-issue ${itemCode} from ${uPCode} PO ${jobData.po_num} to ${nextPO.uPCode} PO ${nextPO.documentNumber}`
        });

        if (issueResult.success) {
            successfulIssues++;
        }

        results.push({
            fgItemCode: itemCode,
            success: issueResult.success,
            totalIssued: issueResult.totalIssued || 0,
            targetPO: nextPO.documentNumber,
            targetProcess: nextPO.uPCode,
            error: issueResult.error || null,
            skipped: issueResult.skipped || false
        });
    }

    console.log(`   Jumbled auto-issue complete: ${successfulIssues}/${fgLines.length} successful`);
    console.log(`=================================================\n`);

    return {
        success: successfulIssues > 0,
        isJumbledJob: true,
        totalFGItems: fgLines.length,
        successfulIssues,
        results
    };
}

// ==================== AUTO-ISSUE HELPER FUNCTIONS ====================

/**
 * SAP may return multiple Production Orders with the same DocumentNumber under different numbering Series.
 * For a given list, keep one row per DocumentNumber: the one with the highest Series.
 * @param {Array<Object>} productionOrders
 * @returns {Array<Object>}
 */
function dedupeProductionOrdersByHighestSeries(productionOrders) {
    if (!productionOrders || productionOrders.length === 0) return [];
    const bestByDoc = new Map();
    for (const po of productionOrders) {
        const docKey = String(po.DocumentNumber ?? '');
        const s = Number(po.Series);
        const seriesNum = Number.isFinite(s) ? s : 0;
        const prev = bestByDoc.get(docKey);
        const prevSeries = prev != null ? (Number(prev.Series) || 0) : -Infinity;
        if (!prev || seriesNum > prevSeries) {
            bestByDoc.set(docKey, po);
        }
    }
    return Array.from(bestByDoc.values());
}

/**
 * Find next process Production Order where the finished item is required as input material
 * Dynamically searches for any PO with the same U_JobEnt that needs this item
 * @param {string} jobEnt - The U_JobEnt value that links Production Orders
 * @param {string} finishedItemCode - The item code of the finished product from current job
 * @param {number} currentPOAbsEntry - AbsoluteEntry of current PO (to exclude from search)
 * @returns {Object} Next production order with line details or null
 */
async function findNextProcessByItemRequired(jobEnt, finishedItemCode, currentPOAbsEntry, sourceUPCode = null) {
    try {
        console.log(`\n🔍 ========== DYNAMIC AUTO-ISSUE SEARCH ==========`);
        console.log(`   U_JobEnt: ${jobEnt}`);
        console.log(`   Finished Item: ${finishedItemCode}`);
        console.log(`   Current PO AbsEntry: ${currentPOAbsEntry}`);
        console.log(`   Source U_PCode: ${sourceUPCode || '(unknown)'}`);

        if (!jobEnt) {
            console.log(`   ❌ No U_JobEnt provided - cannot search for next process`);
            return null;
        }

        if (!finishedItemCode) {
            console.log(`   ❌ No finished item code provided - cannot search for next process`);
            return null;
        }

        if (isTerminalUnit1Process(sourceUPCode, finishedItemCode)) {
            console.log(`   ℹ️ Terminal process (FG / end of chain) — no auto-issue to next PO`);
            console.log(`=================================================\n`);
            return null;
        }

        const sourceProcessTag = getUnit1ProcessBatchTag(sourceUPCode, null, null, finishedItemCode);

        // Query SAP for all production orders with same U_JobEnt (excluding current PO and non-actionable POs).
        // Prefer highest Series per DocumentNumber when duplicates exist.
        // Note: Cancelled POs may still show "remaining to issue" on lines, but SAP will not allow releasing/issuing to them.
        const endpoint = `/ProductionOrders?$select=AbsoluteEntry,DocumentNumber,Series,ItemNo,ProductDescription,U_PCode,U_JobEnt,PlannedQuantity,ProductionOrderStatus,ProductionOrderLines&$filter=U_JobEnt eq '${jobEnt}' and ProductionOrderStatus ne 'boposClosed' and ProductionOrderStatus ne 'boposCancelled'`;

        console.log(`   Querying SAP for related POs...`);
        const sapData = await sapGetRequest(endpoint);

        const relatedRows = dedupeProductionOrdersByHighestSeries(sapData.value || []);

        if (relatedRows.length === 0) {
            console.log(`   ⚠️ No related POs found for U_JobEnt ${jobEnt}`);
            return null;
        }

        console.log(`   Found ${relatedRows.length} related PO(s) with same U_JobEnt (after highest-Series dedupe per doc)`);

        // Search through each PO to find one where the finished item is required as input
        for (const po of relatedRows) {
            // Skip the current PO
            if (po.AbsoluteEntry === currentPOAbsEntry) {
                console.log(`   Skipping current PO: ${po.DocumentNumber} (AbsEntry: ${po.AbsoluteEntry})`);
                continue;
            }

            console.log(`   Checking PO: ${po.DocumentNumber} (U_PCode: ${po.U_PCode}, Status: ${po.ProductionOrderStatus})`);

            // Safety: skip cancelled/closed even if they slipped through (or SAP returns unexpected values).
            if (po.ProductionOrderStatus === 'boposCancelled' || po.ProductionOrderStatus === 'boposClosed') {
                continue;
            }

            const nextProcessTag = getUnit1ProcessBatchTag(po.U_PCode, null, null, po.ItemNo);
            if (!isDownstreamUnit1Process(nextProcessTag, sourceProcessTag)) {
                console.log(
                    `   Skipping PO ${po.DocumentNumber}: ${nextProcessTag || po.U_PCode} is not downstream of ${sourceProcessTag || sourceUPCode} (fresh/unrelated job)`
                );
                continue;
            }

            // Check if this PO has the finished item as an input material
            if (po.ProductionOrderLines && Array.isArray(po.ProductionOrderLines)) {
                for (const line of po.ProductionOrderLines) {
                    const lineItemCode = line.ItemNo || line.ItemCode;
                    
                    // Check if this line's item matches our finished item
                    if (lineItemCode === finishedItemCode) {
                        const plannedQty = line.PlannedQuantity || 0;
                        const issuedQty = line.IssuedQuantity || 0;
                        const remainingQty = plannedQty - issuedQty;

                        console.log(`      📦 Found matching input line:`);
                        console.log(`         Line ${line.LineNumber}: ${lineItemCode}`);
                        console.log(`         Planned: ${plannedQty}, Issued: ${issuedQty}, Remaining: ${remainingQty}`);
                        console.log(`         Warehouse: ${line.Warehouse || line.WarehouseCode || 'N/A'}`);

                        // Only return if there's still quantity to issue
                        if (remainingQty > 0) {
                            console.log(`   ✅ Found next process PO requiring this item!`);
                            console.log(`      PO: ${po.DocumentNumber} (AbsEntry: ${po.AbsoluteEntry})`);
                            console.log(`      Process: ${po.U_PCode}`);
                            console.log(`      Line: ${line.LineNumber}, Remaining to issue: ${remainingQty}`);
                            console.log(`=================================================\n`);

                            return {
                                absoluteEntry: po.AbsoluteEntry,
                                documentNumber: po.DocumentNumber,
                                itemNo: po.ItemNo,
                                productDescription: po.ProductDescription,
                                uPCode: po.U_PCode,
                                plannedQuantity: po.PlannedQuantity,
                                productionOrderStatus: po.ProductionOrderStatus,
                                // Specific line where the item is required
                                targetLine: {
                                    lineNumber: line.LineNumber,
                                    itemCode: lineItemCode,
                                    plannedQuantity: plannedQty,
                                    issuedQuantity: issuedQty,
                                    remainingQuantity: remainingQty,
                                    warehouse: line.Warehouse || line.WarehouseCode || null
                                },
                                productionOrderLines: po.ProductionOrderLines
                            };
                        } else {
                            console.log(`      ⚠️ Line already fully issued (remaining: ${remainingQty})`);
                        }
                    }
                }
            }
        }

        console.log(`   ℹ️ No PO found requiring item ${finishedItemCode} as input`);
        console.log(`=================================================\n`);
        return null;

    } catch (error) {
        console.error('Error finding next process PO:', error.message);
        if (error.response?.data) {
            console.error('   SAP Error:', JSON.stringify(error.response.data, null, 2));
        }
        return null;
    }
}

/**
 * PO(s) in the same U_JobEnt that produced a given intermediate item (e.g. …-EMB for MET step).
 */
async function findSourceProcessPOsForInput(jobEnt, inputItemCode, excludeAbsEntry = null) {
    const job = String(jobEnt || '').trim();
    const item = String(inputItemCode || '').trim().toUpperCase();
    if (!job || !item) return [];

    try {
        const endpoint = `/ProductionOrders?$select=AbsoluteEntry,DocumentNumber,Series,ItemNo,U_PCode,U_JobEnt,ProductionOrderStatus&$filter=U_JobEnt eq '${job}' and ProductionOrderStatus ne 'boposCancelled'`;
        const sapData = await sapGetRequest(endpoint);
        const relatedRows = dedupeProductionOrdersByHighestSeries(sapData.value || []);
        const pos = [];
        for (const po of relatedRows) {
            if (excludeAbsEntry != null && po.AbsoluteEntry === excludeAbsEntry) continue;
            const poItem = String(po.ItemNo || '').trim().toUpperCase();
            if (poItem === item) {
                pos.push(String(po.DocumentNumber).trim());
            }
        }
        return [...new Set(pos)];
    } catch (error) {
        console.warn('findSourceProcessPOsForInput failed:', error.message);
        return [];
    }
}

/**
 * Resolve which source PO(s) feed the previous-process inputs for this PO.
 */
async function resolveSourcePOsForProcessInputs(poNum, processTag, fgItemCode) {
    const po = String(poNum || '').trim();
    const tag = String(processTag || 'EMB').toUpperCase();
    const prevTag = getPreviousUnit1ProcessTag(tag);
    if (!po || !prevTag) return [];

    let uJobEnt = null;
    let absoluteEntry = null;
    let resolvedFg = String(fgItemCode || '').trim().toUpperCase();
    try {
        const poResp = await sapGetRequest(
            `/ProductionOrders?$filter=DocumentNumber eq ${po}&$select=AbsoluteEntry,DocumentNumber,ItemNo,U_JobEnt,ProductionOrderLines,U_PCode&$top=1`
        );
        const row = dedupeProductionOrdersByHighestSeries(poResp?.value || [])[0];
        if (row) {
            uJobEnt = row.U_JobEnt;
            absoluteEntry = row.AbsoluteEntry;
            if (!resolvedFg) resolvedFg = String(row.ItemNo || '').trim().toUpperCase();
        }
    } catch (error) {
        console.warn(`resolveSourcePOsForProcessInputs SAP lookup failed for PO ${po}:`, error.message);
    }

    const derivedInput = derivePrevProcessInputItemCode(resolvedFg, prevTag);
    let inputItemCode = derivedInput;
    if (uJobEnt && absoluteEntry) {
        try {
            const poResp = await sapGetRequest(
                `/ProductionOrders(${absoluteEntry})?$select=ProductionOrderLines`
            );
            const lines = poResp?.ProductionOrderLines || [];
            const match = lines.find((line) => {
                const code = String(line.ItemNo || line.ItemCode || '').trim().toUpperCase();
                return code && code.endsWith(`-${prevTag}`) && (!derivedInput || code === derivedInput);
            });
            if (match) {
                inputItemCode = String(match.ItemNo || match.ItemCode || '').trim().toUpperCase();
            }
        } catch (_) { /* use derived input */ }
    }

    if (!uJobEnt || !inputItemCode) return [];
    return findSourceProcessPOsForInput(uJobEnt, inputItemCode, absoluteEntry);
}

/**
 * Find next process Production Order using U_JobEnt (Legacy - kept for backward compatibility)
 * @param {string} jobEnt - The U_JobEnt value that links Production Orders
 * @param {string} nextProcessCode - Expected U_PCode for next process (e.g., 'PST')
 * @returns {Object} Next production order or null
 */
async function findNextProcessByJobEnt(jobEnt, nextProcessCode) {
    try {
        console.log(`🔍 Finding next process PO...`);
        console.log(`   U_JobEnt: ${jobEnt}`);
        console.log(`   Next Process Code: ${nextProcessCode}`);

        // Query SAP for production order with same U_JobEnt and next process code (highest Series per DocumentNumber)
        const endpoint = `/ProductionOrders?$select=AbsoluteEntry,DocumentNumber,Series,ItemNo,ProductDescription,U_PCode,U_JobEnt,PlannedQuantity,ProductionOrderStatus,ProductionOrderLines&$filter=U_JobEnt eq '${jobEnt}' and contains(U_PCode, '${nextProcessCode}')&$orderby=Series desc&$top=50`;

        const sapData = await sapGetRequest(endpoint);

        const candidates = dedupeProductionOrdersByHighestSeries(sapData.value || []);

        if (candidates.length === 0) {
            console.log(`⚠️ No ${nextProcessCode} PO found for U_JobEnt ${jobEnt}`);
            return null;
        }

        const nextPO = candidates[0];

        console.log(`✅ Found next process PO: ${nextPO.DocumentNumber}`);
        console.log(`   AbsoluteEntry: ${nextPO.AbsoluteEntry}`);
        console.log(`   U_PCode: ${nextPO.U_PCode}`);

        return {
            absoluteEntry: nextPO.AbsoluteEntry,
            documentNumber: nextPO.DocumentNumber,
            itemNo: nextPO.ItemNo,
            productDescription: nextPO.ProductDescription,
            uPCode: nextPO.U_PCode,
            plannedQuantity: nextPO.PlannedQuantity,
            productionOrderLines: nextPO.ProductionOrderLines
        };
    } catch (error) {
        console.error('Error finding next process PO:', error.message);
        return null;
    }
}

/**
 * Release a Production Order (change status to Released)
 * Required before issuing materials to a PO
 * @param {number} absoluteEntry - AbsoluteEntry of the Production Order
 * @param {string} docNumber - Document number for logging
 * @returns {Object} Result with success status
 */
async function releaseProductionOrder(absoluteEntry, docNumber) {
    try {
        console.log(`🔓 Releasing Production Order ${docNumber} (AbsoluteEntry: ${absoluteEntry})...`);

        // First, check current status
        const poData = await sapGetRequest(`/ProductionOrders(${absoluteEntry})?$select=ProductionOrderStatus`);
        const currentStatus = poData.ProductionOrderStatus;

        console.log(`   Current status: ${currentStatus}`);

        if (currentStatus === 'boposReleased') {
            console.log(`   ✅ PO ${docNumber} is already Released`);
            return { success: true, alreadyReleased: true };
        }

        if (currentStatus === 'boposClosed') {
            console.log(`   ⚠️ PO ${docNumber} is Closed - cannot release`);
            return { success: false, error: 'Production Order is already Closed' };
        }

        if (currentStatus === 'boposCancelled') {
            console.log(`   ⚠️ PO ${docNumber} is Cancelled - cannot release`);
            return { success: false, error: 'Production Order is Cancelled' };
        }

        // Change status to Released
        const patchPayload = { ProductionOrderStatus: 'boposReleased' };

        await sapPatchRequest(`/ProductionOrders(${absoluteEntry})`, patchPayload);
        console.log(`   ✅ PO ${docNumber} status changed to Released`);

        return { success: true, alreadyReleased: false };
    } catch (error) {
        console.error(`   ❌ Failed to release PO ${docNumber}:`, error.message);
        return {
            success: false,
            error: error.message,
            details: error.response?.data || null
        };
    }
}

function parseJobDateTime(value) {
    if (!value) return null;
    if (value instanceof Date) return value;

    const raw = String(value).trim();
    if (!raw) return null;

    // MySQL-style timestamps are generated in IST by the clients. Preserve that
    // timezone when calculating resource hours on the server.
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
    const date = new Date(hasTimezone ? normalized : `${normalized}+05:30`);

    return Number.isNaN(date.getTime()) ? null : date;
}

function calculateJobDurationHours(startTime, endTime) {
    const start = parseJobDateTime(startTime);
    const end = parseJobDateTime(endTime);

    if (!start || !end) return 0;

    const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    return hours > 0 ? Number(hours.toFixed(4)) : 0;
}

function compactProductionOrderLine(line) {
    const compact = {
        LineNumber: line.LineNumber,
        ItemNo: line.ItemNo,
        BaseQuantity: line.BaseQuantity,
        PlannedQuantity: line.PlannedQuantity,
        ItemType: line.ItemType
    };
    const wh = line.Warehouse || line.WarehouseCode;
    if (wh) compact.Warehouse = wh;
    return compact;
}

/** Unit 1 warehouse codes (FBD-* / OHJW-U1) — matches Unit_1 warehouse_mapping.py */
const UNIT1_WAREHOUSES = {
    RM: 'FBD-RM',
    FG: 'FBD-FG',
    EMB: 'FBD-EMB',
    SLT: 'FBD-SLT',
    MTL: 'FBD-MTL',
    COT: 'OHJW-U1'   // All coating FG (HRI / ALO / TRI / TR …) — outsourced
};

/** True when job is Unit 1 coating (U_PCode COT or FG item …-COT). */
function isUnit1CoatingJob(uPCode, itemCode) {
    if (String(uPCode || '').toUpperCase().includes('COT')) return true;
    return inferUnit1ProcessTagFromItemCode(itemCode) === 'COT';
}

/** Default warehouse when issuing raw material to a PO (Unit 1). */
const UNIT1_DEFAULT_ISSUE_WAREHOUSE = UNIT1_WAREHOUSES.RM;

/** Output warehouse for auto-issue after a process completes (by U_PCode / item code). */
function getUnit1OutputWarehouse(uPCode, itemCode) {
    if (isUnit1CoatingJob(uPCode, itemCode)) return UNIT1_WAREHOUSES.COT;
    const u = String(uPCode || '').toUpperCase();
    if (u.includes('EMB')) return UNIT1_WAREHOUSES.EMB;
    if (u.includes('REW')) return UNIT1_WAREHOUSES.SLT;
    if (u.includes('SLT')) return UNIT1_WAREHOUSES.SLT;
    if (u.includes('MET') || u.includes('MTL')) return UNIT1_WAREHOUSES.MTL;
    return UNIT1_WAREHOUSES.RM;
}

/** Unit 1 auxiliary material prefixes (Unit 2 style lines — not process input). */
function isUnit1AuxMaterialItemNo(itemNo) {
    const upper = (itemNo || '').toUpperCase();
    return ['PMT', 'FIL', 'ADH', 'RMC', 'TAP'].some((p) => upper.startsWith(p));
}

/** Unit 1 machine ids (URL ?machine=...) — no SAP resource / running-cost tracking. */
const UNIT1_MACHINE_IDS = new Set([
    'embossing-1', 'embossing-2', 'embossing-3',
    'coating-1',
    'rewinding-1', 'rewinding-2',
    'slitting-1', 'slitting-2',
    'metallisation-1'
]);

function isUnit1Machine(machineName) {
    return UNIT1_MACHINE_IDS.has(normalizeMachineKey(machineName));
}

/** Unit 2 machine → SAP ORSC ResCode (resource costing — NOT used for Unit 1). */
const UNIT2_MACHINE_TO_RES_CODE = {
    // Unit 2 only — Unit 1 machines are in UNIT1_MACHINE_IDS and never use resources
};

function findSapResourceForMachine(machineName) {
    const normalized = normalizeMachineKey(machineName);
    if (!normalized) {
        return { success: false, error: 'Missing machine name for SAP resource lookup' };
    }
    if (isUnit1Machine(normalized)) {
        return { success: false, skipped: true, error: 'Unit 1 — no SAP machine resources' };
    }

    const machineKey = UNIT2_MACHINE_TO_RES_CODE[normalized]
        ? normalized
        : (MACHINE_DISPLAY_ALIASES[normalized] || normalized);

    const resourceCode = UNIT2_MACHINE_TO_RES_CODE[machineKey];
    if (!resourceCode) {
        return {
            success: false,
            error: `No SAP ResCode mapping for machine "${machineName}"`,
            machineName
        };
    }

    return {
        success: true,
        machineName: machineKey,
        resourceCode,
        resourceName: resourceCode
    };
}

/** Unit 1: strip accidental pit_Resource lines from PO (no running-cost tracking). */
async function removeUnit1ResourceLinesFromPO(absoluteEntry) {
    const poData = await sapGetRequest(`/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,ProductionOrderLines`);
    const lines = Array.isArray(poData?.ProductionOrderLines) ? poData.ProductionOrderLines : [];
    const toRemove = lines.filter((line) => isSapResourceLine(line));
    if (toRemove.length === 0) {
        return { removed: 0 };
    }
    const removeNums = new Set(toRemove.map((l) => l.LineNumber));
    const kept = lines.filter((l) => !removeNums.has(l.LineNumber));
    await sapPatchRequest(
        `/ProductionOrders(${absoluteEntry})`,
        { ProductionOrderLines: kept.map(compactProductionOrderLine) },
        { replaceCollectionsOnPatch: true }
    );
    console.log(`   🧹 Removed ${toRemove.length} resource line(s) from Unit 1 PO: ${toRemove.map((l) => l.ItemNo).join(', ')}`);
    return { removed: toRemove.length, codes: toRemove.map((l) => l.ItemNo) };
}

const MACHINE_DISPLAY_ALIASES = {};

function normalizeMachineKey(machineName) {
    return String(machineName || '').trim().toLowerCase();
}

function getProductionOrderLineItemNo(line) {
    return (line?.ItemNo || line?.ItemCode || '').toString().trim();
}

function isSapResourceLine(line) {
    const itemType = line?.ItemType;
    return itemType === 'pit_Resource' || itemType === 290 || String(itemType) === '290';
}

/** SAP production order line is an inventory item (not resource/text). */
function isSapItemLine(line) {
    const itemType = line?.ItemType;
    return itemType === 'pit_Item' || itemType === 4 || String(itemType) === '4';
}

/** Unit 1 raw-material warehouse lines (e.g. PET from FBD-RM) — excluded from FG progress stats. */
function isUnit1RawMaterialLine(line) {
    const wh = (line?.Warehouse || line?.WarehouseCode || '').toString().trim().toUpperCase();
    return wh === UNIT1_WAREHOUSES.RM;
}

/**
 * PO BOM component line to issue at Running (Unit 1).
 * Warehouse is taken from the SAP PO line — not inferred from U_PCode or item suffix.
 */
function isUnit1MaterialIssueLine(line, headerItemNo) {
    if (!isSapItemLine(line) || isSapResourceLine(line)) return false;
    const itemNo = getProductionOrderLineItemNo(line);
    if (!itemNo) return false;
    const header = String(headerItemNo || '').trim().toUpperCase();
    if (header && itemNo.toUpperCase() === header) return false;
    const upper = itemNo.toUpperCase();
    // Glue/film/chemical BOM lines on Unit 1 POs are real consumables — issue at Running
    if (upper.startsWith('ADH') || upper.startsWith('FIL')) {
        return Number(line.PlannedQuantity || 0) > 0;
    }
    if (isUnit1AuxMaterialItemNo(itemNo)) return false;
    return Number(line.PlannedQuantity || 0) > 0;
}

function isUnit1ProcessCode(uPCode) {
    const u = String(uPCode || '').toUpperCase();
    return u.includes('EMB') || u.includes('REW') || u.includes('SLT') ||
        u.includes('MET') || u.includes('MTL') || u.includes('COT');
}

/** U_PCode from job-complete payload (client may send u_p_code, u_pcode, or uPCode). */
function getJobDataUPCode(jobData) {
    if (!jobData) return '';
    return String(
        jobData.u_p_code ?? jobData.u_pcode ?? jobData.uPCode ?? jobData.process_code ?? ''
    ).trim();
}

/** True when job completion should use Unit 1 flow (no SAP resources, item-code batches). */
function isUnit1JobFromData(jobData) {
    if (!jobData) return false;
    if (isUnit1ProcessCode(getJobDataUPCode(jobData))) return true;
    if (isUnit1Machine(jobData.machine_name)) return true;
    const proc = String(jobData.process_name || '').toLowerCase();
    return proc.includes('embossing') || proc.includes('coating') ||
        proc.includes('rewinding') || proc.includes('slitting') ||
        proc.includes('metallisation') || proc.includes('metallization');
}

/** Embossing only — chemical adds to done qty but not to RM issue/remaining. */
function isEmbossingProcessCode(uPCode) {
    const u = String(uPCode || '').toUpperCase();
    if (u === 'EMB+P' || u.startsWith('DIE')) return false;
    return u.includes('EMB');
}

function sumUnit1MaterialQuantities(lines, headerItemNo) {
    let planned = 0;
    let issued = 0;
    for (const line of lines || []) {
        if (!isUnit1MaterialIssueLine(line, headerItemNo)) continue;
        planned += Number(line.PlannedQuantity || 0);
        issued += Math.abs(Number(line.IssuedQuantity || 0));
    }
    return { planned, issued };
}

/** Product line for issued/completed/base qty: pit_Item and not PMT/RMC/FIL/ADH/TAP/raw RM. */
function isProductionOrderItemProductLine(line, isExcludedMaterialItemNo) {
    if (!line || !isSapItemLine(line)) return false;
    if (isUnit1RawMaterialLine(line)) return false;
    const itemNo = getProductionOrderLineItemNo(line);
    if (!itemNo) return false;
    return !isExcludedMaterialItemNo(itemNo);
}

async function addResourceLineToProductionOrder(absoluteEntry, lines, resourceCode, quantityHours) {
    const nextLineNumber = lines.reduce((max, line) => Math.max(max, Number(line.LineNumber || 0)), -1) + 1;
    const existingLines = lines.map(compactProductionOrderLine);
    const candidateWarehouses = Array.from(new Set(
        lines
            .map(line => (line.Warehouse || line.WarehouseCode || '').toString().trim())
            .filter(Boolean)
            .filter(warehouse => warehouse.toUpperCase() !== 'FBD-STR')
    ));

    if (candidateWarehouses.length === 0) {
        candidateWarehouses.push('');
    }

    const buildResourceLine = (itemType, warehouse) => {
        const line = {
            LineNumber: nextLineNumber,
            ItemNo: resourceCode,
            BaseQuantity: quantityHours,
            PlannedQuantity: quantityHours,
            ItemType: itemType
        };
        if (warehouse) {
            line.Warehouse = warehouse;
        }
        return line;
    };

    const attempts = [];
    for (const warehouse of candidateWarehouses) {
        attempts.push({ itemType: 'pit_Resource', warehouse });
        attempts.push({ itemType: 290, warehouse });
    }

    let resourceWarehouse = '';
    let lastPatchErr = null;

    for (const attempt of attempts) {
        try {
            console.log(`   Trying resource line add: ItemType=${attempt.itemType}, Warehouse=${attempt.warehouse || '(SAP default)'}`);
            await sapPatchRequest(`/ProductionOrders(${absoluteEntry})`, {
                ProductionOrderLines: [
                    ...existingLines,
                    buildResourceLine(attempt.itemType, attempt.warehouse)
                ]
            });
            resourceWarehouse = attempt.warehouse;
            console.log(`   ✅ Resource line patch accepted with Warehouse=${attempt.warehouse || '(SAP default)'}`);
            return { lineNumber: nextLineNumber, warehouse: resourceWarehouse };
        } catch (patchErr) {
            lastPatchErr = patchErr;
            const errMsg = patchErr.response?.data?.error?.message?.value || patchErr.message;
            console.warn(`   ⚠️ Resource line add failed: ItemType=${attempt.itemType}, Warehouse=${attempt.warehouse || '(SAP default)'} - ${errMsg}`);
        }
    }

    throw lastPatchErr || new Error('Failed to add SAP resource line');
}

async function ensureAndIssueProductionResource(params) {
    const {
        absoluteEntry,
        documentNumber,
        machineName,
        startTime,
        endTime,
        remarks
    } = params;

    try {
        if (isUnit1Machine(machineName)) {
            return { success: true, skipped: true, reason: 'unit1_no_resources' };
        }

        console.log('\n🛠️ ========== PRODUCTION RESOURCE ISSUE (Unit 2) ==========');
        console.log(`   PO: ${documentNumber || absoluteEntry}`);
        console.log(`   Machine: ${machineName}`);
        console.log(`   Start: ${startTime}`);
        console.log(`   End: ${endTime}`);

        if (!absoluteEntry) {
            return { success: false, skipped: true, error: 'Missing Production Order AbsoluteEntry' };
        }

        const quantityHours = calculateJobDurationHours(startTime, endTime);
        if (quantityHours <= 0) {
            return { success: false, skipped: true, error: 'Job duration is zero or invalid' };
        }

        const resourceLookup = findSapResourceForMachine(machineName);
        if (!resourceLookup.success) {
            return resourceLookup;
        }

        const { resourceCode, resourceName } = resourceLookup;
        console.log(`   SAP ResCode: ${resourceCode} (machine: ${machineName})`);
        console.log(`   Hours to plan/issue for this job: ${quantityHours}`);

        let poData = await sapGetRequest(`/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,DocumentNumber,ProductionOrderStatus,ProductionOrderLines`);
        const lines = Array.isArray(poData?.ProductionOrderLines) ? poData.ProductionOrderLines : [];
        const existingLine = lines.find(line =>
            getProductionOrderLineItemNo(line).toUpperCase() === resourceCode.toUpperCase()
        );

        let resourceLineNumber = existingLine?.LineNumber;
        let resourceWarehouse = (existingLine?.Warehouse || existingLine?.WarehouseCode || '').toString().trim();

        if (existingLine) {
            console.log(`   Same resource ${resourceCode} already on PO at line ${resourceLineNumber}`);

            const existingPlannedQty = Number(existingLine.PlannedQuantity || 0);
            const newPlannedQty = Number((existingPlannedQty + quantityHours).toFixed(4));

            if (newPlannedQty !== existingPlannedQty) {
                const updatedLines = lines.map(line => {
                    const compact = compactProductionOrderLine(line);
                    if (line.LineNumber === resourceLineNumber) {
                        compact.PlannedQuantity = newPlannedQty;
                        compact.BaseQuantity = newPlannedQty;
                    }
                    return compact;
                });

                await sapPatchRequest(`/ProductionOrders(${absoluteEntry})`, { ProductionOrderLines: updatedLines });
                console.log(`   ✅ Increased planned quantity: ${existingPlannedQty} → ${newPlannedQty} (+${quantityHours} hrs)`);
            } else {
                console.log(`   Planned quantity already at ${existingPlannedQty} — no PATCH needed`);
            }
        } else {
            const otherResourceLines = lines.filter(line =>
                isSapResourceLine(line) &&
                getProductionOrderLineItemNo(line).toUpperCase() !== resourceCode.toUpperCase()
            );

            if (otherResourceLines.length > 0) {
                const otherCodes = otherResourceLines.map(line => getProductionOrderLineItemNo(line)).join(', ');
                console.log(`   PO has different resource line(s): ${otherCodes} — adding ${resourceCode} for current machine`);
            } else {
                console.log(`   Adding resource line for ${resourceCode}`);
            }

            const addResult = await addResourceLineToProductionOrder(
                absoluteEntry,
                lines,
                resourceCode,
                quantityHours
            );
            resourceLineNumber = addResult.lineNumber;
            resourceWarehouse = addResult.warehouse;

            poData = await sapGetRequest(`/ProductionOrders(${absoluteEntry})?$select=ProductionOrderLines`);
            const refreshedLines = Array.isArray(poData?.ProductionOrderLines) ? poData.ProductionOrderLines : [];
            const refreshedLine = refreshedLines.find(line =>
                getProductionOrderLineItemNo(line).toUpperCase() === resourceCode.toUpperCase()
            );
            resourceLineNumber = refreshedLine?.LineNumber ?? resourceLineNumber;
            resourceWarehouse = (refreshedLine?.Warehouse || refreshedLine?.WarehouseCode || resourceWarehouse || '').toString().trim();
            console.log(`   ✅ Resource line added at line ${resourceLineNumber}`);
        }

        const releaseResult = await releaseProductionOrder(absoluteEntry, documentNumber);
        if (!releaseResult.success) {
            return {
                success: false,
                error: `Failed to release Production Order before resource issue: ${releaseResult.error}`,
                details: releaseResult.details || null
            };
        }

        // Issue this job's hours (additive when same resource already on PO)
        const quantityToIssue = Number(quantityHours.toFixed(4));
        if (quantityToIssue <= 0) {
            return {
                success: false,
                skipped: true,
                error: 'Job duration is zero or invalid'
            };
        }

        const currentDate = getSAPPostingDate();
        const issueLine = {
            BaseType: 202,
            BaseEntry: absoluteEntry,
            BaseLine: resourceLineNumber,
            Quantity: quantityToIssue,
            TransactionType: 'botrntIssue'
        };
        if (resourceWarehouse) {
            issueLine.WarehouseCode = resourceWarehouse;
        }

        const issuePayload = {
            DocDate: currentDate,
            BPLID: SAP_BPL_ID,
            BPL_IDAssignedToInvoice: SAP_BPL_ID,
            Comments: remarks || `Resource issue for PO ${documentNumber || absoluteEntry}`,
            DocumentLines: [issueLine]
        };

        console.log(`   Posting resource issue: BaseLine=${resourceLineNumber}, Qty=${quantityToIssue}, Warehouse=${resourceWarehouse || '(SAP default)'}`);
        const issueResult = await sapPostRequest('/InventoryGenExits', issuePayload);
        console.log(`   ✅ Resource issue successful. DocEntry: ${issueResult?.DocEntry}`);
        console.log('=================================================\n');

        return {
            success: true,
            resourceCode,
            resourceName,
            lineNumber: resourceLineNumber,
            quantity: quantityHours,
            issuedQuantity: quantityToIssue,
            docEntry: issueResult?.DocEntry || null
        };
    } catch (error) {
        const message = error.response?.data?.error?.message?.value || error.message;
        console.error('❌ Resource line/issue failed:', message);
        if (error.response?.data) {
            console.error('   SAP Error:', JSON.stringify(error.response.data, null, 2));
        }
        console.log('=================================================\n');
        return {
            success: false,
            error: message,
            details: error.response?.data || null
        };
    }
}

/**
 * Issue materials to next process Production Order using FIFO
 * @param {Object} params - Issue parameters
 * @returns {Object} Result with success status
 */
async function issueToNextProcessFIFO(params) {
    const {
        nextPOAbsoluteEntry,
        nextPODocNumber,
        nextPOPlannedQty,
        nextPOLines,
        targetLine,  // New: specific line where item is required
        itemCode,
        producedQty,
        batchNumber,
        remarks,
        sourceWarehouse
    } = params;

    try {
        console.log(`\n📦 Starting issue to next process...`);
        console.log(`   Next PO: ${nextPODocNumber} (AbsEntry: ${nextPOAbsoluteEntry})`);
        console.log(`   Item: ${itemCode}`);
        console.log(`   Produced Qty: ${producedQty}`);
        console.log(`   Batch to issue: ${batchNumber}`);

        const warehouseFallback = sourceWarehouse || UNIT1_DEFAULT_ISSUE_WAREHOUSE;

        // Use target line info if provided (from dynamic search)
        let baseLine = 0;
        let warehouseCode = warehouseFallback;
        let maxQuantityToIssue = nextPOPlannedQty;

        if (targetLine) {
            // Issue from source warehouse (where batch was produced), not PO line default
            baseLine = targetLine.lineNumber;
            warehouseCode = sourceWarehouse || targetLine.warehouse || warehouseFallback;
            maxQuantityToIssue = targetLine.remainingQuantity;
            
            console.log(`   Using target line from dynamic search:`);
            console.log(`     BaseLine: ${baseLine}`);
            console.log(`     Item: ${targetLine.itemCode}`);
            console.log(`     Warehouse: ${warehouseCode}`);
            console.log(`     Remaining to issue: ${maxQuantityToIssue}`);
        } else if (nextPOLines && nextPOLines.length > 0) {
            // Legacy: Find the line matching the item code
            console.log(`   Checking ${nextPOLines.length} PO lines for item ${itemCode}...`);
            
            for (const line of nextPOLines) {
                const lineItemCode = line.ItemNo || line.ItemCode;
                if (lineItemCode === itemCode) {
                    baseLine = line.LineNumber || 0;
                    warehouseCode = line.Warehouse || line.WarehouseCode || warehouseFallback;
                    const issuedQty = line.IssuedQuantity || 0;
                    const plannedQty = line.PlannedQuantity || 0;
                    maxQuantityToIssue = plannedQty - issuedQty;
                    
                    console.log(`   Found matching line:`);
                    console.log(`     BaseLine: ${baseLine}`);
                    console.log(`     ItemNo: ${lineItemCode}`);
                    console.log(`     Warehouse: ${warehouseCode}`);
                    console.log(`     Remaining: ${maxQuantityToIssue}`);
                    break;
                }
            }
            
            // Fallback to first line if no match found
            if (baseLine === 0 && nextPOLines[0]) {
                const firstLine = nextPOLines[0];
                warehouseCode = firstLine.Warehouse || firstLine.WarehouseCode || warehouseFallback;
                console.log(`   No matching line found, using first line:`);
                console.log(`     BaseLine: 0`);
                console.log(`     ItemNo: ${firstLine.ItemNo}`);
                console.log(`     Warehouse: ${warehouseCode}`);
            }
        }

        // Determine quantity to issue:
        // Issue producedQty if it's ≤ remaining qty needed
        // Otherwise, cap at remaining qty
        let quantityToIssue = producedQty;
        if (maxQuantityToIssue && producedQty > maxQuantityToIssue) {
            console.log(`   ⚠️ Produced qty (${producedQty}) exceeds remaining qty (${maxQuantityToIssue}) - capping`);
            quantityToIssue = maxQuantityToIssue;
        } else {
            console.log(`   ✅ Produced qty (${producedQty}) ≤ remaining qty (${maxQuantityToIssue}) - issuing full amount`);
        }

        console.log(`   Quantity to Issue: ${quantityToIssue}`);

        if (!batchNumber) {
            console.log(`   ❌ No batch number provided`);
            return { success: false, error: 'No batch number provided' };
        }

        if (quantityToIssue <= 0) {
            console.log(`   ❌ No quantity to issue (already fully issued or zero produced)`);
            return { success: false, error: 'No quantity to issue' };
        }

        // Build SAP payload for InventoryGenExits
        const currentDate = getSAPPostingDate();

        const sapPayload = {
            DocDate: currentDate,
            BPLID: SAP_BPL_ID,
            BPL_IDAssignedToInvoice: SAP_BPL_ID,
            Comments: remarks || `Auto-issue to PO ${nextPODocNumber}`,
            DocumentLines: [{
                BaseType: 202,  // Production Order
                BaseEntry: nextPOAbsoluteEntry,
                BaseLine: baseLine,
                Quantity: quantityToIssue,
                WarehouseCode: warehouseCode,
                TransactionType: 'botrntIssue',
                BatchNumbers: [{
                    BatchNumber: batchNumber,
                    Quantity: quantityToIssue
                }]
            }]
        };

        console.log(`\n📤 Posting FIFO issue to SAP...`);
        console.log(`   Payload: BaseEntry=${nextPOAbsoluteEntry}, BaseLine=${baseLine}, Qty=${quantityToIssue}, Warehouse=${warehouseCode}`);

        const result = await sapPostRequest('/InventoryGenExits', sapPayload);

        console.log(`✅ FIFO issue successful! DocEntry: ${result?.DocEntry}`);

        await recordAutoIssueAllocationsToPO({
            poNum: nextPODocNumber,
            absoluteEntry: nextPOAbsoluteEntry,
            lineNumber: baseLine,
            itemCode,
            warehouse: warehouseCode,
            allocations: [{ batchNumber, quantity: quantityToIssue }],
            sapDocEntry: result?.DocEntry,
            remarks: remarks || `Auto-issue to PO ${nextPODocNumber}`,
            sourcePoNum: null
        });

        return {
            success: true,
            totalIssued: quantityToIssue,
            batchesIssued: 1,
            docEntry: result?.DocEntry,
            targetPO: nextPODocNumber,
            targetLine: baseLine,
            warehouse: warehouseCode,
            message: `Issued ${quantityToIssue} units to PO ${nextPODocNumber} (Line ${baseLine})`
        };

    } catch (error) {
        console.error('❌ FIFO issue failed:', error.message);
        if (error.response?.data) {
            console.error('   SAP Error:', JSON.stringify(error.response.data, null, 2));
        }
        return {
            success: false,
            error: error.message,
            details: error.response?.data || null
        };
    }
}

/** FIFO batch allocation from warehouse stock (oldest batch first). */
async function allocateFifoBatchesFromWarehouse(itemCode, warehouseCode, quantityNeeded) {
    const qty = Number(quantityNeeded) || 0;
    if (qty <= 0) return { allocations: [], shortfall: 0 };

    const k = String(itemCode || '').replace(/'/g, "''");
    const w = String(warehouseCode || '').replace(/'/g, "''");
    const sql = `SELECT T0."DistNumber" AS "BatchNumber", T1."Quantity" FROM OBTN T0 INNER JOIN OBTQ T1 ON T0."AbsEntry" = T1."MdAbsEntry" WHERE T1."ItemCode" = '${k}' AND T1."WhsCode" = '${w}' AND T1."Quantity" > 0 ORDER BY T0."DistNumber" ASC`;
    const rows = await runSapSqlQuery(sql, 'auto_issue_fifo');

    const allocations = [];
    let remaining = qty;
    for (const row of rows) {
        if (remaining <= 1e-6) break;
        const batchNumber = row.BatchNumber || row.BATCHNUMBER || row.DistNumber;
        const stock = Number(row.Quantity || row.QUANTITY || 0);
        if (!batchNumber || stock <= 0) continue;
        const take = Math.min(remaining, stock);
        allocations.push({ batchNumber, quantity: take });
        remaining -= take;
    }
    return { allocations, shortfall: Math.max(0, remaining) };
}

/**
 * Issue cumulative gap: SAP source PO completed − next PO material issued.
 * Handles missed auto-issues from prior batches and multi-batch FIFO stock.
 */
async function reconcileAutoIssueGap(params) {
    const {
        sourceAbsoluteEntry,
        sourceDocNumber,
        uJobEnt,
        finishedItemCode,
        sourceWarehouse,
        uPCode,
        remarks
    } = params;

    try {
        const sourcePO = await sapGetRequest(
            `/ProductionOrders(${sourceAbsoluteEntry})?$select=AbsoluteEntry,DocumentNumber,CompletedQuantity,ItemNo`
        );
        const sourceCompleted = Math.floor(sourcePO.CompletedQuantity || 0);
        if (sourceCompleted <= 0) {
            return { success: true, skipped: true, gap: 0, message: 'No SAP completed qty on source PO' };
        }

        const nextPO = await findNextProcessByItemRequired(
            uJobEnt,
            finishedItemCode,
            sourceAbsoluteEntry,
            uPCode
        );
        if (!nextPO?.targetLine) {
            return { success: false, skipped: true, error: 'No next process PO found requiring this item' };
        }

        const nextIssued = Number(nextPO.targetLine.issuedQuantity || 0);
        const gap = sourceCompleted - nextIssued;
        console.log(`   📊 Auto-issue reconcile: source SAP done=${sourceCompleted}, next issued=${nextIssued}, gap=${gap}`);

        if (gap <= 0) {
            return { success: true, skipped: true, gap: 0, message: 'Source completed and next issued already in sync' };
        }

        const maxIssue = Number(nextPO.targetLine.remainingQuantity || 0);
        const quantityToIssue = maxIssue > 0 ? Math.min(gap, maxIssue) : gap;
        if (quantityToIssue <= 0) {
            return { success: true, skipped: true, gap, message: 'Next PO line fully issued' };
        }

        const releaseResult = await releaseProductionOrder(nextPO.absoluteEntry, nextPO.documentNumber);
        if (!releaseResult.success) {
            return { success: false, error: `Failed to release PO ${nextPO.documentNumber}: ${releaseResult.error}`, gap };
        }

        const warehouseCode = sourceWarehouse || nextPO.targetLine.warehouse || UNIT1_DEFAULT_ISSUE_WAREHOUSE;
        const { allocations, shortfall } = await allocateFifoBatchesFromWarehouse(
            finishedItemCode,
            warehouseCode,
            quantityToIssue
        );

        if (shortfall > 0 || allocations.length === 0) {
            return {
                success: false,
                error: `Insufficient batch stock in ${warehouseCode} for ${finishedItemCode} (need ${quantityToIssue}, short ${shortfall || quantityToIssue})`,
                gap,
                shortfall: shortfall || quantityToIssue
            };
        }

        const currentDate = getSAPPostingDate();
        const sapPayload = {
            DocDate: currentDate,
            BPLID: SAP_BPL_ID,
            BPL_IDAssignedToInvoice: SAP_BPL_ID,
            Comments: remarks || `Auto-issue reconcile PO ${sourceDocNumber || sourcePO.DocumentNumber} → ${nextPO.documentNumber}`,
            DocumentLines: [{
                BaseType: 202,
                BaseEntry: nextPO.absoluteEntry,
                BaseLine: nextPO.targetLine.lineNumber,
                Quantity: quantityToIssue,
                WarehouseCode: warehouseCode,
                TransactionType: 'botrntIssue',
                BatchNumbers: allocations.map((a) => ({
                    BatchNumber: a.batchNumber,
                    Quantity: a.quantity
                }))
            }]
        };

        console.log(`   📤 Reconcile issue: ${quantityToIssue} to PO ${nextPO.documentNumber} (${allocations.length} batch(es))`);
        const result = await sapPostRequest('/InventoryGenExits', sapPayload);

        await recordAutoIssueAllocationsToPO({
            poNum: nextPO.documentNumber,
            absoluteEntry: nextPO.absoluteEntry,
            lineNumber: nextPO.targetLine.lineNumber,
            itemCode: finishedItemCode,
            warehouse: warehouseCode,
            allocations,
            sapDocEntry: result?.DocEntry,
            remarks: remarks || `Auto-issue reconcile from PO ${sourceDocNumber || sourcePO.DocumentNumber}`,
            sourcePoNum: sourceDocNumber || sourcePO.DocumentNumber
        });

        return {
            success: true,
            totalIssued: quantityToIssue,
            gap,
            batchesIssued: allocations.length,
            docEntry: result?.DocEntry,
            targetPO: nextPO.documentNumber,
            targetProcess: nextPO.uPCode,
            warehouse: warehouseCode,
            message: `Reconciled ${quantityToIssue} units to PO ${nextPO.documentNumber}`
        };
    } catch (error) {
        console.error('❌ Auto-issue reconcile failed:', error.message);
        return {
            success: false,
            error: extractSapErrorMessage(error),
            details: error.response?.data || null
        };
    }
}

/**
 * Issue LAM materials (Film and Adhesive) proportionally based on actual quantity processed
 * Called at job completion for LAM (Lamination) jobs
 * 
 * @param {Object} params - Issue parameters
 * @param {number} params.absoluteEntry - Production Order AbsoluteEntry
 * @param {string} params.documentNumber - Production Order number
 * @param {Object} params.lamMaterialCodes - Object containing film and adhesive details
 * @param {number} params.plannedQty - Original planned quantity
 * @param {number} params.actualQty - Actual quantity processed
 * @param {string} params.remarks - Remarks for the issue
 * @returns {Object} Result with success status and details
 */
async function issueLAMMaterials(params) {
    const {
        absoluteEntry,
        documentNumber,
        lamMaterialCodes,
        plannedQty,
        actualQty,
        remarks
    } = params;

    const results = {
        success: false,
        film: null,
        adhesive: null,
        errors: []
    };

    try {
        console.log(`\n📦 ========== LAM MATERIAL ISSUE ==========`);
        console.log(`   PO: ${documentNumber} (AbsEntry: ${absoluteEntry})`);
        console.log(`   Planned Qty: ${plannedQty}`);
        console.log(`   Actual Qty: ${actualQty}`);

        if (!lamMaterialCodes) {
            console.log('   ❌ No LAM material codes provided');
            results.errors.push('No LAM material codes provided');
            return results;
        }

        // Calculate proportional ratio
        const ratio = plannedQty > 0 ? actualQty / plannedQty : 0;
        console.log(`   Ratio (actual/planned): ${ratio.toFixed(4)}`);

        const currentDate = getSAPPostingDate();

        // Film is issued on START from user-selected batches (foil-style dialog).
        // Do NOT issue film proportionally at job finish.
        results.film = { success: true, skipped: true, reason: 'Film issued on START' };

        // Issue Adhesive material if present
        if (lamMaterialCodes.adhesive && lamMaterialCodes.adhesive.itemCode) {
            const adhesive = lamMaterialCodes.adhesive;
            const adhesiveQtyToIssue = Math.round(adhesive.plannedQty * ratio * 100) / 100; // Round to 2 decimals

            console.log(`\n   📦 ADHESIVE Material:`);
            console.log(`      Item Code: ${adhesive.itemCode}${adhesive.codeChanged ? ' (CHANGED by operator)' : ''}`);
            if (adhesive.codeChanged && adhesive.originalCode) {
                console.log(`      Original Code: ${adhesive.originalCode}`);
            }
            console.log(`      Planned Qty: ${adhesive.plannedQty}`);
            console.log(`      Qty to Issue: ${adhesiveQtyToIssue}`);
            console.log(`      Warehouse: ${adhesive.warehouse || 'II-LAM'}`);
            console.log(`      Line Number: ${adhesive.lineNumber || adhesive.lineNum}`);

            // If adhesive code was changed, update the production order line first
            if (adhesive.codeChanged && adhesive.originalCode && (adhesive.lineNumber !== undefined || adhesive.lineNum !== undefined)) {
                const adhesiveLineNumber = adhesive.lineNumber !== undefined ? adhesive.lineNumber : adhesive.lineNum;
                console.log(`      📝 Updating PO line ${adhesiveLineNumber} with new adhesive code...`);
                
                try {
                    const poEndpoint = `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,ProductionOrderLines`;
                    const poData = await sapGetRequest(poEndpoint);
                    
                    if (poData && poData.ProductionOrderLines) {
                        const updatedLines = poData.ProductionOrderLines.map(line => {
                            if (line.LineNumber === adhesiveLineNumber) {
                                return {
                                    LineNumber: line.LineNumber,
                                    ItemNo: adhesive.itemCode,
                                    BaseQuantity: line.BaseQuantity,
                                    PlannedQuantity: line.PlannedQuantity,
                                    Warehouse: line.Warehouse,
                                    ItemType: line.ItemType
                                };
                            }
                            return {
                                LineNumber: line.LineNumber,
                                ItemNo: line.ItemNo,
                                BaseQuantity: line.BaseQuantity,
                                PlannedQuantity: line.PlannedQuantity,
                                Warehouse: line.Warehouse,
                                ItemType: line.ItemType
                            };
                        });
                        
                        await sapPatchRequest(`/ProductionOrders(${absoluteEntry})`, { ProductionOrderLines: updatedLines });
                        console.log(`      ✅ PO line ${adhesiveLineNumber} updated: ${adhesive.originalCode} → ${adhesive.itemCode}`);
                    }
                } catch (updateErr) {
                    console.log(`      ⚠️ Failed to update PO line for adhesive: ${updateErr.message}`);
                }
            }

            if (adhesiveQtyToIssue > 0) {
                try {
                    const adhesivePayload = {
                        DocDate: currentDate,
                        BPLID: SAP_BPL_ID,
                        BPL_IDAssignedToInvoice: SAP_BPL_ID,
                        Comments: remarks || `Adhesive issue for PO ${documentNumber}`,
                        DocumentLines: [{
                            BaseType: 202,  // Production Order
                            BaseEntry: absoluteEntry,
                            BaseLine: adhesive.lineNumber || adhesive.lineNum || 0,
                            ItemCode: adhesive.itemCode,
                            Quantity: adhesiveQtyToIssue,
                            WarehouseCode: adhesive.warehouse || 'II-LAM',
                            TransactionType: 'botrntIssue'
                        }]
                    };

                    console.log(`      📤 Posting Adhesive issue to SAP...`);
                    const adhesiveResult = await sapPostRequest('/InventoryGenExits', adhesivePayload);
                    
                    console.log(`      ✅ Adhesive issue successful! DocEntry: ${adhesiveResult?.DocEntry}`);
                    results.adhesive = {
                        success: true,
                        itemCode: adhesive.itemCode,
                        quantity: adhesiveQtyToIssue,
                        docEntry: adhesiveResult?.DocEntry
                    };
                } catch (adhesiveError) {
                    console.error(`      ❌ Adhesive issue failed:`, adhesiveError.message);
                    results.adhesive = {
                        success: false,
                        itemCode: adhesive.itemCode,
                        quantity: adhesiveQtyToIssue,
                        error: adhesiveError.message
                    };
                    results.errors.push(`Adhesive issue failed: ${adhesiveError.message}`);
                }
            } else {
                console.log(`      ⚠️ Adhesive qty to issue is 0 - skipping`);
                results.adhesive = { success: true, skipped: true, reason: 'Zero quantity' };
            }
        } else {
            console.log(`\n   ℹ️ No Adhesive material to issue`);
        }

        // Determine overall success
        const filmSuccess = !results.film || results.film.success;
        const adhesiveSuccess = !results.adhesive || results.adhesive.success;
        results.success = filmSuccess && adhesiveSuccess;

        console.log(`\n   📊 LAM Issue Summary:`);
        console.log(`      Film: ${results.film ? (results.film.success ? '✅ Success' : '❌ Failed') : 'N/A'}`);
        console.log(`      Adhesive: ${results.adhesive ? (results.adhesive.success ? '✅ Success' : '❌ Failed') : 'N/A'}`);
        console.log(`      Overall: ${results.success ? '✅ Success' : '⚠️ Partial/Failed'}`);
        console.log(`==========================================\n`);

        return results;

    } catch (error) {
        console.error('❌ LAM material issue error:', error.message);
        results.errors.push(error.message);
        return results;
    }
}

/**
 * Logout from SAP
 */
async function logoutSAP() {
    if (!sapSession.sessionId) {
        return;
    }

    try {
        const headers = {
            'B1S-SessionId': sapSession.sessionId
        };
        if (sapSession.cookie) {
            headers['Cookie'] = sapSession.cookie;
        }

        await axios.post(
            `${SAP_BASE_URL}/Logout`,
            {},
            {
                headers,
                httpsAgent: sapHttpsAgent
            }
        );

        console.log('SAP logout successful');
    } catch (error) {
        console.error('SAP Logout Error:', error.message);
    } finally {
        sapSession = { sessionId: null, cookie: null, expiresAt: null };
    }
}

// ==================== API Routes ====================

// Health check
app.get('/api/health', async (req, res) => {
    const dbConnected = await testConnection();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        sapSessionActive: !!sapSession.sessionId,
        databaseConnected: dbConnected
    });
});

// Get Production Order by Document Number
app.get('/api/production-order/:docNumber', async (req, res) => {
    try {
        const { docNumber } = req.params;
        const { machine, process: processParam } = req.query; // Get machine and process from query params
        const materialOnly = String(req.query.materialOnly || '') === '1';

        // Same rule as enrichment block below: skip expensive follow-ups when lightweight.
        const enrichOverride = String(req.query.enrich || '');
        const enrichEnvRaw = globalThis.process?.env?.ENABLE_PO_ENRICHMENT;
        const enrichEnv =
            enrichEnvRaw === undefined || enrichEnvRaw === ''
                ? true
                : enrichEnvRaw === 'true';
        const enrichPO =
            !materialOnly &&
            (enrichOverride === '1' || (enrichOverride !== '0' && enrichEnv));

        if (!docNumber || docNumber.trim() === '') {
            return res.status(400).json({
                error: 'Document number is required'
            });
        }

        const t0 = Date.now();
        console.log(`Fetching production order: ${docNumber}`);
        console.log(`Machine: ${machine}, Process: ${processParam}`);
        if (materialOnly) {
            console.log(`   materialOnly=1 (lightweight mode)`);
        }
        if (!enrichPO) {
            console.log(`   enrichPO=false (base PO select only — faster)`);
        }

        // Build SAP query: same DocumentNumber may exist under multiple Series — load the highest Series row
        // Include AbsoluteEntry for SAP posting, U_JobEnt for auto-issue linking
        // Include CompletedQuantity to show already completed quantity before this batch run
        // Some SAP systems don't expose UDFs like U_CustName/U_CustCode on ProductionOrder.
        // Try extended select first; fall back to base select if SAP returns "property ... is invalid".
        const selectPOBase = 'AbsoluteEntry,Series,ItemNo,ProductDescription,U_PCode,U_JobEnt,PlannedQuantity,CompletedQuantity,ProductionOrderLines';
        const selectPOExtended = `${selectPOBase},U_CustName,U_CustCode`;

        const buildEndpoints = (selectPO) => {
            const activePOFilter = `DocumentNumber eq ${docNumber} and ProductionOrderStatus ne 'boposCancelled' and ProductionOrderStatus ne 'boposClosed'`;
            return {
                endpointOrdered: `/ProductionOrders?$select=${selectPO}&$filter=${activePOFilter}&$orderby=Series desc&$top=1`,
                endpointFallback: `/ProductionOrders?$select=${selectPO}&$filter=${activePOFilter}&$top=10`
            };
        };

        const tryFetchPO = async (selectPO) => {
            const { endpointOrdered, endpointFallback } = buildEndpoints(selectPO);
            let sapDataLocal;
            // In lightweight mode, skip the ordered query to avoid an extra request (and frequent 400s on some SL setups).
            if (!materialOnly) {
                try {
                    sapDataLocal = await sapGetRequest(endpointOrdered);
                } catch (orderErr) {
                    console.warn(`Production order query with $orderby=Series failed (${orderErr.message}), using in-memory highest-Series pick`);
                    sapDataLocal = { value: [] };
                }
            } else {
                sapDataLocal = { value: [] };
            }

            // If orderby unsupported / empty, fetch all matches for this doc # and keep highest Series
            if (!sapDataLocal.value || sapDataLocal.value.length === 0) {
                sapDataLocal = await sapGetRequest(endpointFallback);
                const picked = dedupeProductionOrdersByHighestSeries(sapDataLocal.value || []);
                sapDataLocal = { value: picked.slice(0, 1) };
            }
            return sapDataLocal;
        };

        let sapData;
        if (!enrichPO || poExtendedSelectUnsupported) {
            // Lightweight loads (materialOnly=1 and/or enrich=0), or systems where the U_CustName/U_CustCode
            // UDFs are known-unsupported: skip the extended select — one round-trip, no retry.
            const tFetchStart = Date.now();
            sapData = await tryFetchPO(selectPOBase);
            console.log(`   ⏱️ PO fetch (base select${enrichPO ? '' : ', lightweight'}) took ${Date.now() - tFetchStart}ms`);
        } else {
            try {
                const tFetchStart = Date.now();
                sapData = await tryFetchPO(selectPOExtended);
                console.log(`   ⏱️ PO fetch (extended select) took ${Date.now() - tFetchStart}ms`);
            } catch (e) {
                const msg = e?.response?.data?.error?.message?.value || e?.message || '';
                if (msg.includes("Property 'U_CustName'") || msg.includes("Property 'U_CustCode'")) {
                    poExtendedSelectUnsupported = true;
                    console.warn('Production order U_CustName/U_CustCode not available; skipping extended select for the rest of this session');
                    const tFetchStart = Date.now();
                    sapData = await tryFetchPO(selectPOBase);
                    console.log(`   ⏱️ PO fetch (base select) took ${Date.now() - tFetchStart}ms`);
                } else {
                    throw e;
                }
            }
        }

        // Check if data exists
        if (!sapData.value || sapData.value.length === 0) {
            return res.status(404).json({
                error: 'Production order not found',
                documentNumber: docNumber
            });
        }

        const productionOrder = sapData.value[0];
        console.log(`   Using Production Order DocumentNumber=${docNumber}, Series=${productionOrder.Series}, AbsoluteEntry=${productionOrder.AbsoluteEntry}`);
        const uPCode = productionOrder.U_PCode;

        // Read-only PO loads (search / refresh) must not PATCH SAP — strip resources only on full loads.
        if (isUnit1ProcessCode(productionOrder.U_PCode) && !materialOnly) {
            try {
                const stripResult = await removeUnit1ResourceLinesFromPO(productionOrder.AbsoluteEntry);
                if (stripResult.removed > 0) {
                    const refreshed = await sapGetRequest(
                        `/ProductionOrders(${productionOrder.AbsoluteEntry})?$select=ProductionOrderLines`
                    );
                    productionOrder.ProductionOrderLines = refreshed.ProductionOrderLines;
                }
            } catch (stripErr) {
                console.warn('⚠️ Unit 1 resource strip on PO load:', stripErr.message);
            }
        }

        // Validate U_PCode against Unit 1 process type
        if (processParam) {
            const processLower = String(processParam).toLowerCase();
            let expectedPatterns = [];
            let processType = '';

            if (processLower.includes('coating')) {
                expectedPatterns = ['COT'];
                processType = 'Coating';
            } else if (processLower.includes('embossing')) {
                expectedPatterns = ['EMB'];
                processType = 'Embossing';
            } else if (processLower.includes('rewinding')) {
                expectedPatterns = ['REW'];
                processType = 'Rewinding';
            } else if (processLower.includes('slitting')) {
                expectedPatterns = ['SLT'];
                processType = 'Slitting';
            } else if (processLower.includes('metallisation') || processLower.includes('metallization')) {
                expectedPatterns = ['MET'];
                processType = 'Metallisation';
            }

            if (expectedPatterns.length > 0 && uPCode) {
                const uPCodeUpper = uPCode.toUpperCase();
                const codeMatches = expectedPatterns.some(pattern => uPCodeUpper.includes(pattern));

                if (!codeMatches) {
                    const expectHint = `contain "${expectedPatterns.join('" or "')}"`;
                    console.log(`⚠️ Process code mismatch! U_PCode: ${uPCode}, Expected to ${expectHint}, Process: ${processType}`);
                    return res.status(400).json({
                        error: 'Process code mismatch',
                        message: `This job cannot be started on ${processType} machine`,
                        details: `Job has process code "${uPCode}" but ${processType} requires code to ${expectHint}`,
                        uPCode: uPCode,
                        expectedPatterns: expectedPatterns,
                        processType: processType,
                        documentNumber: docNumber
                    });
                }
            }

            if (processType) {
                console.log(`✅ Process code validated: U_PCode=${uPCode}, Process=${processType}, ExpectedPatterns=${expectedPatterns.join('/')}`);
            }
        }

        // Extract base quantities from ProductionOrderLines
        // Each line may have a BaseQuantity value
        let baseQuantities = [];
        let unissuedMaterials = [];
        let pmtMaterialsNeedIssue = [];  // Special handling for PST jobs with PMT items
        let rmcMaterialsNeedIssue = [];  // Special handling for FOI jobs with RMC items
        let lamMaterialsNeedIssue = [];  // Special handling for LAM jobs with FIL/ADH items
        let tapMaterialsNeedIssue = [];  // Special handling for Spot-UV APR jobs: materials to issue via batch selection
        
        // Get U_PCode for job type detection
        const uPCodeUpper = (productionOrder.U_PCode || '').toUpperCase();
        const isPSTJob = uPCodeUpper.includes('PST');
        const isFOIJob = uPCodeUpper === 'FOI';
        const isLAMJob = uPCodeUpper.includes('LAM');
        const processLowerForMaterials = String(processParam || '').toLowerCase();
        const machineLowerForMaterials = String(machine || '').toLowerCase();
        const isSpotUVApr = (
            (processLowerForMaterials.includes('spot-uv') || (processLowerForMaterials.includes('spot') && processLowerForMaterials.includes('uv'))) &&
            machineLowerForMaterials === 'spotuv-apr'
        );

        // Material lines excluded from product/base-qty logic (same as issued-quantity product lines)
        const productLineExcludedMaterialPrefixes = ['PMT', 'FIL', 'ADH', 'RMC', 'TAP'];
        const isExcludedMaterialItemNo = (itemNo) => {
            const upper = (itemNo || '').toUpperCase();
            return productLineExcludedMaterialPrefixes.some(prefix => upper.startsWith(prefix));
        };

        if (productionOrder.ProductionOrderLines && Array.isArray(productionOrder.ProductionOrderLines)) {
            // Only consider BaseQuantity from lines where:
            // 1. PlannedQuantity is positive
            // 2. ItemNo is not a material line (PMT, FIL, ADH, RMC)
            baseQuantities = productionOrder.ProductionOrderLines
                .filter(line => {
                    const plannedQty = line.PlannedQuantity || 0;
                    return plannedQty > 0 && isProductionOrderItemProductLine(line, isExcludedMaterialItemNo);
                })
                .map(line => line.BaseQuantity)
                .filter(bq => bq !== null && bq !== undefined && bq !== 0);

            // Check for materials with IssuedQuantity = 0
            // Only check rows where PlannedQuantity is positive (> 0)
            // If PlannedQuantity is negative, skip the check for that row
            const unit1Po = isUnit1ProcessCode(productionOrder.U_PCode);

            productionOrder.ProductionOrderLines
                .filter(line => {
                    const plannedQty = line.PlannedQuantity || 0;
                    const issuedQty = line.IssuedQuantity || 0;

                    // Unit 1 Running: only input component for this process (not FG header item or resource)
                    if (unit1Po) {
                        if (!isUnit1MaterialIssueLine(line, productionOrder.ItemNo)) return false;
                    }

                    if (DEBUG_PO_LOG && line.ItemNo && line.ItemNo.toUpperCase().startsWith('PMT')) {
                        console.log(`   📦 PMT Material: ${line.ItemNo}, PlannedQty: ${plannedQty}, IssuedQty: ${issuedQty}, NeedsIssue: ${plannedQty > 0 && issuedQty === 0}`);
                    }
                    
                    // Include while issued qty is below planned (supports partial issue / resume)
                    return plannedQty > 0 && issuedQty < plannedQty - 1e-6;
                })
                .forEach(line => {
                    const plannedQty = line.PlannedQuantity || 0;
                    const issuedQty = line.IssuedQuantity || 0;
                    const material = {
                        itemNo: line.ItemNo,
                        itemName: line.ItemName || line.ItemNo,
                        plannedQuantity: plannedQty,
                        issuedQuantity: issuedQty,
                        remainingQuantity: Math.max(0, plannedQty - issuedQty),
                        warehouse: line.Warehouse,
                        lineNumber: line.LineNumber
                    };

                    // Unit 1: every BOM component line issues at Running (batch or qty dialog)
                    if (unit1Po) {
                        unissuedMaterials.push(material);
                        return;
                    }
                    
                    // For PST jobs, separate PMT materials (allow operator to issue them at Running state)
                    if (isPSTJob && line.ItemNo && line.ItemNo.toUpperCase().startsWith('PMT')) {
                        pmtMaterialsNeedIssue.push(material);
                    }
                    // For FOI jobs, separate RMC materials (must be issued before job loads)
                    else if (isFOIJob && line.ItemNo && line.ItemNo.toUpperCase().startsWith('RMC')) {
                        rmcMaterialsNeedIssue.push(material);
                    }
                    // For Spot-UV APR jobs, include ALL lines that need issue.
                    // These will be issued via batch selection popup (foil-style) on Start.
                    else if (isSpotUVApr && line.ItemNo) {
                        tapMaterialsNeedIssue.push(material);
                    }
                    // ADH (Adhesive) materials: always route to lamMaterialsNeedIssue regardless of job type
                    else if (line.ItemNo && line.ItemNo.toUpperCase().startsWith('ADH')) {
                        lamMaterialsNeedIssue.push(material);
                    }
                    // For LAM jobs, also separate FIL (Film) materials
                    else if (isLAMJob && line.ItemNo && line.ItemNo.toUpperCase().startsWith('FIL')) {
                        lamMaterialsNeedIssue.push(material);
                    }
                    else {
                        unissuedMaterials.push(material);
                    }
                });
        }
        // Log which product lines contributed to baseQuantities
        const productLinesForBaseQty = productionOrder.ProductionOrderLines
            ?.filter(line => {
                const plannedQty = line.PlannedQuantity || 0;
                return plannedQty > 0 && isProductionOrderItemProductLine(line, isExcludedMaterialItemNo);
            })
            .map(line => ({ itemNo: line.ItemNo, baseQty: line.BaseQuantity })) || [];
        if (DEBUG_PO_LOG) {
            console.log(`BaseQuantities from product lines (excl. PMT/FIL/ADH/RMC):`, baseQuantities, `(from items: ${productLinesForBaseQty.map(l => l.itemNo).join(', ') || 'none'})`);
        }

        // IMPORTANT: Do not block job loading if materials are unissued.
        // We surface these lines to the client and enforce issuing at "Start" instead.
        if (unissuedMaterials.length > 0) {
            console.log(`⚠️ Unissued materials found for PO ${docNumber} (non-blocking):`, unissuedMaterials);
        }
        
        // Log PMT materials if any
        if (pmtMaterialsNeedIssue.length > 0) {
            console.log(`📦 PMT materials need issue for PO ${docNumber}:`, pmtMaterialsNeedIssue);
            
            // Check if any PMT material has already been issued via standalone Goods Issue
            // This handles the case where PMT was issued with a different item code
            // NOTE: This lookup can be very slow in Service Layer (InventoryGenExits scan).
            // Skip it in lightweight mode (materialOnly=1) to keep job load fast.
            if (!materialOnly) try {
                console.log(`   🔍 Checking for existing PMT Goods Issues for PO ${docNumber}...`);
                
                // Query InventoryGenExits (Goods Issues) that mention this PO in comments
                // and contain PMT items
                const goodsIssueQuery = `/InventoryGenExits?$select=DocEntry,DocNum,Comments,DocumentLines&$filter=contains(Comments, '${docNumber}')&$orderby=DocEntry desc&$top=10`;
                
                try {
                    const tGiStart = Date.now();
                    const goodsIssues = await sapGetRequest(goodsIssueQuery);
                    console.log(`   ⏱️ Goods Issue lookup took ${Date.now() - tGiStart}ms`);
                    
                    if (goodsIssues && goodsIssues.value && goodsIssues.value.length > 0) {
                        // Check if any of these Goods Issues contain PMT items
                        for (const gi of goodsIssues.value) {
                            if (gi.DocumentLines && Array.isArray(gi.DocumentLines)) {
                                const hasPMT = gi.DocumentLines.some(line => 
                                    line.ItemCode && line.ItemCode.toUpperCase().startsWith('PMT')
                                );
                                
                                if (hasPMT) {
                                    console.log(`   ✅ Found existing PMT Goods Issue: DocNum ${gi.DocNum}, Comments: ${gi.Comments}`);
                                    console.log(`   📦 PMT already issued via standalone Goods Issue, clearing pmtMaterialsNeedIssue`);
                                    pmtMaterialsNeedIssue = [];  // Clear the list - PMT already issued
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (pmtMaterialsNeedIssue.length > 0) {
                        console.log(`   ℹ️ No existing PMT Goods Issues found for PO ${docNumber}`);
                    }
                } catch (queryErr) {
                    console.log(`   ⚠️ Could not query Goods Issues: ${queryErr.message}`);
                    // Continue with the original pmtMaterialsNeedIssue list
                }
            } catch (err) {
                console.log(`   ⚠️ Error checking for existing PMT issues: ${err.message}`);
            }
        }
        
        // Log RMC materials if any
        if (rmcMaterialsNeedIssue.length > 0) {
            console.log(`📦 RMC materials need issue for FOI job ${docNumber}:`, rmcMaterialsNeedIssue);
        }
        
        // Log LAM/ADH materials if any (FIL = Film, ADH = Adhesive)
        if (lamMaterialsNeedIssue.length > 0) {
            console.log(`📦 LAM/ADH materials need issue for PO ${docNumber}:`, lamMaterialsNeedIssue.map(m => `${m.itemNo}(planned=${m.plannedQuantity})`));
        }

        // Log materials to issue if any (Spot-UV APR)
        if (tapMaterialsNeedIssue.length > 0) {
            console.log(`📦 Materials need issue for Spot-UV APR job ${docNumber}:`, tapMaterialsNeedIssue);
        }

        // Bulk-query ManBtchNum for all unique item codes so the client doesn't need per-item API calls.
        // IMPORTANT: this is only needed for the "materialOnly=1" start/running flow.
        // Avoid doing it during full PO fetch (search/load) to keep response times low.
        const includeBatchManaged =
            materialOnly || String(req.query.includeBatchManaged || '') === '1';
        if (includeBatchManaged) {
            const allMaterialArrays = [pmtMaterialsNeedIssue, rmcMaterialsNeedIssue, lamMaterialsNeedIssue, tapMaterialsNeedIssue, unissuedMaterials];
            const uniqueItemCodes = [...new Set(allMaterialArrays.flat().map(m => m.itemNo).filter(Boolean))];
            const batchManagedMap = {};
            if (uniqueItemCodes.length > 0) {
                const tBatch = Date.now();
                // Serve from in-memory cache first (ManBtchNum is master data — rarely changes).
                const uncachedCodes = [];
                for (const code of uniqueItemCodes) {
                    const cached = batchManagedCache.get(code);
                    if (cached && Date.now() < cached.exp) {
                        batchManagedMap[code] = cached.val;
                    } else {
                        uncachedCodes.push(code);
                    }
                }

                if (uncachedCodes.length > 0) {
                    try {
                        // OData /Items endpoint (single GET) instead of SQL (POST+GET+DELETE = 3 round-trips).
                        const filterParts = uncachedCodes.map(c => `ItemCode eq '${c.replace(/'/g, "''")}'`);
                        const filterStr = filterParts.join(' or ');
                        const odataUrl = `/Items?$select=ItemCode,ManageBatchNumbers&$filter=${filterStr}&$top=${uncachedCodes.length}`;
                        const batchPromise = sapGetRequest(odataUrl);
                        const timeout = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('ManBtchNum lookup timed out')), 8000)
                        );
                        const batchResult = await Promise.race([batchPromise, timeout]);
                        for (const row of (batchResult?.value || [])) {
                            const code = row.ItemCode;
                            const val = row.ManageBatchNumbers ?? row.ManBtchNum;
                            const isBatch = (val === 'tYES' || val === 'Y' || val === 'y' || val === 1 || val === '1' || val === true);
                            batchManagedMap[code] = isBatch;
                            batchManagedCache.set(code, { val: isBatch, exp: Date.now() + BATCH_MANAGED_CACHE_TTL });
                        }
                        console.log(`   🔍 Bulk ManBtchNum: ${uncachedCodes.length} fetched, ${uniqueItemCodes.length - uncachedCodes.length} cached (${Date.now() - tBatch}ms)`);
                    } catch (batchErr) {
                        console.warn(`   ⚠️ Bulk ManBtchNum OData failed (${Date.now() - tBatch}ms): ${batchErr.message}`);
                        // Fallback: SQL query if OData /Items fails
                        try {
                            const inList = uncachedCodes.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
                            const batchRows = await runSapSqlQuery(
                                `SELECT T0."ItemCode", T0."ManBtchNum" FROM OITM T0 WHERE T0."ItemCode" IN (${inList})`,
                                'OITM_ManBtchNum_bulk'
                            );
                            for (const row of (batchRows || [])) {
                                const code = row.ItemCode || row.itemCode || row.ITEMCODE;
                                const val = row.ManBtchNum ?? row.manBtchNum ?? row.MANBTCHNUM;
                                const isBatch = (val === 'Y' || val === 'y' || val === 1 || val === '1' || val === true);
                                batchManagedMap[code] = isBatch;
                                batchManagedCache.set(code, { val: isBatch, exp: Date.now() + BATCH_MANAGED_CACHE_TTL });
                            }
                            console.log(`   🔍 Bulk ManBtchNum (SQL fallback): ${uncachedCodes.length} items in ${Date.now() - tBatch}ms`);
                        } catch (sqlErr) {
                            console.warn(`   ⚠️ Bulk ManBtchNum SQL fallback also failed: ${sqlErr.message}`);
                        }
                    }
                } else {
                    console.log(`   🔍 Bulk ManBtchNum: all ${uniqueItemCodes.length} items served from cache (0ms)`);
                }
                for (const arr of allMaterialArrays) {
                    for (const mat of arr) {
                        mat.batchManaged = !!batchManagedMap[mat.itemNo];
                    }
                }
            }
        }

        // Extract IssuedQuantity / CompletedQuantity from pit_Item lines only (exclude resources, materials)
        // - IssuedQuantity: sum positive IssuedQuantity on pit_Item product lines (SHEETS for DIE/EMB+P)
        // - CompletedQuantity: sum line CompletedQuantity on pit_Item product lines; fallback to PO header
        let issuedQuantity = 0;
        let completedQuantity = 0;
        
        const headerCompletedQty = Math.floor(productionOrder.CompletedQuantity || 0);
        if (DEBUG_PO_LOG) {
            console.log(`📊 Header-level CompletedQuantity from SAP: ${headerCompletedQty} (fallback if no pit_Item line qty)`);
        }
        
        if (productionOrder.ProductionOrderLines && productionOrder.ProductionOrderLines.length > 0) {
            if (DEBUG_PO_LOG) {
                console.log(`📋 Production Order Lines for ${docNumber}:`);
                productionOrder.ProductionOrderLines.forEach((line, idx) => {
                    const isExcluded = isExcludedMaterialItemNo(line.ItemNo);
                    const isItem = isSapItemLine(line);
                    const tag = isExcluded ? '❌ MATERIAL' : (isItem ? '✅ pit_Item' : '⏭️ non-item');
                    console.log(`   Line ${idx}: ItemNo=${line.ItemNo} ItemType=${line.ItemType} ${tag}, PlannedQty=${line.PlannedQuantity || 0}, IssuedQty=${line.IssuedQuantity || 0}, CompletedQty=${line.CompletedQuantity || 0}`);
                });
            }
            
            const itemProductLines = productionOrder.ProductionOrderLines.filter((line) =>
                isProductionOrderItemProductLine(line, isExcludedMaterialItemNo)
            );
            
            if (itemProductLines.length > 0) {
                let lineCompletedSum = 0;
                itemProductLines.forEach((line) => {
                    const issued = line.IssuedQuantity || 0;
                    if (issued > 0) {
                        issuedQuantity += issued;
                    }
                    lineCompletedSum += Math.floor(line.CompletedQuantity || 0);
                });
                completedQuantity = lineCompletedSum > 0 ? lineCompletedSum : headerCompletedQty;
                if (DEBUG_PO_LOG) {
                    console.log(`📊 Found ${itemProductLines.length} pit_Item product line(s): ${itemProductLines.map((l) => l.ItemNo).join(', ')}`);
                    console.log(`   Total IssuedQuantity (positive): ${issuedQuantity}`);
                    console.log(`   Total CompletedQuantity (pit_Item lines): ${lineCompletedSum} → using ${completedQuantity}`);
                }
            } else {
                const firstItemLine = productionOrder.ProductionOrderLines.find((line) =>
                    isProductionOrderItemProductLine(line, isExcludedMaterialItemNo)
                );
                if (firstItemLine) {
                    issuedQuantity = Math.abs(firstItemLine.IssuedQuantity || 0);
                    completedQuantity = Math.floor(firstItemLine.CompletedQuantity || 0) || headerCompletedQty;
                } else {
                    completedQuantity = headerCompletedQty;
                }
                if (DEBUG_PO_LOG) {
                    console.log(`📊 No pit_Item product lines matched; issued=${issuedQuantity}, completed=${completedQuantity}`);
                }
            }
        } else {
            completedQuantity = headerCompletedQty;
        }
        
        const unit1Process = isUnit1ProcessCode(productionOrder.U_PCode);
        const matQty = sumUnit1MaterialQuantities(
            productionOrder.ProductionOrderLines,
            productionOrder.ItemNo
        );
        let localCompletedQuantity = 0;
        let embossingRoleUsedQuantity = null;
        let embossingChemicalUsedQuantity = null;
        let poLocallyReset = false;
        if (unit1Process) {
            issuedQuantity = matQty.issued;
            completedQuantity = headerCompletedQty;
            try {
                const localBatches = await getBatchesByPO(String(docNumber));
                localCompletedQuantity = localBatches.reduce(
                    (sum, b) => sum + (parseInt(b.quantity_processed, 10) || 0),
                    0
                );
                if (isEmbossingProcessCode(productionOrder.U_PCode)) {
                    const emb = await getEmbossingQuantitiesByPO(String(docNumber));
                    embossingChemicalUsedQuantity = emb.chemicalUsed;
                    if (emb.trackedBatches > 0) {
                        embossingRoleUsedQuantity = emb.roleUsed;
                    }
                }
            } catch (localErr) {
                console.warn(`⚠️ Could not load local batches for PO ${docNumber}:`, localErr.message);
            }
            try {
                poLocallyReset = await isPOLocallyReset(String(docNumber));
                if (poLocallyReset && localCompletedQuantity === 0) {
                    completedQuantity = 0;
                    console.log(`   🔄 PO ${docNumber} locally reset — Already Done forced to 0 until SAP posts`);
                } else {
                    completedQuantity = Math.max(headerCompletedQty, localCompletedQuantity);
                }
            } catch (resetErr) {
                console.warn(`⚠️ PO reset check failed for ${docNumber}:`, resetErr.message);
                completedQuantity = Math.max(headerCompletedQty, localCompletedQuantity);
            }
        }

        if (DEBUG_PO_LOG) {
            console.log(`📊 Final values for ${docNumber} (U_PCode: ${productionOrder.U_PCode}):`);
            console.log(`   issuedQuantity: ${issuedQuantity}${unit1Process ? ' (Unit1 RM material)' : ' (pit_Item lines)'}`);
            console.log(`   materialIssuedQuantity: ${matQty.issued} / ${matQty.planned} planned RM`);
            console.log(`   completedQuantity: ${completedQuantity}${localCompletedQuantity ? ` (includes ${localCompletedQuantity} from local DB)` : ''}`);
            console.log(`   Note: Frontend converts issued sheets to cartons for DIE/EMB+P jobs`);
        }

        const fgLines = buildFgLinesFromProductionOrder(productionOrder, isExcludedMaterialItemNo);
        const isJumbledJob = fgLines.length > 1;
        if (isJumbledJob) {
            console.log(`🧩 Jumbled job detected: ${fgLines.length} FG output(s) — ${fgLines.map((f) => f.itemNo).join(', ')}`);
        }

        // Extra lookups for UI convenience (OSCN substitute / customer firm / JobNo).
        // For Running-state material verification popups we only need ProductionOrderLines-derived lists,
        // so allow a lightweight mode to reduce latency.
        //
        // IMPORTANT: keep enrichment ON by default to preserve existing UI/data flow.
        // You can disable it for faster job loads by setting ENABLE_PO_ENRICHMENT=false (and optionally
        // force-enable per request with ?enrich=1, or force-disable with ?enrich=0).
        let itemCodeLabel = '';
        let customerNameByFirm = '';
        let jobNoResolved = '';
        let inventoryUOM = '';
        const poCustomerFields = pickPoCustomerFields(productionOrder);
        let customerNameResolved = poCustomerFields.name || '';

        if (enrichPO) {
            // Run independent lookups in parallel (was sequential — major latency on each PO load)
            const tEnrichStart = Date.now();
            [itemCodeLabel, customerNameByFirm, jobNoResolved, customerNameResolved, inventoryUOM] = await Promise.all([
                withLookupTimeout(fetchOscnSubstitute(productionOrder.ItemNo), '', 'oscnSubstitute'),
                withLookupTimeout(fetchCustomerNameFromOITM_OMRC(productionOrder.ItemNo), '', 'customerByFirm'),
                withLookupTimeout(fetchJobNoFromUJobEnt(productionOrder.U_JobEnt), '', 'jobNo'),
                withLookupTimeout(fetchCustomerNameFromProductionOrder(productionOrder), customerNameResolved, 'customerName'),
                withLookupTimeout(fetchItemInventoryUOM(productionOrder.ItemNo), '', 'inventoryUOM')
            ]);
            console.log(`   ⏱️ Enrichment lookups took ${Date.now() - tEnrichStart}ms`);
        } else if (!materialOnly) {
            if (!customerNameResolved) {
                customerNameResolved = await fetchCustomerNameFromProductionOrder(productionOrder);
            }
            inventoryUOM = await fetchItemInventoryUOM(productionOrder.ItemNo);
        }

        let customerCodeResolved = poCustomerFields.code || productionOrder.U_CustCode || '';
        if (!materialOnly && !customerCodeResolved && productionOrder.U_JobEnt) {
            const omjdCust = await fetchCustomerFromOmjdJob(productionOrder.U_JobEnt);
            customerCodeResolved = omjdCust.code || '';
        }

        // Target width: skip on lightweight PO reads (operator enters width in issue dialog).
        let targetWidth = null;
        if (!materialOnly) {
            try {
                targetWidth = await withLookupTimeout(
                    fetchProductionOrderTargetWidth(
                        productionOrder.AbsoluteEntry,
                        productionOrder.ItemNo
                    ),
                    null,
                    'targetWidth'
                );
            } catch (twErr) {
                console.warn('⚠️ Target width lookup failed:', twErr.message);
            }
        }

        // Map SAP response to job card format
        const jobData = {
            jobNumber: docNumber,
            jobNo: jobNoResolved || docNumber,
            jobName: productionOrder.ProductDescription || productionOrder.ItemNo,
            itemNo: productionOrder.ItemNo,
            productDescription: productionOrder.ProductDescription,
            plannedQuantity: Math.floor(productionOrder.PlannedQuantity || 0),
            completedQuantity: completedQuantity,  // FG done; Unit1 merges SAP header + local DB batches
            sapCompletedQuantity: unit1Process ? (headerCompletedQty || 0) : completedQuantity,
            localCompletedQuantity: unit1Process ? localCompletedQuantity : 0,
            issuedQuantity: issuedQuantity,        // Unit1: RM issued KGS; Unit2 DIE: sheets on product lines
            materialIssuedQuantity: matQty.issued,
            materialPlannedQuantity: matQty.planned,
            embossingRoleUsedQuantity,
            embossingChemicalUsedQuantity,
            uPCode: productionOrder.U_PCode,
            uJobEnt: productionOrder.U_JobEnt,  // For auto-issue linking
            targetWidth: targetWidth,  // mm — produced roll width (OWOR.U_Width / OITM.U_Width), for FBD-RM issue estimate
            customerName: customerNameResolved || customerNameByFirm || '',  // PO U_CustName → OMJD MJD1.U_PrNa, then OITM FirmName
            customerCode: customerCodeResolved,
            inventoryUOM: inventoryUOM || '',
            itemCodeLabel: itemCodeLabel || '',
            absoluteEntry: productionOrder.AbsoluteEntry, // SAP AbsoluteEntry for posting
            baseQuantities: baseQuantities,  // Array of base quantities from order lines (for sheet/carton conversion)
            pmtMaterialsNeedIssue: pmtMaterialsNeedIssue, // PMT materials for PST jobs
            rmcMaterialsNeedIssue: rmcMaterialsNeedIssue, // RMC materials for FOI jobs
            lamMaterialsNeedIssue: lamMaterialsNeedIssue, // LAM materials (FIL/ADH) for LAM jobs
            tapMaterialsNeedIssue: tapMaterialsNeedIssue, // TAP materials for Spot-UV APR jobs
            // Any other material lines with PlannedQuantity>0 and IssuedQuantity=0 (non-blocking on load)
            unissuedMaterialsNeedIssue: unissuedMaterials,
            fgLines,
            isJumbledJob,
            state: 'In Queue',
            isActive: false
        };

        // Optional debug payload for material issue troubleshooting (safe: no credentials).
        const debugMaterial = String(req.query.debugMaterial || '') === '1';
        const materialDebug = debugMaterial ? (() => {
            const summarize = (arr) => {
                const a = Array.isArray(arr) ? arr : [];
                return {
                    total: a.length,
                    batchManagedTrue: a.filter(m => m && m.batchManaged === true).length,
                    batchManagedFalse: a.filter(m => m && m.batchManaged === false).length,
                    batchManagedMissing: a.filter(m => !m || typeof m.batchManaged === 'undefined').length,
                    sample: a.slice(0, 10).map(m => ({
                        itemNo: m?.itemNo,
                        plannedQuantity: m?.plannedQuantity,
                        issuedQuantity: m?.issuedQuantity,
                        warehouse: m?.warehouse,
                        batchManaged: m?.batchManaged
                    }))
                };
            };
            return {
                docNumber,
                materialOnly,
                includeBatchManaged: materialOnly || String(req.query.includeBatchManaged || '') === '1',
                pmt: summarize(jobData.pmtMaterialsNeedIssue),
                rmc: summarize(jobData.rmcMaterialsNeedIssue),
                lam: summarize(jobData.lamMaterialsNeedIssue),
                tap: summarize(jobData.tapMaterialsNeedIssue),
                other: summarize(jobData.unissuedMaterialsNeedIssue)
            };
        })() : undefined;

        console.log(`Production order fetched successfully: ${jobData.jobNumber} (total ${Date.now() - t0}ms)`);

        const sendRaw =
            process.env.SEND_RAW_PRODUCTION_ORDER === 'true' ||
            String(req.query.debug || '') === '1';
        const payload = { success: true, data: jobData };
        if (materialDebug) payload.materialDebug = materialDebug;
        if (sendRaw) {
            payload.raw = productionOrder;
        }

        res.json(payload);

    } catch (error) {
        console.error('Error fetching production order:', error.message);
        console.error('  Document number:', req.params.docNumber);
        console.error('  Stack:', error.stack);
        if (error.response) {
            console.error('  SAP response status:', error.response.status);
            console.error('  SAP response data:', JSON.stringify(error.response.data, null, 2));
        }
        res.status(500).json({
            error: 'Failed to fetch production order',
            message: error.message,
            documentNumber: req.params.docNumber
        });
    }
});

// Search Production Orders (optional - for future use)
app.get('/api/production-orders/search', async (req, res) => {
    try {
        const { query, limit = 10 } = req.query;

        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        // Search across all Series; keep one row per DocumentNumber (highest Series)
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
        const fetchTop = Math.min(limitNum * 20, 500);
        const endpoint = `/ProductionOrders?$select=ItemNo,ProductDescription,U_PCode,PlannedQuantity,DocumentNumber,Series&$filter=(contains(DocumentNumber, '${query}') or contains(ProductDescription, '${query}'))&$orderby=Series desc&$top=${fetchTop}`;

        let rows;
        try {
            const sapData = await sapGetRequest(endpoint);
            rows = dedupeProductionOrdersByHighestSeries(sapData.value || []);
        } catch (searchErr) {
            console.warn(`PO search with $orderby=Series failed (${searchErr.message}), retrying without orderby`);
            const fallbackEndpoint = `/ProductionOrders?$select=ItemNo,ProductDescription,U_PCode,PlannedQuantity,DocumentNumber,Series&$filter=(contains(DocumentNumber, '${query}') or contains(ProductDescription, '${query}'))&$top=${fetchTop}`;
            const sapData = await sapGetRequest(fallbackEndpoint);
            rows = dedupeProductionOrdersByHighestSeries(sapData.value || []);
        }

        const results = rows.slice(0, limitNum).map(po => ({
            documentNumber: po.DocumentNumber,
            itemNo: po.ItemNo,
            productDescription: po.ProductDescription,
            plannedQuantity: Math.floor(po.PlannedQuantity || 0),
            uPCode: po.U_PCode
        }));

        res.json({
            success: true,
            count: results.length,
            data: results
        });

    } catch (error) {
        console.error('Error searching production orders:', error.message);
        res.status(500).json({
            error: 'Failed to search production orders',
            message: error.message
        });
    }
});

// ==================== Diagnostic API Routes ====================

/**
 * GET /api/item-batch-managed/:itemCode
 * Query OITM.ManBtchNum for an ItemCode.
 * Returns whether the item is batch-managed (ManBtchNum = 'Y' / 1).
 */
app.get('/api/item-batch-managed/:itemCode', async (req, res) => {
    try {
        const itemCode = (req.params.itemCode || '').toString().trim();
        if (!itemCode) {
            return res.status(400).json({ success: false, error: 'Item code is required' });
        }

        const k = itemCode.replace(/'/g, "''");
        const rows = await runSapSqlQuery(
            `SELECT T0."ItemCode", T0."ManBtchNum" FROM OITM T0 WHERE T0."ItemCode" = '${k}'`,
            'OITM_ManBtchNum'
        );
        const row = (rows || [])[0] || {};
        const manBtchNum = row.ManBtchNum ?? row.manBtchNum ?? row.MANBTCHNUM ?? null;

        // SAP HANA usually returns 'Y'/'N'; some systems might return 1/0.
        const batchManaged =
            manBtchNum === 'Y' ||
            manBtchNum === 'y' ||
            manBtchNum === 1 ||
            manBtchNum === '1' ||
            manBtchNum === true;

        res.json({
            success: true,
            itemCode,
            manBtchNum,
            batchManaged
        });
    } catch (error) {
        console.error('Error reading ManBtchNum:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to read ManBtchNum',
            message: error.message
        });
    }
});

// Get LAM Production Orders with their materials (for analysis)
// ==================== Validation API Routes ====================

// Validate job completion data (pre-submission validation)
app.post('/api/validate/job-completion', (req, res) => {
    try {
        const { jobData } = req.body;

        if (!jobData) {
            return res.status(400).json({
                success: false,
                error: 'Missing jobData'
            });
        }

        const validationResult = validateJobCompletion({
            sheetsProcessed: jobData.quantity_processed || jobData.sheetsProcessed || 0,
            wastedSheets: jobData.sheets_wasted || jobData.wastedSheets || 0,
            plannedQuantity: jobData.planned_qty || jobData.plannedQuantity || 0,
            machineSpeed: jobData.speed_impressions_per_hour || jobData.machineSpeed || 0,
            makereadySeconds: jobData.makereadySeconds || 0,
            runningSeconds: jobData.runningSeconds || 0,
            totalSeconds: jobData.totalSeconds || 0
        });

        res.json({
            success: true,
            isValid: validationResult.isValid,
            hasErrors: validationResult.hasErrors,
            hasWarnings: validationResult.hasWarnings,
            errors: validationResult.errors,
            warnings: validationResult.warnings,
            errorMessages: validationResult.getErrorMessages(),
            warningMessages: validationResult.getWarningMessages()
        });
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({
            success: false,
            error: 'Validation failed',
            message: error.message
        });
    }
});

// Validate quantities only
app.post('/api/validate/quantities', (req, res) => {
    try {
        const { sheetsProcessed, wastedSheets, plannedQuantity } = req.body;

        const validationResult = validateQuantities({
            sheetsProcessed: sheetsProcessed || 0,
            wastedSheets: wastedSheets || 0,
            plannedQuantity: plannedQuantity || 0
        });

        res.json({
            success: true,
            isValid: validationResult.isValid,
            errors: validationResult.errors,
            warnings: validationResult.warnings
        });
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({
            success: false,
            error: 'Validation failed',
            message: error.message
        });
    }
});

// Get validation configuration
app.get('/api/validate/config', (req, res) => {
    res.json({
        success: true,
        config: VALIDATION_CONFIG
    });
});

// ==================== Database API Routes ====================

// Complete job with all activities (batch insert)
/**
 * Backfill traceability from SAP: read the goods issues linked to a Production
 * Order and record every consumed roll/batch (even ones issued earlier directly
 * in SAP), linking them to the produced output batch. Best-effort, non-blocking.
 */
async function backfillIssuedRollsFromSAP({ absoluteEntry, poNum, outputBatch, operator, machine }) {
    if (!absoluteEntry) return 0;
    const ae = Number(absoluteEntry);

    // Try linked-document filter first (most reliable), fall back to comment match.
    // Filters must be URL-encoded — SAP SL rejects raw spaces/colons in lambda.
    // This B1 Service Layer rejects DocumentLines/any() lambda filters, so we
    // (1) try a cheap comment match, then (2) scan recent goods issues and match
    // the production order's AbsoluteEntry client-side (no lambda required).
    const enc = (f) => f.replace(/ /g, '%20').replace(/:/g, '%3A');
    let docs = [];

    // (1) Comment match — works for app-issued material (PO embedded in Comments)
    try {
        const resp = await sapGetRequest(
            `/InventoryGenExits?$select=DocEntry,Comments,DocumentLines&$filter=${enc(`contains(Comments,'${poNum}')`)}&$orderby=DocEntry desc&$top=30`
        );
        if (resp && Array.isArray(resp.value) && resp.value.length > 0) docs = resp.value;
    } catch (e) {
        console.log(`   ⚠️ Traceability comment-match query failed: ${e.message}`);
    }

    // (2) Recent goods-issue scan — catches material issued directly in SAP too
    const hasMatch = (list) => list.some(d =>
        (d.DocumentLines || []).some(l => Number(l.BaseEntry) === ae));
    if (!hasMatch(docs)) {
        try {
            const resp = await sapGetRequest(
                `/InventoryGenExits?$select=DocEntry,DocumentLines&$orderby=DocEntry desc&$top=400`
            );
            if (resp && Array.isArray(resp.value)) docs = resp.value;
        } catch (e) {
            console.log(`   ⚠️ Traceability recent-scan query failed: ${e.message}`);
        }
    }

    // Keep only goods issues that actually consume this PO, then fetch each in
    // full ($select strips nested BatchNumbers, so a per-doc detail GET is needed).
    const matchedEntries = [...new Set(
        docs.filter(d => (d.DocumentLines || []).some(l => Number(l.BaseEntry) === ae))
            .map(d => d.DocEntry)
    )];

    if (matchedEntries.length === 0) {
        console.log(`   ℹ️ No SAP goods issues found to backfill traceability for PO ${poNum}`);
        return 0;
    }

    const fullDocs = [];
    for (const de of matchedEntries) {
        try {
            const full = await sapGetRequest(`/InventoryGenExits(${de})`);
            if (full) fullDocs.push(full);
        } catch (e) {
            console.log(`   ⚠️ Could not fetch goods issue ${de}: ${e.message}`);
        }
    }

    let recorded = 0;
    for (const doc of fullDocs) {
        const lines = Array.isArray(doc.DocumentLines) ? doc.DocumentLines : [];
        for (const line of lines) {
            // Only lines that belong to this production order
            if (Number(line.BaseEntry) !== ae) continue;
            const itemCode = line.ItemCode || '';
            const warehouse = line.WarehouseCode || line.Warehouse || null;
            const batches = Array.isArray(line.BatchNumbers) ? line.BatchNumbers : [];

            if (batches.length > 0) {
                for (const b of batches) {
                    const id = await recordMaterialIssueIfAbsent({
                        po_num: poNum,
                        absolute_entry: ae,
                        line_number: line.BaseLine,
                        item_code: itemCode,
                        batch_number: b.BatchNumber,
                        quantity: b.Quantity,
                        warehouse,
                        operator_name: operator || null,
                        machine_name: machine || null,
                        sap_doc_entry: doc.DocEntry,
                        remarks: 'Backfilled from SAP goods issue'
                    });
                    if (id) recorded++;
                }
            } else if (itemCode) {
                // Non-batch consumable (e.g. some glue/chemicals) — record qty only
                const id = await recordMaterialIssueIfAbsent({
                    po_num: poNum,
                    absolute_entry: ae,
                    line_number: line.BaseLine,
                    item_code: itemCode,
                    batch_number: `(${itemCode})`,
                    quantity: line.Quantity,
                    warehouse,
                    operator_name: operator || null,
                    machine_name: machine || null,
                    sap_doc_entry: doc.DocEntry,
                    remarks: 'Backfilled from SAP goods issue (non-batch)'
                });
                if (id) recorded++;
            }
        }
    }
    console.log(`   🧬 Traceability backfill: recorded ${recorded} roll(s) for PO ${poNum}${outputBatch ? ` → ${outputBatch}` : ''}`);
    return recorded;
}

/** Record SAP auto-issue allocations into material_issue_log for the target PO (754 ← 753 outputs). */
async function recordAutoIssueAllocationsToPO({
    poNum,
    absoluteEntry,
    lineNumber,
    itemCode,
    warehouse,
    allocations,
    sapDocEntry,
    remarks,
    sourcePoNum
}) {
    if (!poNum || !Array.isArray(allocations) || allocations.length === 0) return 0;
    try {
        const enriched = [];
        for (const a of allocations) {
            const batchNumber = a.batchNumber || a.batch_number || a.batch;
            let sourcePo = sourcePoNum != null ? String(sourcePoNum).trim() : null;
            if (!sourcePo && batchNumber) {
                const owner = await getOutputBatchOwnerPO(String(batchNumber).trim());
                sourcePo = owner?.poNum || null;
            }
            enriched.push({
                ...a,
                batch_number: batchNumber,
                source_po_num: sourcePo
            });
        }
        return await recordMaterialIssues(
            {
                po_num: String(poNum),
                absolute_entry: absoluteEntry != null ? Number(absoluteEntry) : null,
                line_number: lineNumber != null ? Number(lineNumber) : null,
                item_code: itemCode || null,
                warehouse: warehouse || null,
                sap_doc_entry: sapDocEntry != null ? String(sapDocEntry) : null,
                remarks: remarks || 'Auto-issue to next process',
                source_po_num: sourcePoNum != null ? String(sourcePoNum).trim() : null
            },
            enriched
        );
    } catch (e) {
        console.warn('⚠️ recordAutoIssueAllocationsToPO failed (non-blocking):', e.message);
        return 0;
    }
}

/**
 * Backfill material_issue_log for a PO from SAP goods issues (inputs issued before/at run).
 */
async function ensurePOInputsBackfillFromSAP(poNum) {
    const po = String(poNum || '').trim();
    if (!po) return { recorded: 0, absoluteEntry: null };

    const poResp = await sapGetRequest(
        `/ProductionOrders?$filter=DocumentNumber eq ${po}&$select=AbsoluteEntry,DocumentNumber,ItemNo,U_PCode&$top=1`
    );
    const row = poResp?.value?.[0];
    const absoluteEntry = row?.AbsoluteEntry;
    if (!absoluteEntry) {
        return { recorded: 0, absoluteEntry: null, notFound: true };
    }

    const recorded = await backfillIssuedRollsFromSAP({
        absoluteEntry,
        poNum: po,
        outputBatch: null
    });

    return {
        recorded,
        absoluteEntry,
        fgItemCode: row.ItemNo || null,
        processTag: getUnit1ProcessBatchTag(row.U_PCode, null, null, row.ItemNo)
    };
}

/**
 * Build traceability for a PO on demand: resolve its AbsoluteEntry from SAP, find
 * the output batch(es) produced locally, and backfill consumed rolls for each.
 * Returns { recorded, absoluteEntry, outputBatches }.
 */
async function ensureTraceabilityForPO(poNum) {
    const po = String(poNum || '').trim();
    if (!po) return { recorded: 0, absoluteEntry: null, outputBatches: [] };

    // Resolve AbsoluteEntry from SAP
    const poResp = await sapGetRequest(
        `/ProductionOrders?$filter=DocumentNumber eq ${po}&$select=AbsoluteEntry,DocumentNumber&$top=1`
    );
    const absoluteEntry = poResp?.value?.[0]?.AbsoluteEntry;
    if (!absoluteEntry) {
        return { recorded: 0, absoluteEntry: null, outputBatches: [], notFound: true };
    }

    // Find output batch(es) already produced for this PO
    const [batchRows] = await pool.query(
        `SELECT DISTINCT batch_num, MAX(operator_name) AS operator_name, MAX(machine_name) AS machine_name
           FROM production_records WHERE po_num = ? GROUP BY batch_num`,
        [po]
    );

    let total = 0;
    for (const row of batchRows) {
        total += await backfillIssuedRollsFromSAP({
            absoluteEntry,
            poNum: po,
            outputBatch: row.batch_num,
            operator: row.operator_name,
            machine: row.machine_name
        });
    }

    return {
        recorded: total,
        absoluteEntry,
        outputBatches: batchRows.map(r => r.batch_num)
    };
}

app.post('/api/job-complete', async (req, res) => {
    try {
        const { jobData, activities } = req.body;

        // Debug: Log incoming data for SAP posting
        console.log('📥 Job completion request received');
        console.log('   PO Number:', jobData?.po_num);
        console.log('   Operator Name:', jobData?.operator_name);
        console.log('   Absolute Entry:', jobData?.absolute_entry);
        console.log('   Packing Details:', jobData?.packing_details);

        // Basic structure validation
        if (!jobData || !activities || !Array.isArray(activities)) {
            return res.status(400).json({
                error: 'Missing required fields: jobData and activities array',
                code: 'VALIDATION_ERROR'
            });
        }

        // Validate required fields
        const requiredFieldsResult = validateRequiredFields({
            po_num: jobData.po_num,
            machine_name: jobData.machine_name
        });

        if (requiredFieldsResult.hasErrors) {
            return res.status(400).json({
                error: 'Required field validation failed',
                code: 'VALIDATION_ERROR',
                details: requiredFieldsResult.getErrorMessages()
            });
        }

        if (!jobData.job_start_time) {
            return res.status(400).json({
                error: 'Missing required job field: job_start_time',
                code: 'VALIDATION_ERROR'
            });
        }

        if (jobData.machine_name) {
            jobData.machine_name = formatMachineDisplayName(jobData.machine_name);
        }
        if (jobData.machineName) {
            jobData.machineName = formatMachineDisplayName(jobData.machineName);
        }

        // Validate quantities if provided
        if (jobData.quantity_processed !== undefined || jobData.sheets_wasted !== undefined) {
            const quantityResult = validateQuantities({
                sheetsProcessed: jobData.quantity_processed || 0,
                wastedSheets: jobData.sheets_wasted || 0,
                plannedQuantity: jobData.planned_qty || 0
            });

            if (quantityResult.hasErrors) {
                return res.status(400).json({
                    error: 'Quantity validation failed',
                    code: 'VALIDATION_ERROR',
                    details: quantityResult.getErrorMessages()
                });
            }

            // Include warnings in response (don't block, but inform)
            if (quantityResult.hasWarnings) {
                console.warn('⚠️ Quantity warnings:', quantityResult.getWarningMessages());
            }
        }

        // Validate speed if provided
        if (jobData.speed_impressions_per_hour !== undefined && jobData.speed_impressions_per_hour > 0) {
            const speedResult = validateSpeed({
                machineSpeed: jobData.speed_impressions_per_hour
            });

            if (speedResult.hasErrors) {
                return res.status(400).json({
                    error: 'Speed validation failed',
                    code: 'VALIDATION_ERROR',
                    details: speedResult.getErrorMessages()
                });
            }
        }

        // Validate activities have time
        const totalActivityTime = activities.reduce((sum, a) => sum + (a.activity_time_minutes || 0), 0);
        if (totalActivityTime === 0) {
            return res.status(400).json({
                error: 'Job has no recorded activity time',
                code: 'BIZ_005'
            });
        }

        // All validations passed - insert job to local database
        const isUnit1JobComplete = isUnit1JobFromData(jobData);
        const fgForBatch = (jobData.fg_num || jobData.item_no || '').trim();

        if (isUnit1JobComplete && fgForBatch) {
            jobData.use_item_code_batch = true;
            if (!getJobDataUPCode(jobData) && jobData.absolute_entry) {
                try {
                    const poHead = await sapGetRequest(
                        `/ProductionOrders(${jobData.absolute_entry})?$select=U_PCode,ItemNo`
                    );
                    jobData.u_p_code = poHead.U_PCode || '';
                    if (!fgForBatch && poHead.ItemNo) {
                        jobData.fg_num = poHead.ItemNo;
                    }
                } catch (uErr) {
                    console.warn('   Could not fetch U_PCode for batch tag:', uErr.message);
                }
            }
            jobData._batch_process_tag = getUnit1ProcessBatchTag(
                getJobDataUPCode(jobData),
                jobData.process_name,
                jobData.machine_name,
                fgForBatch
            );
            try {
                jobData._sap_batch_seq = await getSapMaxItemBatchSeq(fgForBatch, jobData._batch_process_tag);
                console.log(`   Unit 1 batch format: ${fgForBatch}-${jobData._batch_process_tag}-### (SAP max seq: ${jobData._sap_batch_seq})`);
            } catch (seqErr) {
                console.warn('   SAP batch seq lookup skipped:', seqErr.message);
                jobData._sap_batch_seq = 0;
            }
        }

        const duplicateCompletion = await findRecentDuplicateJobCompletion(
            jobData.po_num,
            jobData.job_start_time,
            jobData.quantity_processed
        );
        if (duplicateCompletion) {
            console.warn(`⚠️ Duplicate job-complete ignored for PO ${jobData.po_num} (batch ${duplicateCompletion.batch_num})`);
            return res.json({
                success: true,
                duplicate: true,
                batch_num: duplicateCompletion.batch_num,
                inserted: 0,
                message: 'Duplicate submit ignored — job already saved',
                validationPassed: true,
                sapPosted: false,
                sapError: null
            });
        }

        if (Array.isArray(jobData.role_usages) && jobData.role_usages.length > 0 && jobData.po_num) {
            const fg = fgForBatch || jobData.fg_num || jobData.item_no || '';
            const processTag = jobData._batch_process_tag || getUnit1ProcessBatchTag(
                getJobDataUPCode(jobData),
                jobData.process_name,
                jobData.machine_name,
                fg
            );
            const allowedSourcePos = await resolveSourcePOsForProcessInputs(
                jobData.po_num,
                processTag,
                fg
            );
            const allowedSet = new Set(allowedSourcePos.map(String));
            for (const u of jobData.role_usages) {
                const batch = String(u.batch_number || u.batchNumber || '').trim();
                const inputType = String(u.input_type || u.inputType || 'raw_roll').trim();
                if (!batch || inputType !== 'process_batch') continue;
                let sourcePo = String(u.source_po_num || u.sourcePoNum || '').trim();
                if (!sourcePo) {
                    const owner = await getOutputBatchOwnerPO(batch);
                    sourcePo = owner?.poNum || '';
                    if (sourcePo) u.source_po_num = sourcePo;
                }
                if (allowedSet.size > 0 && sourcePo && !allowedSet.has(sourcePo)) {
                    return res.status(400).json({
                        success: false,
                        error: `Batch ${batch} is from PO ${sourcePo}, not linked to PO ${jobData.po_num}. Expected source PO(s): ${allowedSourcePos.join(', ')}`
                    });
                }
                if (sourcePo) {
                    const owner = await getOutputBatchOwnerPO(batch, sourcePo);
                    if (!owner?.poNum) {
                        return res.status(400).json({
                            success: false,
                            error: `Batch ${batch} was not produced on PO ${sourcePo}`
                        });
                    }
                }
            }
        }

        const result = await insertJobActivities(jobData, activities);

        // Report completion inputs → role_batch_usage (authoritative traceability link)
        if (result?.batch_num && Array.isArray(jobData.role_usages) && jobData.role_usages.length > 0) {
            try {
                const recorded = await recordRoleBatchUsages(
                    jobData.po_num,
                    result.batch_num,
                    jobData.role_usages,
                    {
                        operator_name: jobData.operator_name || jobData.operatorName || null,
                        machine_name: jobData.machine_name || jobData.machineName || null
                    }
                );
                await backfillRoleBatchUsageOperators(jobData.po_num);
                console.log(`   ✅ Recorded ${recorded} input usage row(s) → output batch ${result.batch_num}`);
            } catch (usageErr) {
                console.warn('⚠️ role_batch_usage save failed (non-blocking):', usageErr.message);
            }
        }

        // ========== ADH / LAM MATERIAL ISSUE (before SAP report completion) ==========
        let lamIssueResult = null;

        if (jobData.lam_material_codes && jobData.absolute_entry) {
            console.log('📦 ADH/LAM material codes detected — issuing BEFORE SAP report completion...');
            console.log('   lam_material_codes:', JSON.stringify(jobData.lam_material_codes, null, 2));
            console.log('   absolute_entry:', jobData.absolute_entry);
            console.log('   planned_qty:', jobData.planned_qty, '| quantity_processed:', jobData.quantity_processed);

            lamIssueResult = await issueLAMMaterials({
                absoluteEntry: jobData.absolute_entry,
                documentNumber: jobData.po_num,
                lamMaterialCodes: jobData.lam_material_codes,
                plannedQty: jobData.lam_material_codes.plannedQty || jobData.planned_qty || 0,
                actualQty: jobData.quantity_processed || 0,
                remarks: `ADH material issue for PO ${jobData.po_num} - Operator: ${jobData.operator_name || 'Unknown'}`
            });

            if (lamIssueResult.success) {
                console.log('✅ ADH/LAM material issue completed successfully');
            } else {
                console.warn('⚠️ ADH/LAM material issue had errors:', lamIssueResult.errors);
            }
        } else {
            if (!jobData.lam_material_codes) {
                console.log('ℹ️ No lam_material_codes in payload — ADH issue skipped');
            } else if (!jobData.absolute_entry) {
                console.log('ℹ️ lam_material_codes present but no absolute_entry — ADH issue skipped');
            }
        }
        // ========== END ADH / LAM MATERIAL ISSUE ==========

        // Detect jumbled (multi-output) jobs early — used for SAP flow branching
        const isJumbledJob = jobData.is_jumbled_job ||
            (jobData.fg_lines && Array.isArray(jobData.fg_lines) && jobData.fg_lines.length > 1);

        // ========== RESOURCE LINE + ISSUE (Unit 2 only — Unit 1 has no resources) ==========
        let resourceIssueResult = null;

        if (jobData.absolute_entry) {
            const isUnit1Job = isUnit1JobFromData(jobData);

            if (isUnit1Job) {
                try {
                    const stripResult = await removeUnit1ResourceLinesFromPO(jobData.absolute_entry);
                    console.log('ℹ️ Unit 1 — all resource lines removed; resource issue skipped', stripResult);
                } catch (stripErr) {
                    console.warn('⚠️ Could not strip Unit 1 resource lines:', stripErr.message);
                }
                resourceIssueResult = { success: true, skipped: true, reason: 'unit1_no_resources' };
            } else {
                resourceIssueResult = await ensureAndIssueProductionResource({
                    absoluteEntry: jobData.absolute_entry,
                    documentNumber: jobData.po_num,
                    machineName: jobData.machine_name,
                    startTime: jobData.job_start_time,
                    endTime: jobData.job_end_time,
                    remarks: `Resource issue for PO ${jobData.po_num} - Machine: ${jobData.machine_name || 'Unknown'} - Operator: ${jobData.operator_name || 'Unknown'}`
                });

                if (!resourceIssueResult.success) {
                    if (isJumbledJob) {
                        console.warn('⚠️ Jumbled job — resource issue failed (continuing to report completion):', resourceIssueResult.error);
                        resourceIssueResult = { ...resourceIssueResult, skipped: true };
                    } else {
                        throw new Error(`Resource issue failed before report completion: ${resourceIssueResult.error || 'Unknown error'}`);
                    }
                } else {
                    console.log('✅ Resource line/issue completed before SAP report completion');
                }
            }
        } else {
            console.log('ℹ️ No absoluteEntry - resource line/issue skipped');
        }
        // ========== END RESOURCE LINE + ISSUE ==========

        // Post to SAP if absoluteEntry is provided
        let sapResult = null;
        let jumbledCoProductIssueResult = null;
        
        if (jobData.absolute_entry) {
            if (isJumbledJob && jobData.fg_lines?.length > 1) {
                // ========== JUMBLED JOB SAP POSTING ==========
                console.log('📤 Posting JUMBLED job completion to SAP...');
                console.log(`   FG Lines: ${jobData.fg_lines.length}`);

                jumbledCoProductIssueResult = await issueJumbledCoProductsBeforeCompletion({
                    absoluteEntry: jobData.absolute_entry,
                    documentNumber: jobData.po_num,
                    sheetsProcessed: jobData.quantity_processed || 0,
                    fgLines: jobData.fg_lines,
                    batchNumber: result.batch_num,
                    batchComments: jobData.remark || '',
                    machineName: jobData.machine_name || '',
                    startTime: jobData.job_start_time || '',
                    endTime: jobData.job_end_time || '',
                    packingDetails: jobData.packing_details || '',
                    remarks: `Jumbled co-product pre-receipt PO ${jobData.po_num}`
                });

                if (!jumbledCoProductIssueResult.success) {
                    const failedItems = (jumbledCoProductIssueResult.results || [])
                        .filter((r) => !r.success && !r.skipped)
                        .map((r) => `${r.itemNo}: ${r.error}`)
                        .join('; ');
                    sapResult = {
                        success: false,
                        error: failedItems || 'Co-product pre-receipt failed before main report completion'
                    };
                    console.warn('⚠️ Jumbled job blocked — co-product pre-receipt failed:', sapResult.error);
                } else {
                    sapResult = await postJumbledJobCompletionToSAP({
                        absoluteEntry: jobData.absolute_entry,
                        sheetsProcessed: jobData.quantity_processed || 0,
                        fgLines: jobData.fg_lines,
                        batchNumber: result.batch_num,
                        batchComments: jobData.remark || '',
                        operatorName: jobData.operator_name || '',
                        machineName: jobData.machine_name || '',
                        startTime: jobData.job_start_time || '',
                        endTime: jobData.job_end_time || '',
                        packingDetails: jobData.packing_details || '',
                        remarks: jobData.remark || 'Jumbled job completion'
                    });

                    if (sapResult.success) {
                        console.log(`✅ Jumbled job SAP posting successful - ${sapResult.linesPosted} line(s) posted`);
                        if (jobData.po_num) {
                            clearPOLocalReset(String(jobData.po_num)).catch(() => {});
                        }
                    } else {
                        console.warn('⚠️ Jumbled job SAP posting failed:', sapResult.error);
                    }
                }
            } else {
                // ========== NORMAL JOB SAP POSTING ==========
                console.log('📤 Posting job completion to SAP...');
                // Use quantity_for_sap if provided (includes UPs multiplication for DieCutting)
                // Otherwise fall back to quantity_processed
                const sapQuantity = jobData.quantity_for_sap || jobData.quantity_processed || 0;
                console.log(`   Quantity for SAP: ${sapQuantity} (original: ${jobData.quantity_processed})`);

                sapResult = await postJobCompletionToSAP({
                    absoluteEntry: jobData.absolute_entry,
                    quantity: sapQuantity,
                    batchNumber: result.batch_num,
                    batchComments: jobData.remark || '',
                    operatorName: jobData.operator_name || '',
                    itemCode: jobData.fg_num || jobData.item_no || '',
                    uPCode: jobData.u_p_code || jobData.uPCode || '',
                    machineName: jobData.machine_name || '',
                    startTime: jobData.job_start_time || '',
                    endTime: jobData.job_end_time || '',
                    packingDetails: jobData.packing_details || '',
                    deviceId: jobData.device_id || '',
                    remarks: jobData.remark || '',
                    // Witty/Wity UDFs (optional)
                    U_Length: jobData.U_Length,
                    U_Width: jobData.U_Width,
                    U_MILL: jobData.U_MILL,
                    U_GRADE: jobData.U_GRADE,
                    U_GSM: jobData.U_GSM
                });

                if (sapResult.success) {
                    console.log('✅ SAP posting successful');
                    if (jobData.po_num) {
                        clearPOLocalReset(String(jobData.po_num)).catch((err) => {
                            console.warn('⚠️ Could not clear PO local reset flag:', err.message);
                        });
                    }
                } else {
                    console.warn('⚠️ SAP posting failed:', sapResult.error);
                }
            }
        } else {
            console.log('⚠️ No absoluteEntry provided - skipping SAP posting');
        }

        // ========== AUTO-ISSUE TO NEXT PROCESS ==========
        let nextProcessResult = null;

        // Only proceed with auto-issue if SAP posting was successful and we have quantity
        if (sapResult?.success && jobData.quantity_processed > 0 && jobData.absolute_entry) {
            // Fetch U_JobEnt from SAP if not provided
            let uJobEnt = jobData.u_job_ent;
            let uPCode = jobData.u_p_code || jobData.process_code;

            if (!uJobEnt && jobData.absolute_entry) {
                console.log('   Fetching U_JobEnt from SAP...');
                try {
                    const poData = await sapGetRequest(`/ProductionOrders(${jobData.absolute_entry})?$select=U_JobEnt,U_PCode,ItemNo`);
                    uJobEnt = poData.U_JobEnt;
                    if (!uPCode) uPCode = poData.U_PCode;
                    console.log(`   ✅ U_JobEnt: ${uJobEnt}`);
                    console.log(`   ✅ U_PCode: ${uPCode}`);
                } catch (fetchError) {
                    console.error('   ❌ Failed to fetch from SAP:', fetchError.message);
                }
            } else if (jobData.absolute_entry && !uPCode) {
                // Parity: old path filled U_PCode from the same GET as U_JobEnt; if client sent u_job_ent but no process code, backfill U_PCode only (one small GET).
                try {
                    const poData = await sapGetRequest(`/ProductionOrders(${jobData.absolute_entry})?$select=U_PCode`);
                    uPCode = poData.U_PCode;
                } catch {
                    // ignore
                }
            }

            if (isJumbledJob && jobData.fg_lines?.length > 1) {
                // ========== JUMBLED JOB AUTO-ISSUE ==========
                // Each FG item is issued to its respective next process PO
                if (uJobEnt) {
                    nextProcessResult = await processJumbledJobAutoIssue(
                        jobData, 
                        sapResult, 
                        uJobEnt, 
                        result.batch_num
                    );
                } else {
                    console.log('ℹ️ Missing U_JobEnt - cannot search for next process for jumbled job');
                    nextProcessResult = {
                        success: false,
                        isJumbledJob: true,
                        error: 'Missing U_JobEnt - cannot search for next process'
                    };
                }
            } else {
                // ========== NORMAL JOB AUTO-ISSUE ==========
                console.log(`\n🔄 ========== AUTO-ISSUE CHECK ==========`);
                
                // Get the finished item code
                const finishedItemCode = jobData.fg_num || jobData.item_no;

                if (uJobEnt && finishedItemCode) {
                    console.log(`   Finished Item: ${finishedItemCode}`);
                    console.log(`   Current PO: ${jobData.po_num} (AbsEntry: ${jobData.absolute_entry})`);
                    console.log(`   Process: ${uPCode}`);

                    if (isTerminalUnit1Process(uPCode, finishedItemCode)) {
                        console.log(`   ℹ️ Terminal process (FG) — skipping auto-issue`);
                        nextProcessResult = {
                            success: false,
                            skipped: true,
                            error: 'Terminal FG process — no auto-issue'
                        };
                    } else {
                    // Find next process PO where this item is required as input
                    const nextPO = await findNextProcessByItemRequired(
                        uJobEnt,
                        finishedItemCode,
                        jobData.absolute_entry,
                        uPCode
                    );

                    if (nextPO) {
                        console.log(`\n📋 Found next process: ${nextPO.uPCode} (PO: ${nextPO.documentNumber})`);
                        
                        // Step 1: Release the next PO (required before issuing materials)
                        console.log('📋 Step 1: Releasing next Production Order...');
                        const releaseResult = await releaseProductionOrder(nextPO.absoluteEntry, nextPO.documentNumber);

                        if (!releaseResult.success) {
                            console.warn('⚠️ Failed to release next PO - cannot issue materials');
                            nextProcessResult = {
                                success: false,
                                error: `Failed to release PO: ${releaseResult.error}`,
                                releaseError: true,
                                targetPO: nextPO.documentNumber,
                                targetProcess: nextPO.uPCode
                            };
                        } else {
                            console.log('📋 Step 2: Reconciling auto-issue gap (SAP completed − next PO issued)...');

                            const autoIssueWarehouse =
                                sapResult?.warehouseCode ||
                                nextPO.targetLine?.warehouse ||
                                getUnit1OutputWarehouse(uPCode, finishedItemCode);

                            nextProcessResult = await reconcileAutoIssueGap({
                                sourceAbsoluteEntry: jobData.absolute_entry,
                                sourceDocNumber: jobData.po_num,
                                uJobEnt,
                                finishedItemCode,
                                sourceWarehouse: autoIssueWarehouse,
                                uPCode,
                                remarks: `Auto-issue from ${uPCode} PO ${jobData.po_num} to ${nextPO.uPCode} PO ${nextPO.documentNumber}`
                            });

                            if (nextProcessResult.success && !nextProcessResult.skipped) {
                                console.log(`✅ Auto-issued ${nextProcessResult.totalIssued} units (gap reconcile) to ${nextPO.uPCode} PO ${nextPO.documentNumber}`);
                            } else if (nextProcessResult.skipped) {
                                console.log(`ℹ️ Auto-issue reconcile skipped: ${nextProcessResult.message || 'in sync'}`);
                            } else {
                                console.warn('⚠️ Auto-issue reconcile failed:', nextProcessResult.error);
                            }
                            nextProcessResult.targetPO = nextPO.documentNumber;
                            nextProcessResult.targetProcess = nextPO.uPCode;
                        }
                    } else {
                        console.log(`ℹ️ No next process PO found requiring item ${finishedItemCode}`);
                        console.log(`   This may be the final process or no related PO exists`);
                        nextProcessResult = {
                            success: false,
                            error: 'No next process PO found requiring this item',
                            skipped: true
                        };
                    }
                    }
                } else {
                    if (!uJobEnt) {
                        console.log('ℹ️ Missing U_JobEnt - cannot search for next process');
                    }
                    if (!finishedItemCode) {
                        console.log('ℹ️ Missing finished item code - cannot search for next process');
                    }
                }
                console.log(`========================================\n`);
            }
        } else {
            if (!sapResult?.success) {
                console.log('ℹ️ SAP posting not successful - skipping auto-issue');
            } else if (jobData.quantity_processed <= 0) {
                console.log('ℹ️ No quantity processed - skipping auto-issue');
            } else if (!jobData.absolute_entry) {
                console.log('ℹ️ No absoluteEntry - skipping auto-issue');
            }
        }
        // ========== END AUTO-ISSUE ==========

        // (ADH/LAM material issue already executed above, before SAP posting)

        // Build response based on job type
        const responseData = {
            success: true,
            batch_num: result.batch_num,
            inserted: result.inserted,
            message: `Job completed with ${result.inserted} activities`,
            validationPassed: true,
            sapPosted: sapResult?.success || false,
            sapError: sapResult?.error || null,
            isJumbledJob: isJumbledJob
        };

        // Add auto-issue results
        if (nextProcessResult) {
            if (isJumbledJob && nextProcessResult.isJumbledJob) {
                // Jumbled job response format
                responseData.autoIssue = {
                    success: nextProcessResult.success,
                    isJumbledJob: true,
                    totalFGItems: nextProcessResult.totalFGItems,
                    successfulIssues: nextProcessResult.successfulIssues,
                    results: nextProcessResult.results,
                    error: nextProcessResult.error || null
                };
            } else {
                // Normal job response format
                responseData.autoIssue = {
                    success: nextProcessResult.success,
                    totalIssued: nextProcessResult.totalIssued || 0,
                    targetPO: nextProcessResult.targetPO || null,
                    targetProcess: nextProcessResult.targetProcess || null,
                    targetLine: nextProcessResult.targetLine || null,
                    warehouse: nextProcessResult.warehouse || null,
                    error: nextProcessResult.error || null,
                    skipped: nextProcessResult.skipped || false
                };
            }
        } else {
            responseData.autoIssue = null;
        }

        // Add LAM material issue results
        if (lamIssueResult) {
            responseData.lamIssue = {
                success: lamIssueResult.success,
                film: lamIssueResult.film || null,
                adhesive: lamIssueResult.adhesive || null,
                errors: lamIssueResult.errors || []
            };
        } else {
            responseData.lamIssue = null;
        }

        responseData.resourceIssue = resourceIssueResult ? {
            success: resourceIssueResult.success,
            resourceCode: resourceIssueResult.resourceCode || null,
            resourceName: resourceIssueResult.resourceName || null,
            lineNumber: resourceIssueResult.lineNumber ?? null,
            quantity: resourceIssueResult.quantity || 0,
            issuedQuantity: resourceIssueResult.issuedQuantity || 0,
            docEntry: resourceIssueResult.docEntry || null,
            skipped: resourceIssueResult.skipped || false,
            error: resourceIssueResult.error || null
        } : null;

        if (jumbledCoProductIssueResult) {
            responseData.jumbledCoProductIssue = {
                success: jumbledCoProductIssueResult.success,
                results: jumbledCoProductIssueResult.results || [],
                skipped: jumbledCoProductIssueResult.skipped || false
            };
        }

        res.json(responseData);
    } catch (error) {
        console.error('Error completing job:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            error: 'Failed to complete job',
            message: error.message,
            details: error.code || error.errno || 'Unknown error'
        });
    }
});

// Test SAP posting endpoint (for debugging)
app.post('/api/test-sap-post', async (req, res) => {
    try {
        const { absoluteEntry, quantity } = req.body;

        if (!absoluteEntry) {
            return res.status(400).json({ error: 'absoluteEntry is required' });
        }

        console.log('🧪 Testing SAP posting with absoluteEntry:', absoluteEntry);

        try {
            const strip = await removeUnit1ResourceLinesFromPO(absoluteEntry);
            console.log('🧪 Strip Unit1 resource lines:', strip);
        } catch (stripErr) {
            console.warn('🧪 Strip failed:', stripErr.message);
        }

        const testData = {
            absoluteEntry: absoluteEntry,
            quantity: quantity || 1,
            batchNumber: `TEST-${Date.now()}`,
            batchComments: 'Test posting from API',
            operatorName: 'Test Operator',
            machineName: 'Test Machine',
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            packingDetails: '',
            deviceId: 'TEST-DEVICE',
            remarks: 'Test SAP posting'
        };

        const sapResult = await postJobCompletionToSAP(testData);

        res.json({
            success: sapResult.success,
            testData: testData,
            sapResponse: sapResult.data || null,
            sapError: sapResult.error || null,
            sapDetails: sapResult.details || null
        });
    } catch (error) {
        console.error('Test SAP post error:', error);
        res.status(500).json({
            error: 'Test failed',
            message: error.message
        });
    }
});

// Get activities by batch number
app.get('/api/activities/batch/:batchNum', async (req, res) => {
    try {
        const { batchNum } = req.params;
        const activities = await getActivitiesByBatchNum(batchNum);

        res.json({
            success: true,
            count: activities.length,
            activities: activities
        });
    } catch (error) {
        console.error('Error fetching activities:', error);
        res.status(500).json({
            error: 'Failed to fetch activities',
            message: error.message
        });
    }
});

// Get all batches for a PO
app.get('/api/batches/po/:poNum', async (req, res) => {
    try {
        const { poNum } = req.params;
        const batches = await getBatchesByPO(poNum);

        res.json({
            success: true,
            count: batches.length,
            batches: batches
        });
    } catch (error) {
        console.error('Error fetching batches:', error);
        res.status(500).json({
            error: 'Failed to fetch batches',
            message: error.message
        });
    }
});

/**
 * DELETE /api/local-data/po/:poNum
 * Remove local production_records for a PO (does not touch SAP).
 * Use when test/failed completions inflated Already Done without SAP posting.
 */
app.delete('/api/local-data/po/:poNum', async (req, res) => {
    try {
        const poNum = String(req.params.poNum || '').trim();
        if (!poNum) {
            return res.status(400).json({ success: false, error: 'PO number is required' });
        }

        const result = await deleteRecordsByPO(poNum);
        console.log(`🗑️ Cleared local data for PO ${poNum}: ${result.deleted} row(s), batches: ${result.batches.join(', ') || 'none'}`);

        res.json({
            success: true,
            poNum,
            deletedRows: result.deleted,
            batchesRemoved: result.batches,
            message: `Local data cleared for PO ${poNum}. Reload the job from SAP to refresh quantities.`
        });
    } catch (error) {
        console.error('Error clearing local PO data:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to clear local PO data',
            message: error.message
        });
    }
});

// Get job summary by batch number
app.get('/api/job-summary/:batchNum', async (req, res) => {
    try {
        const { batchNum } = req.params;
        const summary = await getJobSummary(batchNum);

        if (!summary) {
            return res.status(404).json({
                error: 'Job not found',
                batch_num: batchNum
            });
        }

        res.json({
            success: true,
            summary: summary
        });
    } catch (error) {
        console.error('Error fetching job summary:', error);
        res.status(500).json({
            error: 'Failed to fetch job summary',
            message: error.message
        });
    }
});

// Get shift summary
app.get('/api/shift-summary', async (req, res) => {
    try {
        const { machineName, date, shiftType } = req.query;

        if (!machineName || !date || !shiftType) {
            return res.status(400).json({
                error: 'Missing required parameters: machineName, date, shiftType'
            });
        }

        const summary = await getShiftSummary(machineName, date, shiftType);

        res.json({
            success: true,
            summary: summary
        });
    } catch (error) {
        console.error('Error fetching shift summary:', error);
        res.status(500).json({
            error: 'Failed to fetch shift summary',
            message: error.message
        });
    }
});

// Get activities by machine and date
app.get('/api/activities/machine/:machineName/date/:date', async (req, res) => {
    try {
        const { machineName, date } = req.params;
        const activities = await getActivitiesByMachineAndDate(machineName, date);

        res.json({
            success: true,
            count: activities.length,
            activities: activities
        });
    } catch (error) {
        console.error('Error fetching activities:', error);
        res.status(500).json({
            error: 'Failed to fetch activities',
            message: error.message
        });
    }
});

// Update batch (for job completion updates)
app.put('/api/batch/:batchNum', async (req, res) => {
    try {
        const { batchNum } = req.params;
        const updateData = req.body;

        const updated = await updateBatchActivities(batchNum, updateData);

        if (!updated) {
            return res.status(404).json({
                error: 'Batch not found or no changes made',
                batch_num: batchNum
            });
        }

        res.json({
            success: true,
            message: 'Batch updated successfully'
        });
    } catch (error) {
        console.error('Error updating batch:', error);
        res.status(500).json({
            error: 'Failed to update batch',
            message: error.message
        });
    }
});

// Get best historical performance for a FG number
app.get('/api/best-performance/:fgNum', async (req, res) => {
    try {
        const { fgNum } = req.params;
        const { machineName } = req.query;
        
        console.log(`📊 Fetching best performance for FG: ${fgNum}${machineName ? ` (machine: ${machineName})` : ''}`);
        
        const performance = await getBestPerformance(fgNum, machineName);
        
        // Calculate estimates if we have history
        let estimates = null;
        if (performance.hasHistory && performance.bestMakeReadyMinutes !== null) {
            estimates = {
                bestMakeReadyMinutes: performance.bestMakeReadyMinutes,
                bestMakeReadyMachine: performance.bestMakeReadyMachine,
                bestRunningPerUnit: performance.bestRunningPerUnit,  // minutes per unit
                avgRunningPerUnit: performance.avgRunningPerUnit,
                bestRunningMachine: performance.bestRunningMachine,
                bestSpeed: performance.bestSpeed,
                avgSpeed: performance.avgSpeed
            };
        }
        
        console.log(`   Found ${performance.jobCount} historical jobs`);
        if (estimates) {
            console.log(`   Best MakeReady: ${estimates.bestMakeReadyMinutes} min (${estimates.bestMakeReadyMachine || 'unknown'})`);
            console.log(`   Best Running/Unit: ${parseFloat(estimates.bestRunningPerUnit || 0).toFixed(4)} min/unit (${estimates.bestRunningMachine || 'unknown'})`);
        }
        
        res.json({ 
            success: true,
            performance: performance,
            estimates: estimates
        });
    } catch (error) {
        console.error('Error fetching best performance:', error);
        res.status(500).json({ 
            error: 'Failed to fetch best performance', 
            message: error.message 
        });
    }
});

/**
 * GET /api/item-availability/:itemCode
 * Check item availability in warehouse
 */
app.get('/api/item-availability/:itemCode', async (req, res) => {
    try {
        const { itemCode } = req.params;
        const { warehouse } = req.query;
        
        if (!itemCode) {
            return res.status(400).json({ error: 'Item code is required' });
        }
        
        console.log(`📦 Checking availability for item: ${itemCode}, warehouse: ${warehouse || 'all'}`);
        
        const itemEndpoint = `/Items('${encodeURIComponent(itemCode)}')?$select=ItemCode,ItemName,InventoryUOM,QuantityOnStock,ItemWarehouseInfoCollection`;
        const itemData = await sapGetRequest(itemEndpoint);
        
        if (!itemData) {
            return res.status(404).json({
                error: 'Item not found',
                itemCode: itemCode
            });
        }
        
        let availableQuantity = itemData.QuantityOnStock || 0;
        let warehouseStock = null;
        
        if (warehouse && itemData.ItemWarehouseInfoCollection) {
            warehouseStock = itemData.ItemWarehouseInfoCollection.find(
                w => w.WarehouseCode === warehouse
            );
            if (warehouseStock) {
                availableQuantity = warehouseStock.InStock || 0;
            }
        }
        
        console.log(`   Item: ${itemData.ItemName}`);
        console.log(`   Available: ${availableQuantity}`);
        
        res.json({
            success: true,
            itemCode: itemData.ItemCode,
            itemName: itemData.ItemName,
            inventoryUOM: itemData.InventoryUOM || '',
            totalStock: itemData.QuantityOnStock || 0,
            availableQuantity: availableQuantity,
            warehouse: warehouse || 'all',
            warehouseStock: warehouseStock ? warehouseStock.InStock : null
        });
        
    } catch (error) {
        console.error('Error checking item availability:', error);
        res.status(500).json({
            error: 'Failed to check availability',
            message: error.message
        });
    }
});

/**
 * GET /api/item-uom/:itemCode
 * Lightweight lookup: fetch InventoryUOM from OITM via Service Layer
 */
app.get('/api/item-uom/:itemCode', async (req, res) => {
    try {
        const { itemCode } = req.params;
        if (!itemCode) return res.status(400).json({ error: 'Item code is required' });

        const data = await sapGetRequest(`/Items('${encodeURIComponent(itemCode)}')?$select=ItemCode,InventoryUOM`);
        if (!data) return res.status(404).json({ error: 'Item not found', itemCode });

        res.json({ success: true, itemCode: data.ItemCode, inventoryUOM: data.InventoryUOM || '' });
    } catch (error) {
        console.error('Error fetching item UoM:', error.message);
        res.status(500).json({ error: 'Failed to fetch UoM', message: error.message });
    }
});

/**
 * POST /api/update-production-order-line
 * Update the item code in a production order line
 * Used when operator changes the material code in the issue dialog
 * This ensures the new material is reflected in the production order
 */
app.post('/api/update-production-order-line', async (req, res) => {
    try {
        const { absoluteEntry, documentNumber, lineNumber, newItemCode, originalItemCode } = req.body;
        
        console.log(`📝 ========== UPDATE PRODUCTION ORDER LINE ==========`);
        console.log(`   PO AbsoluteEntry: ${absoluteEntry}`);
        console.log(`   PO DocumentNumber: ${documentNumber}`);
        console.log(`   Line Number: ${lineNumber}`);
        console.log(`   Original Item: ${originalItemCode}`);
        console.log(`   New Item: ${newItemCode}`);
        
        if (!absoluteEntry || lineNumber === undefined || !newItemCode) {
            return res.status(400).json({
                error: 'Missing required fields',
                message: 'absoluteEntry, lineNumber, and newItemCode are required'
            });
        }
        
        // Verify the new item exists in SAP
        const itemEndpoint = `/Items('${encodeURIComponent(newItemCode)}')?$select=ItemCode,ItemName`;
        let itemData;
        try {
            itemData = await sapGetRequest(itemEndpoint);
            if (!itemData || !itemData.ItemCode) {
                return res.status(404).json({
                    error: 'Item not found',
                    message: `Item ${newItemCode} does not exist in SAP`,
                    itemCode: newItemCode
                });
            }
            console.log(`   ✅ New item verified: ${itemData.ItemCode} - ${itemData.ItemName}`);
        } catch (itemErr) {
            console.log(`   ❌ Item verification failed: ${itemErr.message}`);
            return res.status(404).json({
                error: 'Item not found',
                message: `Item ${newItemCode} does not exist in SAP`,
                itemCode: newItemCode
            });
        }
        
        // Get current production order to verify line exists and check status
        const poEndpoint = `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,DocumentNumber,ProductionOrderStatus,ProductionOrderLines`;
        const poData = await sapGetRequest(poEndpoint);
        
        if (!poData) {
            return res.status(404).json({
                error: 'Production Order not found',
                absoluteEntry: absoluteEntry
            });
        }
        
        console.log(`   PO Status: ${poData.ProductionOrderStatus}`);
        
        // Find the line to update
        const targetLine = poData.ProductionOrderLines?.find(line => line.LineNumber === lineNumber);
        if (!targetLine) {
            return res.status(404).json({
                error: 'Line not found',
                message: `Line ${lineNumber} not found in Production Order ${documentNumber}`,
                lineNumber: lineNumber
            });
        }
        
        console.log(`   Current line item: ${targetLine.ItemNo}`);
        console.log(`   Issued Quantity: ${targetLine.IssuedQuantity || 0}`);
        
        // Check if material has already been issued
        if (targetLine.IssuedQuantity && targetLine.IssuedQuantity > 0) {
            return res.status(400).json({
                error: 'Cannot update line',
                message: `Cannot change item code - ${targetLine.IssuedQuantity} units already issued for this line`,
                issuedQuantity: targetLine.IssuedQuantity
            });
        }
        
        // Prepare the PATCH payload to update the line's item code
        // SAP requires sending the full ProductionOrderLines array with the updated line
        const updatedLines = poData.ProductionOrderLines.map(line => {
            if (line.LineNumber === lineNumber) {
                return {
                    LineNumber: line.LineNumber,
                    ItemNo: newItemCode,
                    BaseQuantity: line.BaseQuantity,
                    PlannedQuantity: line.PlannedQuantity,
                    Warehouse: line.Warehouse,
                    ItemType: line.ItemType
                };
            }
            return {
                LineNumber: line.LineNumber,
                ItemNo: line.ItemNo,
                BaseQuantity: line.BaseQuantity,
                PlannedQuantity: line.PlannedQuantity,
                Warehouse: line.Warehouse,
                ItemType: line.ItemType
            };
        });
        
        const patchPayload = {
            ProductionOrderLines: updatedLines
        };
        
        console.log(`   Sending PATCH to update line ${lineNumber} item to ${newItemCode}...`);
        
        try {
            await sapPatchRequest(`/ProductionOrders(${absoluteEntry})`, patchPayload);
            console.log(`   ✅ Production Order line updated successfully!`);
            console.log('========================================');
            
            return res.json({
                success: true,
                message: `Successfully updated line ${lineNumber} from ${originalItemCode} to ${newItemCode}`,
                absoluteEntry: absoluteEntry,
                documentNumber: documentNumber,
                lineNumber: lineNumber,
                originalItemCode: originalItemCode,
                newItemCode: newItemCode,
                newItemName: itemData.ItemName
            });
        } catch (patchErr) {
            const errMsg = patchErr.response?.data?.error?.message?.value || patchErr.message;
            console.log(`   ❌ PATCH failed: ${errMsg}`);
            console.log('========================================');
            
            return res.status(500).json({
                error: 'Failed to update production order line',
                message: errMsg,
                details: patchErr.response?.data || null
            });
        }
        
    } catch (error) {
        console.error('❌ Error updating production order line:', error.message);
        if (error.response?.data) {
            console.error('   SAP Error:', JSON.stringify(error.response.data, null, 2));
        }
        console.log('========================================');
        
        res.status(500).json({
            error: 'Failed to update production order line',
            message: error.message,
            details: error.response?.data || null
        });
    }
});

/**
 * Length / width / grade from BatchNumberDetails (Service Layer).
 * OBTN SQL may omit UDF columns or fall back to DistNumber+Quantity only.
 */
async function fetchBatchDimensionsMapFromOData(itemCode) {
    const map = new Map();
    const code = String(itemCode || '').trim();
    if (!code) return map;
    try {
        const endpoint = `/BatchNumberDetails?$filter=ItemCode eq '${encodeURIComponent(code)}'&$select=Batch,U_Length,U_Width,U_GRADE`;
        const result = await sapGetRequest(endpoint);
        const pickNum = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };
        for (const row of result?.value || []) {
            const batch = row.Batch ?? row.batch ?? row.DistNumber ?? row.distNumber;
            if (batch == null || String(batch).trim() === '') continue;
            map.set(String(batch).trim(), {
                length: pickNum(row.U_Length ?? row.u_length ?? row.U_LENGTH),
                width: pickNum(row.U_Width ?? row.u_width ?? row.U_WIDTH),
                grade: row.U_GRADE ?? row.u_grade ?? row.U_Grade ?? null
            });
        }
    } catch (err) {
        console.warn(`   BatchNumberDetails dimension lookup failed for ${code}:`, err.message);
    }
    return map;
}

function normSapSqlRowKey(r, candidates) {
    if (!r || typeof r !== 'object') return undefined;
    for (const k of candidates) {
        if (Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined && r[k] !== null) {
            return r[k];
        }
    }
    const lower = {};
    for (const [k, v] of Object.entries(r)) {
        lower[String(k).toLowerCase()] = v;
    }
    for (const k of candidates) {
        const lk = String(k).toLowerCase();
        if (lower[lk] !== undefined && lower[lk] !== null) return lower[lk];
    }
    return undefined;
}

function numOrZeroSap(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * GET /api/rmc-batches/:itemCode
 * Fetch all batches for an item with details (Grade, Length, Width, Available) in one warehouse.
 * Pass ?warehouse=WHSCODE from the Production Order line (recommended). Defaults to II-FOI if omitted.
 * Uses runSapSqlQuery (same helper as other SAP SQL) — faster than create+list+blocking DELETE per request.
 */
app.get('/api/rmc-batches/:itemCode', async (req, res) => {
    try {
        const itemCode = decodeURIComponent((req.params.itemCode || '').toString().trim());
        const whRaw = (req.query.warehouse || '').toString().trim();
        const warehouse = whRaw || UNIT1_DEFAULT_ISSUE_WAREHOUSE;

        if (!itemCode) {
            return res.status(400).json({
                error: 'Missing item code',
                message: 'itemCode parameter is required'
            });
        }

        const k = itemCode.replace(/'/g, "''");
        const w = warehouse.replace(/'/g, "''");

        console.log(`📦 FETCH BATCHES item=${itemCode} warehouse=${warehouse}`);

        const sqlJoin = `FROM OBTN T0 INNER JOIN OBTQ T1 ON T0."AbsEntry" = T1."MdAbsEntry" WHERE T1."ItemCode" = '${k}' AND T1."WhsCode" = '${w}' AND T1."Quantity" > 0 ORDER BY T1."Quantity" DESC`;
        const sqlDims = `SELECT T0."DistNumber", T0."U_Length", T0."U_Width", T1."Quantity" ${sqlJoin}`;
        const sqlFull = `SELECT T0."DistNumber", T0."U_GRADE", T0."U_Length", T0."U_Width", T1."Quantity" ${sqlJoin}`;
        const sqlSimple = `SELECT T0."DistNumber", T1."Quantity" ${sqlJoin}`;

        let rows = [];
        let sqlLabelUsed = '';
        for (const attempt of [
            { sql: sqlDims, label: 'OBTN_batches_dims' },
            { sql: sqlFull, label: 'OBTN_batches_full' },
            { sql: sqlSimple, label: 'OBTN_batches_fb' }
        ]) {
            try {
                const result = await runSapSqlQuery(attempt.sql, attempt.label);
                if (Array.isArray(result) && result.length > 0) {
                    rows = result;
                    sqlLabelUsed = attempt.label;
                    break;
                }
            } catch (err) {
                const msg = err?.response?.data?.error?.message?.value || err.message || '';
                console.warn(`   Batch SQL (${attempt.label}) failed: ${msg}`);
            }
        }

        const batches = (rows || []).map(row => {
            const dist = normSapSqlRowKey(row, ['DistNumber', 'distNumber', 'DISTNUMBER', 'Distnumber']);
            const qty = normSapSqlRowKey(row, ['Quantity', 'quantity', 'QUANTITY']);
            const grade = normSapSqlRowKey(row, ['U_GRADE', 'u_grade', 'U_Grade', 'UGRADE']);
            const len = normSapSqlRowKey(row, ['U_Length', 'u_length', 'U_LENGTH', 'Length', 'length']);
            const wid = normSapSqlRowKey(row, ['U_Width', 'u_width', 'U_WIDTH', 'Width', 'width']);
            return {
                batchNumber: dist != null ? String(dist) : '',
                grade: grade != null && String(grade).trim() !== '' ? String(grade) : 'N/A',
                length: numOrZeroSap(len),
                width: numOrZeroSap(wid),
                available: numOrZeroSap(qty)
            };
        });

        const needsDimEnrich = batches.some(b => b.batchNumber && b.available > 0 && (!b.length || !b.width));
        if (needsDimEnrich) {
            console.log(`   ⚠️ Missing length/width from SQL (${sqlLabelUsed || 'none'}) — enriching from BatchNumberDetails`);
            const dimMap = await fetchBatchDimensionsMapFromOData(itemCode);
            let enrichedCount = 0;
            for (const b of batches) {
                const d = dimMap.get(b.batchNumber);
                if (!d) continue;
                if (!b.length && d.length) {
                    b.length = d.length;
                    enrichedCount++;
                }
                if (!b.width && d.width) {
                    b.width = d.width;
                    enrichedCount++;
                }
                if ((!b.grade || b.grade === 'N/A') && d.grade) {
                    b.grade = String(d.grade);
                }
            }
            console.log(`   → Enriched ${enrichedCount} dimension field(s) from ${dimMap.size} BatchNumberDetails record(s)`);
        }

        const totalAvailable = batches.reduce((sum, b) => sum + (b.available || 0), 0);
        if (batches.length > 0) {
            const s = batches[0];
            console.log(`   → ${batches.length} batch(es), total qty ${totalAvailable}; sample ${s.batchNumber}: L=${s.length} W=${s.width}`);
        } else {
            console.log(`   → 0 batch(es) in ${warehouse}`);
        }

        return res.json({
            success: true,
            itemCode,
            warehouse,
            batches,
            totalBatches: batches.length,
            totalAvailable
        });
    } catch (error) {
        console.error('Error fetching RMC batches:', error);
        res.status(500).json({
            error: 'Failed to fetch RMC batches',
            message: error.message,
            details: error.response?.data || null
        });
    }
});

/**
 * POST /api/release-production-order
 * Release a Production Order so materials can be issued (status -> Released)
 * Body: { absoluteEntry, documentNumber }
 */
app.post('/api/release-production-order', async (req, res) => {
    try {
        const absoluteEntry = Number(req.body?.absoluteEntry);
        const documentNumber = req.body?.documentNumber;

        if (!Number.isFinite(absoluteEntry) || absoluteEntry <= 0) {
            return res.status(400).json({ success: false, error: 'Missing/invalid absoluteEntry' });
        }

        const result = await releaseProductionOrder(absoluteEntry, documentNumber || String(absoluteEntry));
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error || 'Failed to release Production Order', details: result.details || null });
        }

        return res.json({ success: true, alreadyReleased: !!result.alreadyReleased });
    } catch (error) {
        console.error('Error releasing Production Order:', error);
        return res.status(500).json({ success: false, error: 'Failed to release Production Order', message: error.message });
    }
});

/**
 * GET /api/traceability/by-po/:poNum
 * PO summary: all input batches used + all output batches produced (report completion).
 */
app.get('/api/traceability/by-po/:poNum', async (req, res) => {
    try {
        const poNum = String(req.params.poNum || '').trim();
        if (!poNum) {
            return res.status(400).json({ success: false, message: 'PO number is required' });
        }
        let fgItemCode = null;
        let processTag = null;
        try {
            const backfill = await ensurePOInputsBackfillFromSAP(poNum);
            fgItemCode = backfill.fgItemCode || null;
            processTag = backfill.processTag || null;
        } catch (bfErr) {
            console.warn(`Traceability SAP input backfill skipped for PO ${poNum}:`, bfErr.message);
        }
        const summary = await getPOTraceabilitySummary(poNum, { fgItemCode, processTag });
        return res.json({ success: true, mode: 'po', ...summary });
    } catch (error) {
        console.error('Traceability by-PO error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/traceability/batch-owner/:batchNum
 * Which PO produced this output batch (for batch trace PO field).
 */
app.get('/api/traceability/batch-owner/:batchNum', async (req, res) => {
    try {
        const batchNum = String(req.params.batchNum || '').trim();
        const poHint = String(req.query.po || req.query.po_num || '').trim() || null;
        if (!batchNum) {
            return res.status(400).json({ success: false, message: 'Batch number is required' });
        }
        const owner = await getOutputBatchOwnerPO(batchNum, poHint);
        if (!owner?.poNum) {
            return res.status(404).json({
                success: false,
                message: poHint
                    ? `No output batch ${batchNum} found for PO ${poHint}`
                    : `No output batch found: ${batchNum}`
            });
        }
        return res.json({
            success: true,
            batchNum,
            ownerPo: owner.poNum,
            processName: owner.processName
        });
    } catch (error) {
        console.error('Traceability batch-owner error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/traceability/by-batch/:batchNum?po=753
 * Reverse trace one output batch → inputs selected at report completion.
 * PO is required — batch numbers may repeat across different POs.
 */
app.get('/api/traceability/by-batch/:batchNum', async (req, res) => {
    try {
        const batchNum = String(req.params.batchNum || '').trim();
        const poNum = String(req.query.po || req.query.po_num || '').trim();
        if (!batchNum) {
            return res.status(400).json({ success: false, message: 'Batch number is required' });
        }
        if (!poNum) {
            return res.status(400).json({
                success: false,
                message: 'Please enter PO — batch trace requires PO number and batch number together.'
            });
        }
        const owner = await getOutputBatchOwnerPO(batchNum, poNum);
        if (!owner?.poNum) {
            return res.status(404).json({
                success: false,
                message: `No output batch found: ${batchNum} for PO ${poNum}`
            });
        }
        if (owner.poNum !== poNum) {
            const procHint = owner.processName ? ` (${owner.processName})` : '';
            return res.status(404).json({
                success: false,
                message: `This batch belongs to PO ${owner.poNum}${procHint}, not PO ${poNum}. Use PO ${owner.poNum} to trace ${batchNum}.`,
                ownerPo: owner.poNum,
                processName: owner.processName,
                batchNum
            });
        }
        await backfillRoleBatchUsageOperators(poNum);
        const inputs = await getGenealogyByOutputBatch(batchNum, poNum);
        let outputQty = null;
        let itemCode = null;
        let completionOperator = null;
        let completionMachine = null;
        try {
            const [prodRows] = await pool.query(
                `SELECT quantity_processed, fg_num, operator_name, machine_name
                   FROM production_records
                  WHERE batch_num = ? AND po_num = ?
                  ORDER BY job_end_time DESC NULLS LAST
                  LIMIT 1`,
                [batchNum, poNum]
            );
            if (prodRows[0]) {
                outputQty = Number(prodRows[0].quantity_processed) || null;
                itemCode = prodRows[0].fg_num;
                completionOperator = prodRows[0].operator_name || null;
                completionMachine = prodRows[0].machine_name || null;
            }
        } catch (_) { /* non-blocking */ }
        const totalInputQty = inputs.reduce((s, r) => s + (Number(r.quantity) || 0), 0);

        let inputMeta = new Map();
        if (poNum) {
            let fgItemCode = itemCode || null;
            let processTag = null;
            try {
                const backfill = await ensurePOInputsBackfillFromSAP(poNum);
                fgItemCode = backfill.fgItemCode || fgItemCode;
                processTag = backfill.processTag || null;
            } catch (_) { /* non-blocking */ }
            const summary = await getPOTraceabilitySummary(poNum, { fgItemCode, processTag });
            inputMeta = new Map((summary.inputBatches || []).map((b) => [b.batchNumber, b]));
        }

        return res.json({
            success: true,
            mode: 'batch',
            outputBatch: batchNum,
            poNum,
            outputQty,
            itemCode,
            completionOperator,
            completionMachine,
            count: inputs.length,
            totalInputQty,
            inputs: inputs.map((r) => {
                const meta = inputMeta.get(r.batch_number) || {};
                return {
                    itemCode: r.item_code,
                    batchNumber: r.batch_number,
                    quantity: r.quantity,
                    issuedQty: meta.issuedQty != null ? meta.issuedQty : null,
                    remainingQty: meta.remainingQty != null ? meta.remainingQty : null,
                    sourcePoNum: meta.sourcePoNum || null,
                    inputType: r.input_type || 'raw_roll',
                    warehouse: r.warehouse,
                    operator: r.operator_name || completionOperator,
                    machine: r.machine_name || completionMachine,
                    usedAt: r.used_at
                };
            })
        });
    } catch (error) {
        console.error('Traceability by-batch error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/process-label/by-po/:poNum?batch=…&list=1
 * Build process output label from saved DB data (post-submit / reprint).
 */
app.get('/api/process-label/by-po/:poNum', async (req, res) => {
    try {
        const poNum = String(req.params.poNum || '').trim();
        if (!poNum) {
            return res.status(400).json({ success: false, message: 'PO number is required' });
        }
        if (String(req.query.list || '') === '1') {
            const batches = await listOutputBatchesForPO(poNum);
            return res.json({ success: true, poNum, batches });
        }
        const batch = String(req.query.batch || req.query.batch_num || '').trim() || null;
        await backfillRoleBatchUsageOperators(poNum);
        const raw = await getProcessLabelDataFromDB(poNum, batch);
        if (!raw) {
            return res.status(404).json({
                success: false,
                message: batch
                    ? `No saved output batch ${batch} for PO ${poNum}`
                    : `No saved production batch for PO ${poNum}`
            });
        }
        return res.json({ success: true, poNum, labelData: raw });
    } catch (error) {
        console.error('Process label lookup error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/traceability/:po
 * Legacy — prefer /api/traceability/by-po/:poNum or /api/traceability/by-batch/:batchNum
 */
app.get('/api/traceability/:po', async (req, res) => {
    try {
        const poNum = req.params.po;
        const outputBatch = (req.query.batch || '').toString().trim();
        const noAuto = String(req.query.noAuto || '') === '1';

        let rows = outputBatch
            ? await getGenealogyByOutputBatch(outputBatch)
            : await getGenealogyByPO(poNum);

        // Group consumed inputs under their output batch (from report completion only)
        const groups = {};
        for (const r of rows) {
            const key = r.output_batch || outputBatch || '__pending__';
            if (!groups[key]) {
                groups[key] = { outputBatch: r.output_batch || outputBatch || null, inputs: [], totalQty: 0 };
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

        return res.json({
            success: true,
            poNum,
            outputBatch: outputBatch || null,
            count: rows.length,
            genealogy: Object.values(groups)
        });
    } catch (error) {
        console.error('Traceability fetch error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/traceability/backfill/:po
 * Re-build traceability for an already-finished PO by reading its goods issues
 * from SAP and linking consumed rolls to the output batch(es) in local records.
 */
app.post('/api/traceability/backfill/:po', async (req, res) => {
    try {
        const poNum = req.params.po;
        const ensured = await ensureTraceabilityForPO(poNum);
        if (ensured.notFound) {
            return res.status(404).json({ success: false, message: `PO ${poNum} not found in SAP` });
        }
        if (!ensured.outputBatches.length) {
            return res.status(404).json({ success: false, message: `No produced output batch found locally for PO ${poNum}` });
        }
        return res.json({
            success: true,
            poNum,
            absoluteEntry: ensured.absoluteEntry,
            outputBatches: ensured.outputBatches,
            recorded: ensured.recorded
        });
    } catch (error) {
        console.error('Traceability backfill error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/auto-issue-material
 * FIFO auto-issue one BOM line to the current PO (Unit 1 subsequent processes).
 * No batch popup — oldest batches first from the line warehouse.
 */
app.post('/api/auto-issue-material', async (req, res) => {
    try {
        const {
            absoluteEntry,
            documentNumber,
            itemCode,
            lineNumber,
            warehouse,
            quantity
        } = req.body || {};

        const absEntry = Number(absoluteEntry);
        const qtyNeeded = Number(quantity);
        const code = String(itemCode || '').trim();
        const wh = String(warehouse || '').trim() || UNIT1_DEFAULT_ISSUE_WAREHOUSE;

        if (!Number.isFinite(absEntry) || absEntry <= 0 || !code || !Number.isFinite(qtyNeeded) || qtyNeeded <= 0) {
            return res.status(400).json({
                success: false,
                error: 'absoluteEntry, itemCode, and positive quantity are required'
            });
        }

        console.log(`\n🔄 ========== AUTO-ISSUE MATERIAL ==========`);
        console.log(`   PO: ${documentNumber || absEntry} | Item: ${code} | Qty: ${qtyNeeded} | WH: ${wh}`);

        const releaseResult = await releaseProductionOrder(absEntry, documentNumber);
        if (!releaseResult.success) {
            return res.status(400).json({
                success: false,
                error: `Failed to release PO: ${releaseResult.error}`
            });
        }

        const { allocations, shortfall } = await allocateFifoBatchesFromWarehouse(code, wh, qtyNeeded);
        if (!allocations.length) {
            return res.json({
                success: false,
                issued: 0,
                shortfall: qtyNeeded,
                message: `No stock in ${wh} for ${code}`
            });
        }

        let resolvedLineNumber = lineNumber;
        if (resolvedLineNumber === undefined || resolvedLineNumber === null) {
            const poData = await sapGetRequest(`/ProductionOrders(${absEntry})?$select=ProductionOrderLines`);
            const matchLine = (poData?.ProductionOrderLines || []).find(
                (l) => String(l.ItemNo || '').trim() === code
            );
            if (matchLine) resolvedLineNumber = matchLine.LineNumber;
        }

        const issuedQty = allocations.reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);
        const currentDate = getSAPPostingDate();
        const linkedPayload = {
            DocDate: currentDate,
            BPLID: SAP_BPL_ID,
            BPL_IDAssignedToInvoice: SAP_BPL_ID,
            Comments: `Auto-issue FIFO via Data Entry (PO ${documentNumber || absEntry})`,
            DocumentLines: [{
                BaseType: 202,
                BaseEntry: absEntry,
                BaseLine: resolvedLineNumber ?? 0,
                Quantity: issuedQty,
                WarehouseCode: wh,
                TransactionType: 'botrntIssue',
                BatchNumbers: allocations.map((a) => ({
                    BatchNumber: a.batchNumber,
                    Quantity: a.quantity
                }))
            }]
        };

        const issueResult = await sapPostRequest('/InventoryGenExits', linkedPayload);
        console.log(`   ✅ Auto-issued ${issuedQty} (${allocations.length} batch(es)), shortfall ${shortfall}`);

        await recordAutoIssueAllocationsToPO({
            poNum: documentNumber || absEntry,
            absoluteEntry: absEntry,
            lineNumber: resolvedLineNumber,
            itemCode: code,
            warehouse: wh,
            allocations,
            sapDocEntry: issueResult?.DocEntry,
            remarks: `Auto-issue FIFO via Data Entry (PO ${documentNumber || absEntry})`
        });

        res.json({
            success: true,
            issued: issuedQty,
            shortfall,
            partial: shortfall > 1e-6,
            batchAllocations: allocations,
            docEntry: issueResult?.DocEntry,
            warehouse: wh
        });
    } catch (error) {
        console.error('❌ Auto-issue material failed:', error.message);
        res.status(500).json({
            success: false,
            error: extractSapErrorMessage(error),
            message: error.message
        });
    }
});

/**
 * POST /api/issue-rmc-batches
 * Issue RMC material from user-selected batches
 * Allows user to specify exact quantities from specific batches
 */
app.post('/api/issue-rmc-batches', async (req, res) => {
    try {
        const { absoluteEntry, documentNumber, itemCode, lineNumber, batchAllocations, remarks, itemCodeChanged, originalItemCode, targetWarehouse, warehouse, operatorName, machineName } = req.body;
        
        console.log(`📤 ========== RMC BATCH ISSUE ==========`);
        console.log(`   PO AbsoluteEntry: ${absoluteEntry}`);
        console.log(`   PO DocumentNumber: ${documentNumber}`);
        console.log(`   Item: ${itemCode}`);
        console.log(`   Line Number: ${lineNumber}`);
        console.log(`   Batch Allocations:`, batchAllocations);
        console.log(`   Item Code Changed: ${itemCodeChanged}`);
        
        if (!absoluteEntry || !itemCode || !batchAllocations || batchAllocations.length === 0) {
            return res.status(400).json({
                error: 'Missing required fields',
                message: 'absoluteEntry, itemCode, and batchAllocations are required'
            });
        }
        
        // Calculate total quantity from allocations
        const totalQuantity = batchAllocations.reduce((sum, b) => sum + (b.quantity || 0), 0);
        console.log(`   Total Quantity: ${totalQuantity}`);
        
        if (totalQuantity <= 0) {
            return res.status(400).json({
                error: 'Invalid quantity',
                message: 'Total quantity must be greater than 0'
            });
        }
        
        const targetWhs = targetWarehouse || warehouse || UNIT1_DEFAULT_ISSUE_WAREHOUSE;
        const poReference = documentNumber || absoluteEntry;
        const currentDate = getSAPPostingDate();
        
        // Track if we successfully updated the PO line
        // (in 2-step mode: PATCH must succeed before issuing)
        let poLineUpdated = false;
        
        // If item code was changed, first update the production order line (STEP 1)
        if (itemCodeChanged === true && lineNumber !== undefined && originalItemCode) {
            console.log(`   📝 Updating Production Order line ${lineNumber} with new item code...`);
            
            try {
                const poEndpoint = `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,DocumentNumber,ProductionOrderStatus,ProductionOrderLines`;
                const poData = await sapGetRequest(poEndpoint);
                
                if (poData && poData.ProductionOrderLines) {
                    const targetLine = poData.ProductionOrderLines.find(line => line.LineNumber === lineNumber);
                    
                    if (targetLine) {
                        if (targetLine.IssuedQuantity && targetLine.IssuedQuantity > 0) {
                            console.log(`   ⚠️ Line ${lineNumber} already has ${targetLine.IssuedQuantity} issued - cannot update item code`);
                        } else {
                            const updatedLines = poData.ProductionOrderLines.map(line => {
                                if (line.LineNumber === lineNumber) {
                                    return {
                                        LineNumber: line.LineNumber,
                                        ItemNo: itemCode,
                                        BaseQuantity: line.BaseQuantity,
                                        PlannedQuantity: line.PlannedQuantity,
                                        Warehouse: line.Warehouse,
                                        ItemType: line.ItemType
                                    };
                                }
                                return {
                                    LineNumber: line.LineNumber,
                                    ItemNo: line.ItemNo,
                                    BaseQuantity: line.BaseQuantity,
                                    PlannedQuantity: line.PlannedQuantity,
                                    Warehouse: line.Warehouse,
                                    ItemType: line.ItemType
                                };
                            });
                            
                            const patchPayload = { ProductionOrderLines: updatedLines };
                            await sapPatchRequest(`/ProductionOrders(${absoluteEntry})`, patchPayload);
                            console.log(`   ✅ Production Order line ${lineNumber} updated: ${originalItemCode} → ${itemCode}`);
                            poLineUpdated = true;
                        }
                    } else {
                        console.log(`   ⚠️ Line ${lineNumber} not found in Production Order`);
                    }
                }
            } catch (updateErr) {
                const errMsg = updateErr.response?.data?.error?.message?.value || updateErr.message;
                console.log(`   ⚠️ Failed to update PO line: ${errMsg}`);
            }
        }
        
        // 2-step requirement for code-change:
        // STEP 1 must succeed (PATCH), then STEP 2 issues material "normally" (standalone Goods Issue).
        const isTwoStepCodeChange = itemCodeChanged === true;

        if (isTwoStepCodeChange) {
            if (!poLineUpdated) {
                return res.status(400).json({
                    error: 'Failed to update production order line item code',
                    message: 'Item code change was requested but SAP line update did not succeed. Material issue not attempted.',
                    documentNumber,
                    absoluteEntry,
                    lineNumber,
                    originalItemCode,
                    newItemCode: itemCode
                });
            }
            console.log(`   ✅ STEP 1 complete (PO line updated). Proceeding to STEP 2: standalone issue.`);
        } else {
            console.log(`   Issue Mode: LINKED TO PO`);
        }

        // Match /api/issue-material: after optional line PATCH, prefer linked issue so IssuedQuantity updates on the PO.
        let useStandaloneIssue = false;
        let tryLinkedFirst = false;
        if (itemCodeChanged === true) {
            tryLinkedFirst = poLineUpdated === true;
            useStandaloneIssue = poLineUpdated !== true;
        }
        
        // Format batch allocations for SAP
        const batchNumbers = batchAllocations.map(b => ({
            BatchNumber: b.batchNumber,
            Quantity: b.quantity
        }));

        // Resolve lineNumber from PO if client didn't send it
        let resolvedLineNumber = lineNumber;
        if (resolvedLineNumber === undefined || resolvedLineNumber === null) {
            try {
                const poEndpoint = `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,ProductionOrderLines`;
                const poData = await sapGetRequest(poEndpoint);
                const matchLine = (poData?.ProductionOrderLines || []).find(
                    l => (l.ItemNo || '').toString().trim() === (itemCode || '').toString().trim()
                );
                if (matchLine) {
                    resolvedLineNumber = matchLine.LineNumber;
                    console.log(`   🔎 Resolved BaseLine from SAP: ${resolvedLineNumber} (ItemNo=${itemCode})`);
                } else {
                    console.warn(`   ⚠️ Could not resolve BaseLine for ${itemCode} on PO ${absoluteEntry}`);
                }
            } catch (resolveErr) {
                console.warn(`   ⚠️ Failed to resolve BaseLine: ${resolveErr.message}`);
            }
        }
        
        // Build linked payload
        const linkedPayload = {
            DocDate: currentDate,
            BPLID: SAP_BPL_ID,
            BPL_IDAssignedToInvoice: SAP_BPL_ID,
            Comments: remarks || `RMC material issued via Data Entry WebApp (PO: ${poReference})`,
            DocumentLines: [{
                BaseType: 202,
                BaseEntry: absoluteEntry,
                BaseLine: resolvedLineNumber !== undefined && resolvedLineNumber !== null ? resolvedLineNumber : 0,
                Quantity: totalQuantity,
                WarehouseCode: targetWhs,
                TransactionType: 'botrntIssue',
                BatchNumbers: batchNumbers
            }]
        };
        
        // Build standalone payload
        const standalonePayload = {
            DocDate: currentDate,
            BPLID: SAP_BPL_ID,
            BPL_IDAssignedToInvoice: SAP_BPL_ID,
            Comments: remarks || `RMC material issued via Data Entry WebApp (PO: ${poReference}, item changed)`,
            DocumentLines: [{
                ItemCode: itemCode,
                Quantity: totalQuantity,
                WarehouseCode: targetWhs,
                BatchNumbers: batchNumbers
            }]
        };
        
        let issuePayload;
        let issueSucceeded = false;
        let issueResult = null;
        
        if (tryLinkedFirst) {
            // Try linked issue first (PO line was updated, want IssuedQuantity to update)
            console.log(`   Trying LINKED issue first (to update IssuedQuantity on PO line)...`);
            try {
                issueResult = await sapPostRequest('/InventoryGenExits', linkedPayload);
                console.log(`   ✅ Linked issue succeeded! DocEntry: ${issueResult?.DocEntry}`);
                console.log(`   ✅ IssuedQuantity should now be updated on PO line ${lineNumber}`);
                issueSucceeded = true;
            } catch (linkedErr) {
                const errMsg = linkedErr.response?.data?.error?.message?.value || linkedErr.message;
                console.log(`   ⚠️ Linked issue failed: ${errMsg}`);
                console.log(`   Falling back to STANDALONE issue...`);
                
                // Fallback to standalone
                try {
                    issueResult = await sapPostRequest('/InventoryGenExits', standalonePayload);
                    console.log(`   ✅ Standalone issue succeeded! DocEntry: ${issueResult?.DocEntry}`);
                    console.log(`   ⚠️ Note: IssuedQuantity on PO line will NOT be updated (standalone issue)`);
                    issueSucceeded = true;
                } catch (standaloneErr) {
                    const standaloneErrMsg = standaloneErr.response?.data?.error?.message?.value || standaloneErr.message;
                    console.log(`   ❌ Standalone issue also failed: ${standaloneErrMsg}`);
                    console.log('==========================================');
                    
                    return res.status(400).json({
                        error: 'Failed to issue RMC material',
                        message: standaloneErrMsg,
                        itemCode: itemCode,
                        batchAllocations: batchAllocations
                    });
                }
            }
        } else if (useStandaloneIssue) {
            issuePayload = standalonePayload;
        } else {
            issuePayload = linkedPayload;
        }
        
        // Execute if not already handled by tryLinkedFirst
        if (!issueSucceeded && issuePayload) {
            try {
                console.log(`   Sending batch issue request...`);
                issueResult = await sapPostRequest('/InventoryGenExits', issuePayload);
                console.log(`   ✅ Batch issue succeeded! DocEntry: ${issueResult?.DocEntry}`);
                issueSucceeded = true;
            } catch (issueErr) {
                const errMsg = issueErr.response?.data?.error?.message?.value || issueErr.message;
                console.log(`   ❌ Batch issue failed: ${errMsg}`);
                console.log('==========================================');
                
                return res.status(400).json({
                    error: 'Failed to issue RMC material',
                    message: errMsg,
                    itemCode: itemCode,
                    batchAllocations: batchAllocations
                });
            }
        }
        
        if (issueSucceeded) {
            console.log('==========================================');

            // Traceability: record each issued roll/batch against this PO (non-blocking)
            await recordMaterialIssues(
                {
                    po_num: documentNumber || absoluteEntry,
                    absolute_entry: absoluteEntry,
                    line_number: lineNumber,
                    item_code: itemCode,
                    warehouse: targetWhs,
                    operator_name: operatorName || null,
                    machine_name: machineName || null,
                    sap_doc_entry: issueResult?.DocEntry,
                    remarks: remarks || null
                },
                batchAllocations
            );

            return res.json({
                success: true,
                message: 'RMC material issued successfully',
                docEntry: issueResult?.DocEntry,
                itemCode: itemCode,
                totalQuantity: totalQuantity,
                batchesUsed: batchAllocations.map(b => ({ batch: b.batchNumber, quantity: b.quantity })),
                poLineUpdated: poLineUpdated
            });
        }
        
    } catch (error) {
        console.error('Error in RMC batch issue:', error);
        res.status(500).json({
            error: 'Failed to issue RMC material',
            message: error.message,
            details: error.response?.data || null
        });
    }
});

/**
 * POST /api/issue-material
 * Issue PMT/RMC material to a Production Order
 * PMT materials → II-PST warehouse (for PST jobs)
 * RMC materials → II-FOI warehouse (for FOI jobs)
 * Uses dynamic SQL query to find batches with stock in target warehouse
 */
app.post('/api/issue-material', async (req, res) => {
    try {
        const { absoluteEntry, documentNumber, itemCode, quantity, warehouse, lineNumber, remarks, itemCodeChanged, originalItemCode, operatorName, machineName } = req.body;
        
        // Determine material type and target warehouse
        const isPMT = itemCode && itemCode.toUpperCase().startsWith('PMT');
        const isRMC = itemCode && itemCode.toUpperCase().startsWith('RMC');
        const materialType = isPMT ? 'PMT' : (isRMC ? 'RMC' : 'OTHER');
        
        // Use document number for comments (for tracking), fall back to absoluteEntry if not provided
        const poReference = documentNumber || absoluteEntry;
        
        // Set target warehouse based on material type
        let targetWarehouse;
        if (isPMT) {
            targetWarehouse = warehouse || UNIT1_DEFAULT_ISSUE_WAREHOUSE;
        } else if (isRMC) {
            targetWarehouse = warehouse || UNIT1_DEFAULT_ISSUE_WAREHOUSE;
        } else {
            targetWarehouse = warehouse || UNIT1_DEFAULT_ISSUE_WAREHOUSE;
        }
        
        // Track if we successfully updated the PO line (for linked issue)
        let poLineUpdated = false;
        // Resolve correct BaseLine from SAP (may differ from UI-provided lineNumber)
        let resolvedBaseLine = (lineNumber !== undefined ? lineNumber : 0);

        const resolveBaseLineFromSAP = async (why) => {
            try {
                const poEndpoint = `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,DocumentNumber,ProductionOrderStatus,ProductionOrderLines`;
                const poData = await sapGetRequest(poEndpoint);
                const lines = poData?.ProductionOrderLines || [];
                if (!Array.isArray(lines) || lines.length === 0) return null;

                // Prefer exact match on item + target warehouse (when available)
                const exact = lines.find(l =>
                    (l?.ItemNo === itemCode) &&
                    (targetWarehouse ? (l?.Warehouse === targetWarehouse) : true)
                );
                const byItem = exact || lines.find(l => l?.ItemNo === itemCode);

                if (byItem && Number.isFinite(byItem.LineNumber)) {
                    console.log(`   🔎 Resolved BaseLine from SAP (${why}): ${byItem.LineNumber} (ItemNo=${byItem.ItemNo}${byItem.Warehouse ? `, Whs=${byItem.Warehouse}` : ''})`);
                    return byItem.LineNumber;
                }

                // If we still can't find, keep existing resolvedBaseLine
                console.log(`   ⚠️ Could not resolve BaseLine from SAP (${why}) for ItemNo=${itemCode}. Keeping BaseLine=${resolvedBaseLine}`);
                return null;
            } catch (e) {
                const msg = e?.response?.data?.error?.message?.value || e?.message;
                console.log(`   ⚠️ BaseLine resolve failed (${why}): ${msg}`);
                return null;
            }
        };
        
        console.log(`📤 ========== ${materialType} MATERIAL ISSUE ==========`);
        console.log(`   PO AbsoluteEntry: ${absoluteEntry}`);
        console.log(`   PO DocumentNumber: ${documentNumber}`);
        console.log(`   Item: ${itemCode}`);
        console.log(`   Material Type: ${materialType}`);
        console.log(`   Quantity: ${quantity}`);
        console.log(`   Requested Warehouse: ${warehouse}`);
        console.log(`   Target Warehouse: ${targetWarehouse} (forced for ${materialType} materials)`);
        console.log(`   Line Number: ${lineNumber}`);
        console.log(`   Item Code Changed: ${itemCodeChanged}`);
        if (itemCodeChanged) {
            console.log(`   Original Item Code: ${originalItemCode}`);
        }
        
        // If item code was changed, first update the production order line
        if (itemCodeChanged === true && lineNumber !== undefined && originalItemCode) {
            console.log(`   📝 Updating Production Order line ${lineNumber} with new item code...`);
            
            try {
                // Get current production order
                const poEndpoint = `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,DocumentNumber,ProductionOrderStatus,ProductionOrderLines`;
                const poData = await sapGetRequest(poEndpoint);
                
                if (poData && poData.ProductionOrderLines) {
                    // Find the target line
                    const targetLine = poData.ProductionOrderLines.find(line => line.LineNumber === lineNumber);
                    
                    if (targetLine) {
                        // Check if material has already been issued
                        if (targetLine.IssuedQuantity && targetLine.IssuedQuantity > 0) {
                            console.log(`   ⚠️ Line ${lineNumber} already has ${targetLine.IssuedQuantity} issued - cannot update item code`);
                        } else {
                            // Prepare the PATCH payload to update the line's item code
                            const updatedLines = poData.ProductionOrderLines.map(line => {
                                if (line.LineNumber === lineNumber) {
                                    return {
                                        LineNumber: line.LineNumber,
                                        ItemNo: itemCode,
                                        BaseQuantity: line.BaseQuantity,
                                        PlannedQuantity: line.PlannedQuantity,
                                        Warehouse: line.Warehouse,
                                        ItemType: line.ItemType
                                    };
                                }
                                return {
                                    LineNumber: line.LineNumber,
                                    ItemNo: line.ItemNo,
                                    BaseQuantity: line.BaseQuantity,
                                    PlannedQuantity: line.PlannedQuantity,
                                    Warehouse: line.Warehouse,
                                    ItemType: line.ItemType
                                };
                            });
                            
                            const patchPayload = {
                                ProductionOrderLines: updatedLines
                            };
                            
                            await sapPatchRequest(`/ProductionOrders(${absoluteEntry})`, patchPayload);
                            console.log(`   ✅ Production Order line ${lineNumber} updated: ${originalItemCode} → ${itemCode}`);
                            poLineUpdated = true;

                            // Re-fetch PO to get the actual SAP line number for the updated item
                            const sapLine = await resolveBaseLineFromSAP('after PATCH');
                            if (sapLine !== null) resolvedBaseLine = sapLine;
                        }
                    } else {
                        console.log(`   ⚠️ Line ${lineNumber} not found in Production Order`);
                    }
                }
            } catch (updateErr) {
                const errMsg = updateErr.response?.data?.error?.message?.value || updateErr.message;
                console.log(`   ⚠️ Failed to update PO line: ${errMsg}`);
                console.log(`   Will proceed with standalone issue instead`);
            }
        }
        
        // Determine issue strategy when item code is changed:
        // For PMT we want IssuedQuantity to reflect on the Production Order, so prefer LINKED issue.
        // Standalone is slower and does not reflect against the PO, so keep it only as a last resort.
        let useStandaloneIssue = false;
        let tryLinkedFirst = false;
        if (itemCodeChanged === true) {
            tryLinkedFirst = poLineUpdated === true;
            useStandaloneIssue = poLineUpdated !== true;
        }
        
        if (tryLinkedFirst) {
            console.log(`   Issue Mode: LINKED TO PO (after code-change patch)`);
        } else if (useStandaloneIssue) {
            console.log(`   Issue Mode: STANDALONE ISSUE (PO line update failed; will be slower and won't reflect on PO)`);
        } else {
            console.log(`   Issue Mode: LINKED TO PO`);
        }
        
        if (!absoluteEntry || !itemCode || !quantity) {
            return res.status(400).json({
                error: 'Missing required fields',
                message: 'absoluteEntry, itemCode, and quantity are required'
            });
        }

        // Linked issues require the Production Order to be Released in SAP.
        // If not released, Service Layer returns:
        // "Referenced production order status should be \"Released\"  [DocumentLines.BaseEntry]"
        if (!useStandaloneIssue) {
            try {
                const poStatusEndpoint = `/ProductionOrders(${absoluteEntry})?$select=AbsoluteEntry,DocumentNumber,ProductionOrderStatus`;
                const poStatusData = await sapGetRequest(poStatusEndpoint);
                const poStatus = poStatusData?.ProductionOrderStatus;
                if (poStatus && poStatus !== 'boposReleased') {
                    return res.status(400).json({
                        error: 'Production order not released',
                        message: `Production Order must be Released in SAP before issuing material. Current status: ${poStatus}`,
                        absoluteEntry,
                        documentNumber,
                        productionOrderStatus: poStatus
                    });
                }
            } catch (statusErr) {
                const msg = statusErr?.response?.data?.error?.message?.value || statusErr?.message;
                console.log(`   ⚠️ PO status check failed (continuing): ${msg}`);
            }
        }

        // If we are going to attempt a linked issue, make sure BaseLine is resolved from SAP
        // (UI-provided lineNumber can be stale after line updates)
        if (!useStandaloneIssue) {
            const sapLine = await resolveBaseLineFromSAP('before issue');
            if (sapLine !== null) resolvedBaseLine = sapLine;
        }
        
        // Get item details to check if batch managed and get warehouse stock
        const itemEndpoint = `/Items('${encodeURIComponent(itemCode)}')?$select=ItemCode,ItemName,ManageBatchNumbers,ItemWarehouseInfoCollection`;
        const itemData = await sapGetRequest(itemEndpoint);
        
        if (!itemData || !itemData.ItemCode) {
            return res.status(404).json({
                error: 'Item not found',
                itemCode: itemCode
            });
        }
        
        const isBatchManaged = itemData.ManageBatchNumbers === 'tYES';
        console.log(`   Item Name: ${itemData.ItemName}`);
        console.log(`   Batch Managed: ${isBatchManaged}`);
        
        // Check target warehouse stock
        let warehouseStock = { InStock: 0, Committed: 0, Ordered: 0 };
        if (itemData.ItemWarehouseInfoCollection) {
            for (const wh of itemData.ItemWarehouseInfoCollection) {
                if (wh.WarehouseCode === targetWarehouse) {
                    warehouseStock = { InStock: wh.InStock || 0, Committed: wh.Committed || 0, Ordered: wh.Ordered || 0 };
                    break;
                }
            }
        }
        console.log(`   ${targetWarehouse} Stock: InStock=${warehouseStock.InStock}, Committed=${warehouseStock.Committed}`);
        
        if (warehouseStock.InStock < quantity) {
            console.log(`   ❌ Insufficient stock in ${targetWarehouse}: ${warehouseStock.InStock} available, need ${quantity}`);
            return res.status(400).json({
                error: `Insufficient stock in ${targetWarehouse}`,
                message: `Only ${warehouseStock.InStock} units available in ${targetWarehouse} warehouse, need ${quantity}`,
                itemCode: itemCode,
                quantity: quantity,
                available: warehouseStock.InStock
            });
        }
        
        const currentDate = getSAPPostingDate();
        
        // For batch-managed items, get batches and issue using multi-batch approach
        if (isBatchManaged) {
            console.log(`   Batch-managed item. Finding batches with stock in ${targetWarehouse}...`);
            
            // Use dynamic SQL query to get batches with stock in target warehouse
            let batchesInWarehouse = [];
            
            // Use a unique query name based on timestamp to avoid conflicts
            const queryCode = `BatchStock_${Date.now()}`;
            
            try {
                console.log(`   Creating SQL query: ${queryCode}`);
                
                const createPayload = {
                    SqlCode: queryCode,
                    SqlName: `Batch Stock Query ${Date.now()}`,
                    SqlText: `SELECT T0."DistNumber" AS "BatchNumber", T1."Quantity" FROM OBTN T0 INNER JOIN OBTQ T1 ON T0."AbsEntry" = T1."MdAbsEntry" WHERE T1."ItemCode" = '${itemCode}' AND T1."WhsCode" = '${targetWarehouse}' AND T1."Quantity" > 0 ORDER BY T1."Quantity" DESC`
                };
                
                await sapPostRequest('/SQLQueries', createPayload);
                console.log(`   Query created!`);
                
                // Execute the query
                const result = await sapGetRequest(`/SQLQueries('${queryCode}')/List`);
                
                if (result && result.value && result.value.length > 0) {
                    console.log(`   ✅ Found ${result.value.length} batches with stock in ${targetWarehouse}`);
                    batchesInWarehouse = result.value.map(row => ({
                        batchNumber: row.BatchNumber,
                        quantity: row.Quantity
                    }));
                    batchesInWarehouse.forEach(b => {
                        console.log(`      Batch: ${b.batchNumber}, Qty: ${b.quantity}`);
                    });
                }
                
                // Clean up - delete the query after use
                try {
                    await axios.delete(`${SAP_BASE_URL}/SQLQueries('${queryCode}')`, {
                        headers: getSAPRequestHeaders(),
                        httpsAgent: sapHttpsAgent
                    });
                    console.log(`   Query cleaned up`);
                } catch (delErr) {
                    // Ignore cleanup errors
                }
                
            } catch (queryErr) {
                console.log(`   SQL query failed: ${queryErr.response?.data?.error?.message?.value || queryErr.message}`);
            }
            
            // Fallback: Get all batches via $crossjoin
            let batchList = [];
            if (batchesInWarehouse.length > 0) {
                batchesInWarehouse.sort((a, b) => b.quantity - a.quantity);
                batchList = batchesInWarehouse.map(b => b.batchNumber);
                console.log(`   Using ${batchList.length} batches from SQL query`);
            } else {
                console.log(`   Falling back to $crossjoin...`);
                try {
                    const crossjoinEndpoint = `/$crossjoin(BatchNumberDetails,Items)?$expand=BatchNumberDetails($select=Batch,ItemCode),Items($select=ItemCode)&$filter=BatchNumberDetails/ItemCode eq Items/ItemCode and Items/ItemCode eq '${itemCode}'`;
                    const crossjoinResult = await sapGetRequest(crossjoinEndpoint);
                    if (crossjoinResult.value) {
                        batchList = crossjoinResult.value.map(r => r.BatchNumberDetails.Batch);
                        console.log(`   Found ${batchList.length} batches from $crossjoin`);
                    }
                } catch (cjError) {
                    console.log(`   $crossjoin failed: ${cjError.message}`);
                }
            }
            
            if (batchList.length === 0) {
                console.log(`   ❌ No batches found for item ${itemCode}`);
                return res.status(400).json({
                    error: 'No batches found',
                    message: `No batches found for item ${itemCode}. Please check batch management in SAP.`,
                    itemCode: itemCode
                });
            }
            
            // Try multi-batch issue
            let remainingQty = quantity;
            const batchesUsed = [];
            
            // If we have batch quantities, do a single linked request (fast path)
            if (batchesInWarehouse.length > 0) {
                console.log(`   Attempting multi-batch issue in single request...`);
                
                const batchAllocation = [];
                let tempRemaining = quantity;
                
                for (const batch of batchesInWarehouse) {
                    if (tempRemaining <= 0) break;
                    const qtyFromBatch = Math.min(batch.quantity, tempRemaining);
                    if (qtyFromBatch > 0) {
                        batchAllocation.push({
                            BatchNumber: batch.batchNumber,
                            Quantity: qtyFromBatch
                        });
                        tempRemaining -= qtyFromBatch;
                    }
                }
                
                if (batchAllocation.length > 0 && tempRemaining <= 0) {
                    console.log(`   Batch allocation plan:`);
                    batchAllocation.forEach(b => console.log(`      ${b.BatchNumber}: ${b.Quantity} units`));
                    
                    // Build linked payload (for normal issue or tryLinkedFirst)
                    const linkedPayload = {
                        DocDate: currentDate,
                        BPLID: SAP_BPL_ID,
                        BPL_IDAssignedToInvoice: SAP_BPL_ID,
                        Comments: remarks || `${materialType} material issued via Data Entry WebApp (PO: ${poReference})`,
                        DocumentLines: [{
                            BaseType: 202,
                            BaseEntry: absoluteEntry,
                            BaseLine: resolvedBaseLine,
                            Quantity: quantity,
                            WarehouseCode: targetWarehouse,
                            BatchNumbers: batchAllocation
                        }]
                    };
                    
                    // Execute linked request (fast path). If it fails with "Line not found", retry once after re-resolving BaseLine.
                    try {
                        console.log(`   Sending linked multi-batch request...`);
                        const result = await sapPostRequest('/InventoryGenExits', linkedPayload);
                        console.log(`   ✅ Linked multi-batch issue succeeded! DocEntry: ${result?.DocEntry}`);
                        batchAllocation.forEach(b => {
                            batchesUsed.push({ batch: b.BatchNumber, quantity: b.Quantity, docEntry: result?.DocEntry });
                        });
                        remainingQty = 0;
                    } catch (multiBatchErr) {
                        const errMsg = multiBatchErr.response?.data?.error?.message?.value || multiBatchErr.message;
                        console.log(`   Linked multi-batch failed: ${errMsg}`);

                        const isLineNotFound =
                            (multiBatchErr.response?.status === 404 || String(errMsg).includes('Line:')) &&
                            String(errMsg).includes('Not Found');

                        if (isLineNotFound) {
                            const retryLine = await resolveBaseLineFromSAP('retry after linked Not Found');
                            if (retryLine !== null && retryLine !== resolvedBaseLine) {
                                resolvedBaseLine = retryLine;
                                console.log(`   🔄 Retrying LINKED multi-batch with BaseLine=${resolvedBaseLine}...`);
                                const retryLinkedPayload = {
                                    ...linkedPayload,
                                    DocumentLines: [{
                                        ...linkedPayload.DocumentLines[0],
                                        BaseLine: resolvedBaseLine
                                    }]
                                };
                                const retryResult = await sapPostRequest('/InventoryGenExits', retryLinkedPayload);
                                console.log(`   ✅ Linked retry succeeded! DocEntry: ${retryResult?.DocEntry}`);
                                batchAllocation.forEach(b => {
                                    batchesUsed.push({ batch: b.BatchNumber, quantity: b.Quantity, docEntry: retryResult?.DocEntry });
                                });
                                remainingQty = 0;
                            }
                        }
                    }
                }
            }
            
            // Fallback: Try each batch individually (only when we couldn't do the fast single-request path)
            if (remainingQty > 0) {
                console.log(`   Falling back to single-batch approach...`);
                for (const batchNum of batchList.slice(0, 20)) {
                    if (remainingQty <= 0) break;
                    
                    const knownBatch = batchesInWarehouse.find(b => b.batchNumber === batchNum);
                    const maxQtyFromBatch = knownBatch ? knownBatch.quantity : remainingQty;
                    const qtyToTry = Math.min(remainingQty, maxQtyFromBatch);
                    
                    if (qtyToTry <= 0) continue;
                    
                    console.log(`   Trying batch ${batchNum} for ${qtyToTry} units...`);
                    
                    // Build linked payload
                    const linkedPayload = {
                        DocDate: currentDate,
                        BPLID: SAP_BPL_ID,
                        BPL_IDAssignedToInvoice: SAP_BPL_ID,
                        Comments: remarks || `${materialType} material issued via Data Entry WebApp (PO: ${poReference})`,
                        DocumentLines: [{
                            BaseType: 202,
                            BaseEntry: absoluteEntry,
                            BaseLine: resolvedBaseLine,
                            Quantity: qtyToTry,
                            WarehouseCode: targetWarehouse,
                            BatchNumbers: [{
                                BatchNumber: batchNum,
                                Quantity: qtyToTry
                            }]
                        }]
                    };
                    
                    const issuePayload = useStandaloneIssue ? null : linkedPayload;

                    if (issuePayload) {
                        try {
                            const result = await sapPostRequest('/InventoryGenExits', issuePayload);
                            console.log(`   ✅ Issued ${qtyToTry} units from batch ${batchNum}, DocEntry: ${result?.DocEntry}`);
                            batchesUsed.push({ batch: batchNum, quantity: qtyToTry, docEntry: result?.DocEntry });
                            remainingQty -= qtyToTry;
                        } catch (issueErr) {
                            const errMsg = issueErr.response?.data?.error?.message?.value || issueErr.message;
                            console.log(`   ❌ Batch ${batchNum} for ${qtyToTry} failed: ${errMsg}`);

                            // If linked issue fails due to missing base line, re-resolve BaseLine and retry linked once.
                            if (
                                tryLinkedFirst &&
                                !useStandaloneIssue &&
                                (issueErr.response?.status === 404 || String(errMsg).includes('Line:')) &&
                                String(errMsg).includes('Not Found')
                            ) {
                                // Re-resolve BaseLine once and retry linked before switching to standalone
                                const retryLine = await resolveBaseLineFromSAP('single-batch retry after linked Not Found');
                                if (retryLine !== null && retryLine !== resolvedBaseLine) {
                                    resolvedBaseLine = retryLine;
                                    console.log(`   🔄 Retrying LINKED single-batch with BaseLine=${resolvedBaseLine}...`);
                                    try {
                                        const retryLinkedPayload = {
                                            ...linkedPayload,
                                            DocumentLines: [{
                                                ...linkedPayload.DocumentLines[0],
                                                BaseLine: resolvedBaseLine
                                            }]
                                        };
                                        const retryResult = await sapPostRequest('/InventoryGenExits', retryLinkedPayload);
                                        console.log(`   ✅ Linked retry succeeded! DocEntry: ${retryResult?.DocEntry}`);
                                        batchesUsed.push({ batch: batchNum, quantity: qtyToTry, docEntry: retryResult?.DocEntry });
                                        remainingQty -= qtyToTry;
                                        continue;
                                    } catch (retryLinkedErr) {
                                        const retryMsg = retryLinkedErr.response?.data?.error?.message?.value || retryLinkedErr.message;
                                        console.log(`   ❌ Linked retry failed: ${retryMsg}`);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            if (remainingQty <= 0) {
                const totalIssued = quantity;
                console.log(`✅ Successfully issued ${totalIssued} units of ${itemCode} from ${targetWarehouse}`);
                console.log(`   Batches used: ${batchesUsed.map(b => `${b.batch}(${b.quantity})`).join(', ')}`);
                console.log('========================================');

                // Traceability: record each batch consumed against this PO (non-blocking)
                await recordMaterialIssues(
                    {
                        po_num: documentNumber || absoluteEntry,
                        absolute_entry: absoluteEntry,
                        line_number: resolvedBaseLine,
                        item_code: itemCode,
                        warehouse: targetWarehouse,
                        operator_name: operatorName || null,
                        machine_name: machineName || null,
                        remarks: remarks || null
                    },
                    batchesUsed
                );

                return res.json({
                    success: true,
                    message: `Successfully issued ${totalIssued} units of ${itemCode} from ${targetWarehouse}`,
                    itemCode: itemCode,
                    quantity: totalIssued,
                    warehouse: targetWarehouse,
                    batchesUsed: batchesUsed
                });
            } else {
                const issued = quantity - remainingQty;
                console.log(`   ⚠️ Partial issue: ${issued}/${quantity} units issued, ${remainingQty} remaining`);
                console.log('========================================');
                
                return res.status(400).json({
                    error: 'Partial issue or batch issue failed',
                    message: `Could only issue ${issued} of ${quantity} units. ${remainingQty} units remaining.`,
                    itemCode: itemCode,
                    quantity: quantity,
                    issued: issued,
                    remaining: remainingQty,
                    batchesUsed: batchesUsed
                });
            }
        } else {
            // Not batch managed - simple issue
            console.log(`   Non-batch item. Issuing directly...`);

            // 2-step code-change always uses standalone issue payload (STEP 2).
            // For non-code-change, keep the existing linked-first behavior.
            if (useStandaloneIssue) {
                const standalonePayload = {
                    DocDate: currentDate,
                    BPLID: SAP_BPL_ID,
                    BPL_IDAssignedToInvoice: SAP_BPL_ID,
                    Comments: remarks || `${materialType} material issued via Data Entry WebApp`,
                    DocumentLines: [{
                        ItemCode: itemCode,
                        Quantity: quantity,
                        WarehouseCode: targetWarehouse
                    }]
                };

                const result = await sapPostRequest('/InventoryGenExits', standalonePayload);
                console.log(`✅ Standalone issue successful! DocEntry: ${result?.DocEntry}`);
                console.log('========================================');

                return res.json({
                    success: true,
                    message: `Successfully issued ${quantity} units of ${itemCode}`,
                    docEntry: result?.DocEntry,
                    itemCode: itemCode,
                    quantity: quantity,
                    warehouse: targetWarehouse,
                    note: 'Two-step code-change flow: PO line patched, then standalone Goods Issue posted'
                });
            }

            // For non-batch items, try issuing linked to PO first
            // If that fails due to backflush error, try standalone issue
            let issuePayload = {
                DocDate: currentDate,
                BPLID: SAP_BPL_ID,
                BPL_IDAssignedToInvoice: SAP_BPL_ID,
                Comments: remarks || `${materialType} material issued via Data Entry WebApp`,
                DocumentLines: [{
                    BaseType: 202,
                    BaseEntry: absoluteEntry,
                    BaseLine: lineNumber !== undefined ? lineNumber : 0,
                    Quantity: quantity,
                    WarehouseCode: targetWarehouse
                    // Note: Removed TransactionType to avoid backflush issues
                }]
            };

            try {
                const result = await sapPostRequest('/InventoryGenExits', issuePayload);

                console.log(`✅ Successfully issued ${quantity} units of ${itemCode}, DocEntry: ${result?.DocEntry}`);
                console.log('========================================');

                return res.json({
                    success: true,
                    message: `Successfully issued ${quantity} units of ${itemCode}`,
                    docEntry: result?.DocEntry,
                    itemCode: itemCode,
                    quantity: quantity,
                    warehouse: targetWarehouse
                });
            } catch (linkedError) {
                const linkedErrMsg = linkedError.response?.data?.error?.message?.value || linkedError.message;
                console.log(`   ⚠️ Linked issue failed: ${linkedErrMsg}`);

                // If linked issue fails (e.g., backflush OR base document/line not found), try standalone Goods Issue
                if (
                    linkedErrMsg.includes('backflush') ||
                    linkedErrMsg.includes('serial') ||
                    linkedErrMsg.includes('batch') ||
                    linkedErrMsg.includes('[WOR1]') ||
                    (linkedErrMsg.toLowerCase().includes('production order') && linkedErrMsg.toLowerCase().includes('not found'))
                ) {
                    console.log(`   Trying standalone Goods Issue (not linked to PO)...`);

                    const standalonePayload = {
                        DocDate: currentDate,
                        BPLID: SAP_BPL_ID,
                        BPL_IDAssignedToInvoice: SAP_BPL_ID,
                        Comments: remarks || `${materialType} material issued via Data Entry WebApp (PO: ${absoluteEntry})`,
                        DocumentLines: [{
                            ItemCode: itemCode,
                            Quantity: quantity,
                            WarehouseCode: targetWarehouse
                        }]
                    };

                    try {
                        const standaloneResult = await sapPostRequest('/InventoryGenExits', standalonePayload);

                        console.log(`✅ Standalone issue successful! DocEntry: ${standaloneResult?.DocEntry}`);
                        console.log('========================================');

                        return res.json({
                            success: true,
                            message: `Successfully issued ${quantity} units of ${itemCode} (standalone)`,
                            docEntry: standaloneResult?.DocEntry,
                            itemCode: itemCode,
                            quantity: quantity,
                            warehouse: targetWarehouse,
                            note: 'Issued as standalone Goods Issue due to PO configuration'
                        });
                    } catch (standaloneError) {
                        const standaloneErrMsg = standaloneError.response?.data?.error?.message?.value || standaloneError.message;
                        console.log(`   ❌ Standalone issue also failed: ${standaloneErrMsg}`);
                        throw standaloneError;
                    }
                } else {
                    throw linkedError;
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Error issuing material:', error.message);
        if (error.response?.data) {
            console.error('   SAP Error:', JSON.stringify(error.response.data, null, 2));
        }
        console.log('========================================');
        
        res.status(500).json({
            error: 'Failed to issue material',
            message: error.message,
            details: error.response?.data || null
        });
    }
});

/**
 * POST /api/appsheet/breakdown-ticket
 * Proxy endpoint to raise breakdown tickets in AppSheet
 * This avoids CORS issues when calling AppSheet API from browser
 */
app.post('/api/appsheet/breakdown-ticket', async (req, res) => {
    const APPSHEET_CONFIG = {
        appId: 'd57a7f21-0dc2-4d99-b71e-5b6c71a4b196',
        accessKey: 'V2-n1YJI-NmvAJ-EGgqi-ZDbTK-dHxb7-dgdaA-cLmTa-WDxmO',
        tableName: 'BreakdownTickets',
        apiUrl: 'https://api.appsheet.com/api/v2/apps'
    };

    try {
        const { ticketData } = req.body;
        
        if (!ticketData) {
            return res.status(400).json({ error: 'Ticket data is required' });
        }

        console.log('🎫 Raising AppSheet breakdown ticket:', ticketData);

        // AppSheet API request body
        const requestBody = {
            'Action': 'Add',
            'Properties': {
                'Locale': 'en-US',
                'Timezone': 'Asia/Kolkata'
            },
            'Rows': [ticketData]
        };

        const appsheetUrl = `${APPSHEET_CONFIG.apiUrl}/${APPSHEET_CONFIG.appId}/tables/${APPSHEET_CONFIG.tableName}/Action`;
        
        const response = await axios.post(appsheetUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'ApplicationAccessKey': APPSHEET_CONFIG.accessKey
            }
        });

        console.log('✅ AppSheet ticket raised successfully');
        res.json({
            success: true,
            message: 'Breakdown ticket raised successfully',
            data: response.data
        });

    } catch (error) {
        console.error('❌ Error raising AppSheet ticket:', error.message);
        if (error.response) {
            console.error('   AppSheet Error:', error.response.status, error.response.data);
        }
        
        res.status(500).json({
            error: 'Failed to raise breakdown ticket',
            message: error.message,
            details: error.response?.data || null
        });
    }
});

app.get('/api/debug/itemcode-label/:itemCode', async (req, res) => {
    const itemCode = (req.params.itemCode || '').trim();
    if (!itemCode) return res.status(400).json({ error: 'itemCode required' });

    const k = itemCode.replace(/'/g, "''");
    const attempts = [];
    const tryGet = async (name, endpoint) => {
        try {
            const data = await sapGetRequest(endpoint);
            attempts.push({ name, ok: true, endpoint, sample: data });
        } catch (e) {
            attempts.push({
                name,
                ok: false,
                endpoint,
                status: e?.response?.status,
                message: e?.response?.data?.error?.message?.value || e?.message
            });
        }
    };

    await tryGet('Items.SupplierCatalogNo', `/Items('${k}')?$select=ItemCode,SupplierCatalogNo`);
    await tryGet('AlternateCatNum (OSCN?)', `/AlternateCatNum?$filter=ItemCode eq '${k}'&$select=ItemCode,CardCode,Substitute&$top=5`);
    await tryGet('BusinessPartnerCatalogNumbers', `/BusinessPartnerCatalogNumbers?$filter=ItemCode eq '${k}'&$top=5`);
    await tryGet('ItemCatalogNumbers', `/ItemCatalogNumbers?$filter=ItemCode eq '${k}'&$top=5`);
    await tryGet('CatalogNumbers', `/CatalogNumbers?$filter=ItemCode eq '${k}'&$top=5`);
    await tryGet('ItemsCatalogNumbers', `/ItemsCatalogNumbers?$filter=ItemCode eq '${k}'&$top=5`);
    await tryGet('ItemCatalogNumberCollection', `/ItemCatalogNumberCollection?$filter=ItemCode eq '${k}'&$top=5`);

    let sql = null;
    try {
        sql = await runSapSqlQuery(
            `SELECT TOP 5 T0."ItemCode", T0."CardCode", T0."Substitute" FROM OSCN T0 WHERE T0."ItemCode" = '${k}'`,
            'DBG_OSCN'
        );
    } catch (e) {
        sql = {
            ok: false,
            status: e?.response?.status,
            message: e?.response?.data?.error?.message?.value || e?.message
        };
    }

    res.json({ itemCode, attempts, sql });
});

/**
 * Helper function to get current shift type
 */
function getCurrentShiftType() {
    const now = new Date();
    const hours = now.getHours();
    
    // Day shift: 9 AM to 8 PM
    // Night shift: 8 PM to 9 AM
    if (hours >= 9 && hours < 20) {
        return 'day';
    } else {
        return 'night';
    }
}

// ==================== Live Tracking API Endpoints ====================
// Operator login/logout per shift + live machine status/state for the dashboard.

// Operator selects a machine -> record login + operator name + login time.
app.post('/api/live/login', async (req, res) => {
    try {
        const { machineId, machineName, category, process, operator, deviceId } = req.body || {};
        const result = await liveTracking.login({ machineId, machineName, category, process, operator, deviceId });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('live/login error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// Operator logs out (manual end-shift button).
app.post('/api/live/logout', async (req, res) => {
    try {
        const { machineId, reason } = req.body || {};
        const result = await liveTracking.logout({ machineId, reason });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('live/logout error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// A job is loaded onto the machine -> record job + load time.
app.post('/api/live/job-load', async (req, res) => {
    try {
        const { machineId, machineName, po, jobName, fgNum, plannedQty } = req.body || {};
        const result = await liveTracking.jobLoad({ machineId, machineName, po, jobName, fgNum, plannedQty });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('live/job-load error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// Job finished / unloaded.
app.post('/api/live/job-unload', async (req, res) => {
    try {
        const { machineId } = req.body || {};
        const result = await liveTracking.jobUnload({ machineId });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('live/job-unload error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// Machine state change (running / downtime / lunch / etc.) -> records start time.
app.post('/api/live/state', async (req, res) => {
    try {
        const { machineId, machineName, state } = req.body || {};
        const result = await liveTracking.setState({ machineId, machineName, state });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('live/state error:', error.message);
        res.status(400).json({ success: false, error: error.message });
    }
});

// Live status for a single machine.
app.get('/api/live/status/:machineId', async (req, res) => {
    try {
        const status = await liveTracking.getStatus(req.params.machineId);
        res.json({ success: true, status });
    } catch (error) {
        console.error('live/status error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Live status for ALL machines (dashboard feed).
app.get('/api/live/dashboard', async (req, res) => {
    try {
        const machines = await liveTracking.getDashboard();
        res.json({ success: true, generatedAt: new Date().toISOString(), machines });
    } catch (error) {
        console.error('live/dashboard error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Shift session history (logins/logouts).
app.get('/api/live/sessions', async (req, res) => {
    try {
        const { date, shift, machineId, limit } = req.query;
        const sessions = await liveTracking.getSessions({ date, shift, machineId, limit });
        res.json({ success: true, sessions });
    } catch (error) {
        console.error('live/sessions error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Machine state timeline (durations per state).
app.get('/api/live/state-history', async (req, res) => {
    try {
        const { date, shift, machineId, limit } = req.query;
        const history = await liveTracking.getStateHistory({ date, shift, machineId, limit });
        res.json({ success: true, history });
    } catch (error) {
        console.error('live/state-history error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== Label Printer API Endpoints ====================

/**
 * GET /api/printer/status
 * Check printer connection status
 */
app.get('/api/printer/status', async (req, res) => {
    try {
        const client = new net.Socket();
        let connected = false;
        
        client.setTimeout(3000);
        
        await new Promise((resolve, reject) => {
            client.connect(LABEL_PRINTER_CONFIG.port, LABEL_PRINTER_CONFIG.ip, () => {
                connected = true;
                client.end();
                resolve();
            });
            
            client.on('timeout', () => {
                client.destroy();
                reject(new Error('Connection timeout'));
            });
            
            client.on('error', (err) => {
                client.destroy();
                reject(err);
            });
        });
        
        res.json({
            success: true,
            status: 'online',
            printer: {
                ip: LABEL_PRINTER_CONFIG.ip,
                port: LABEL_PRINTER_CONFIG.port,
                type: LABEL_PRINTER_CONFIG.printerType,
                enabled: LABEL_PRINTER_CONFIG.enabled
            }
        });
    } catch (error) {
        res.json({
            success: false,
            status: 'offline',
            error: error.message,
            printer: {
                ip: LABEL_PRINTER_CONFIG.ip,
                port: LABEL_PRINTER_CONFIG.port,
                type: LABEL_PRINTER_CONFIG.printerType,
                enabled: LABEL_PRINTER_CONFIG.enabled
            }
        });
    }
});

/**
 * POST /api/printer/test
 * Print a test label
 */
app.post('/api/printer/test', async (req, res) => {
    try {
        const testData = {
            customerName: 'TEST CUSTOMER',
            customerCode: 'TEST-001',
            itemDescription: 'Test Label - Printer Configuration Check',
            fgCode: 'FG-TEST-001',
            jobNo: 'PO-TEST-001',
            quantity: 100,
            packedOn: new Date().toLocaleDateString('en-IN'),
            operator: 'System Test',
            batchNo: 'TEST-BATCH'
        };
        
        const result = await printFGLabels(testData, 1);
        
        res.json({
            success: result.success,
            message: result.message,
            printer: {
                ip: LABEL_PRINTER_CONFIG.ip,
                port: LABEL_PRINTER_CONFIG.port,
                type: LABEL_PRINTER_CONFIG.printerType
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            printer: {
                ip: LABEL_PRINTER_CONFIG.ip,
                port: LABEL_PRINTER_CONFIG.port,
                type: LABEL_PRINTER_CONFIG.printerType
            }
        });
    }
});

/**
 * POST /api/printer/config
 * Update printer configuration (runtime only, not persisted)
 */
app.post('/api/printer/config', (req, res) => {
    const { ip, port, enabled, printerType } = req.body;
    
    if (ip) LABEL_PRINTER_CONFIG.ip = ip;
    if (port) LABEL_PRINTER_CONFIG.port = parseInt(port);
    if (typeof enabled === 'boolean') LABEL_PRINTER_CONFIG.enabled = enabled;
    if (printerType) LABEL_PRINTER_CONFIG.printerType = printerType;
    
    console.log(`🖨️ Printer config updated: ${LABEL_PRINTER_CONFIG.ip}:${LABEL_PRINTER_CONFIG.port} (${LABEL_PRINTER_CONFIG.enabled ? 'enabled' : 'disabled'})`);
    
    res.json({
        success: true,
        message: 'Printer configuration updated',
        config: LABEL_PRINTER_CONFIG
    });
});

/**
 * GET /api/printer/config
 * Get current printer configuration
 */
app.get('/api/printer/config', (req, res) => {
    res.json({
        success: true,
        config: LABEL_PRINTER_CONFIG,
        labelPrintMode: LABEL_PRINT_MODE,
        fgZplRenderMode: FG_ZPL_RENDER_MODE,
        cupsPrinterName: CUPS_PRINTER_NAME || null,
        zplViaCupsRaw: LABEL_CUPS_RAW_QUEUE && !!CUPS_PRINTER_NAME && process.platform !== 'win32'
    });
});

/**
 * GET /api/printer/cups-queues
 * Lists CUPS queue names for configuring CUPS_PRINTER_NAME (PDF mode).
 */
app.get('/api/printer/cups-queues', async (req, res) => {
    try {
        const queues = await listCupsPrinterQueues();
        if (!Array.isArray(queues)) {
            return res.status(500).json({
                success: false,
                error: queues.error || 'Could not run lpstat',
                hint: 'Install cups-client and ensure CUPS is running, or mount /var/run/cups/cups.sock from the host into Docker.'
            });
        }
        res.json({
            success: true,
            queues,
            configured: CUPS_PRINTER_NAME || null,
            match: CUPS_PRINTER_NAME ? queues.includes(CUPS_PRINTER_NAME) : false
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== Finished Goods (FG) Entry API ====================

/**
 * POST /api/fg-entry
 * Submit Finished Goods entry to SAP and database.
 * FG is terminal: SAP report completion only — no auto-issue to next process.
 */
app.post('/api/fg-entry', async (req, res) => {
    try {
        const {
            poNumber,
            absoluteEntry,
            itemCode,
            productDescription,
            plannedQuantity,
            fgQuantity,
            qcSupervisor,
            operatorName,
            remarks,
            pkdDetails,
            role_usages: roleUsagesBody
        } = req.body;
        const role_usages = Array.isArray(roleUsagesBody) ? roleUsagesBody : [];

        console.log('\n📦 ========== FINISHED GOODS ENTRY ==========');
        console.log(`   PO Number: ${poNumber}`);
        console.log(`   Absolute Entry: ${absoluteEntry}`);
        console.log(`   Item Code: ${itemCode}`);
        console.log(`   FG Quantity: ${fgQuantity}`);
        console.log(`   QC Supervisor: ${qcSupervisor}`);

        if (!poNumber || !fgQuantity || !qcSupervisor) {
            return res.status(400).json({
                error: 'Missing required fields',
                message: 'poNumber, fgQuantity, and qcSupervisor are required'
            });
        }

        const currentTime = new Date().toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const mysqlTimestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

        let fullRemarks = `FG Qty: ${fgQuantity}`;
        if (pkdDetails) fullRemarks += ` | PKD: ${pkdDetails}`;
        if (remarks) fullRemarks += ` | ${remarks}`;

        let dbResult = null;
        let batchNumber = null;
        try {
            const jobData = {
                po_num: poNumber,
                fg_num: itemCode,
                job_name: productDescription,
                operator_name: qcSupervisor,
                shift_type: getCurrentShiftType(),
                machine_name: 'FG-Entry',
                process_name: 'Finished Goods',
                planned_qty: plannedQuantity || 0,
                job_start_time: mysqlTimestamp,
                job_end_time: mysqlTimestamp,
                quantity_processed: fgQuantity,
                speed_impressions_per_hour: 0,
                sheets_wasted: 0,
                remark: fullRemarks
            };
            dbResult = await insertJobActivities(jobData, [{ activity_name: 'FG_ENTRY', activity_time_minutes: 0 }]);
            batchNumber = dbResult.batch_num;
            console.log(`   ✅ Database save successful. Batch: ${batchNumber}`);

            if (batchNumber && role_usages.length > 0) {
                try {
                    const completionOperator = operatorName || qcSupervisor || null;
                    const recorded = await recordRoleBatchUsages(
                        poNumber,
                        batchNumber,
                        role_usages,
                        {
                            operator_name: completionOperator,
                            machine_name: 'FG-Entry'
                        }
                    );
                    await backfillRoleBatchUsageOperators(poNumber);
                    console.log(`   ✅ FG traceability: ${recorded} input usage row(s) → ${batchNumber}`);
                } catch (usageErr) {
                    console.warn('⚠️ FG role_batch_usage save failed (non-blocking):', usageErr.message);
                }
            }
        } catch (dbError) {
            console.error('   ❌ Database save failed:', dbError.message);
            return res.status(500).json({
                error: 'Database error',
                message: 'Failed to generate batch number. Please try again.',
                details: dbError.message
            });
        }

        let sapResult = null;
        if (absoluteEntry) {
            try {
                const customerName = req.body.customerName || '';
                let baseLine = null;
                let poHeaderItem = itemCode;
                try {
                    const poLineData = await sapGetRequest(
                        `/ProductionOrders(${absoluteEntry})?$select=ItemNo,AbsoluteEntry,ProductionOrderLines`
                    );
                    const resolved = resolveMainProductCompletionLine(poLineData, itemCode);
                    baseLine = resolved.baseLine;
                    poHeaderItem = resolved.headerItem || itemCode;
                } catch (e) {
                    console.warn('   ⚠️ Could not fetch ProductionOrderLines for BaseLine:', e?.message || e);
                }

                let sapComments = `FG Entry - QC: ${qcSupervisor} | Qty: ${fgQuantity}`;
                if (pkdDetails) sapComments += ` | PKD: ${pkdDetails}`;
                if (remarks) sapComments += ` | ${remarks}`;

                sapResult = await postJobCompletionToSAP({
                    absoluteEntry,
                    quantity: fgQuantity,
                    batchNumber,
                    batchComments: `QC: ${qcSupervisor}${pkdDetails ? ' | PKD: ' + pkdDetails : ''}`,
                    operatorName: qcSupervisor,
                    itemCode: poHeaderItem || itemCode,
                    machineName: 'FG-Entry',
                    batchMachineLabel: 'FG-Entry',
                    batchAppLabel: 'FG Data Entry WebApp',
                    startTime: currentTime,
                    endTime: currentTime,
                    remarks: sapComments,
                    customerName,
                    baseLine
                });
            } catch (sapError) {
                console.error('   ❌ SAP posting failed:', sapError.message);
                sapResult = {
                    success: false,
                    error: sapError.message,
                    details: sapError.response?.data || null
                };
            }
        }

        const numLabels = 1;
        const labelNow = new Date();
        const packedOnDate = `${String(labelNow.getDate()).padStart(2, '0')}/${String(labelNow.getMonth() + 1).padStart(2, '0')}/${labelNow.getFullYear()}`;
        const inventoryUOM = (req.body.inventoryUOM || '').toString().trim()
            || (await fetchItemInventoryUOM(itemCode))
            || 'KGS';
        const labelData = {
            customerName: req.body.customerName || '',
            customerCode: req.body.customerCode || '',
            itemCodeLabel: (req.body.itemCodeLabel || '') || (await fetchOscnSubstitute(itemCode)),
            itemDescription: productDescription || '',
            fgCode: itemCode || '',
            jobNo: req.body.jobNo || poNumber,
            quantity: fgQuantity,
            totalQuantity: fgQuantity,
            inventoryUOM,
            packedOn: packedOnDate,
            operator: formatLabelOperatorField(qcSupervisor, operatorName),
            batchNo: batchNumber || ''
        };

        let printResult = {
            success: false,
            message: 'Label available after submit',
            printed: 0,
            previewPending: true
        };

        res.json({
            success: true,
            message: 'FG entry submitted successfully',
            batchNumber,
            sapDocEntry: sapResult?.data?.DocEntry || null,
            sapSuccess: sapResult?.success || false,
            dbSuccess: !!dbResult,
            printResult,
            labelsCount: numLabels,
            labelData,
            data: { poNumber, fgQuantity, qcSupervisor }
        });
    } catch (error) {
        console.error('❌ FG Entry error:', error.message);
        res.status(500).json({ error: 'Failed to submit FG entry', message: error.message });
    }
});

/**
 * POST /api/fg-print-labels
 * Print FG labels (after preview or reprint).
 */
/**
 * GET /api/po/:poNum/issued-roles
 * Issued input rolls with remaining qty for report completion.
 */
app.get('/api/po/:poNum/issued-roles', async (req, res) => {
    try {
        const poNum = String(req.params.poNum || '').trim();
        if (!poNum) {
            return res.status(400).json({ error: 'poNum is required' });
        }
        const processTag = String(req.query.process_tag || req.query.process || 'EMB').trim().toUpperCase();
        const roles = await getProcessInputsWithRemaining(poNum, processTag);
        res.json({ success: true, poNum, processTag, roles });
    } catch (error) {
        console.error('❌ /api/po/:poNum/issued-roles:', error.message);
        res.status(500).json({ error: 'Failed to load issued roles', message: error.message });
    }
});

/**
 * GET /api/po/:poNum/process-inputs
 * Inputs for report completion: raw rolls (EMB) or previous-process batches (MET, etc.).
 */
app.get('/api/po/:poNum/process-inputs', async (req, res) => {
    try {
        const poNum = String(req.params.poNum || '').trim();
        const processTag = String(
            req.query.process_tag || req.query.process || req.query.u_p_code || 'EMB'
        ).trim().toUpperCase();
        if (!poNum) {
            return res.status(400).json({ error: 'poNum is required' });
        }
        const fgItemCode = String(req.query.fg_num || req.query.fgItemCode || req.query.item_no || '').trim() || null;
        const resolvedTag = processTag.length <= 4
            ? processTag
            : getUnit1ProcessBatchTag(processTag, null, null, fgItemCode);
        const sourcePoNums = await resolveSourcePOsForProcessInputs(poNum, resolvedTag, fgItemCode);
        const roles = await getProcessInputsWithRemaining(poNum, resolvedTag, fgItemCode, sourcePoNums);
        res.json({ success: true, poNum, processTag: resolvedTag, sourcePoNums, roles });
    } catch (error) {
        console.error('❌ /api/po/:poNum/process-inputs:', error.message);
        res.status(500).json({ error: 'Failed to load process inputs', message: error.message });
    }
});

/**
 * GET /api/peek-unit1-batch
 * Preview next output batch number without saving.
 */
app.get('/api/peek-unit1-batch', async (req, res) => {
    try {
        const poNum = String(req.query.po_num || '').trim();
        const fgNum = String(req.query.fg_num || req.query.item_no || '').trim();
        const jobStart = req.query.job_start_time || null;
        const uPCode = req.query.u_p_code || req.query.uPCode || '';
        const machineName = req.query.machine_name || '';
        if (!fgNum) {
            return res.status(400).json({ error: 'fg_num is required' });
        }
        const processTag = getUnit1ProcessBatchTag(uPCode, null, machineName, fgNum);
        let sapMaxSeq = 0;
        try {
            sapMaxSeq = await getSapMaxItemBatchSeq(fgNum, processTag);
        } catch (_) { /* non-blocking */ }
        const batchNum = await getUnit1BatchNum(fgNum, processTag, poNum, jobStart, sapMaxSeq);
        res.json({ success: true, batch_num: batchNum, process_tag: processTag });
    } catch (error) {
        console.error('❌ /api/peek-unit1-batch:', error.message);
        res.status(500).json({ error: 'Failed to peek batch', message: error.message });
    }
});

/**
 * POST /api/process-print-labels
 * Print process output label (embossing batch + roles used).
 */
app.post('/api/process-print-labels', async (req, res) => {
    try {
        const { labelData, numLabels } = req.body || {};
        const n = Math.ceil(Number(numLabels) || 1);
        if (!labelData || typeof labelData !== 'object') {
            return res.status(400).json({ error: 'labelData object is required' });
        }
        const printResult = await printProcessLabel(labelData, n);
        res.json({ success: printResult.success, printResult });
    } catch (error) {
        console.error('❌ /api/process-print-labels:', error.message);
        res.status(500).json({ error: 'Print failed', message: error.message });
    }
});

app.post('/api/fg-print-labels', async (req, res) => {
    try {
        const { labelData, numLabels } = req.body || {};
        const n = Math.ceil(Number(numLabels));
        if (!labelData || typeof labelData !== 'object' || !Number.isFinite(n) || n < 1) {
            return res.status(400).json({
                error: 'Invalid body',
                message: 'labelData (object) and numLabels (positive integer) are required'
            });
        }
        if (!labelData.itemCodeLabel && labelData.fgCode) {
            labelData.itemCodeLabel = await fetchOscnSubstitute(labelData.fgCode);
        }
        const printResult = await printFGLabels(labelData, n);
        res.json({ success: true, printResult });
    } catch (error) {
        console.error('❌ /api/fg-print-labels:', error.message);
        res.status(500).json({ error: 'Print failed', message: error.message });
    }
});

/**
 * GET /api/fg-last-batch/:poNumber
 * Latest FG batch number saved locally for a PO (for slip reprint).
 */
app.get('/api/fg-last-batch/:poNumber', async (req, res) => {
    try {
        const poNumber = String(req.params.poNumber || '').trim();
        if (!poNumber) {
            return res.status(400).json({ error: 'poNumber is required' });
        }
        const batches = await getBatchesByPO(poNumber);
        const latest = (batches || []).find((b) => b.batch_num) || batches?.[0];
        res.json({
            success: true,
            poNumber,
            batchNumber: latest?.batch_num || ''
        });
    } catch (error) {
        console.error('❌ /api/fg-last-batch:', error.message);
        res.status(500).json({ error: 'Failed to load batch', message: error.message });
    }
});

/**
 * POST /api/fg-label-pdf
 * Multi-page PDF for label preview / browser print.
 */
app.post('/api/fg-label-pdf', async (req, res) => {
    try {
        const { labelData, numLabels } = req.body || {};
        const n = Math.ceil(Number(numLabels));
        if (!labelData || typeof labelData !== 'object' || !Number.isFinite(n) || n < 1) {
            return res.status(400).json({
                error: 'Invalid body',
                message: 'labelData (object) and numLabels (positive integer) are required'
            });
        }
        if (!labelData.itemCodeLabel && labelData.fgCode) {
            labelData.itemCodeLabel = await fetchOscnSubstitute(labelData.fgCode);
        }
        const pdf = await renderLabelsPdfBuffer(labelData, n);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="fg-label.pdf"');
        res.send(pdf);
    } catch (error) {
        console.error('❌ /api/fg-label-pdf:', error.message);
        res.status(500).json({ error: 'PDF render failed', message: error.message });
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    if (browserInstance) await browserInstance.close();
    await logoutSAP();
    await pool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nShutting down server...');
    if (browserInstance) await browserInstance.close();
    await logoutSAP();
    await pool.end();
    process.exit(0);
});

// Static files last — so /api/* routes always return JSON, not HTML assets
app.use(express.static(path.join(__dirname), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
const httpServer = app.listen(PORT, async () => {
    console.log(`\n🚀 SAP Business One API Server running on port ${PORT}`);
    console.log(`📡 SAP Base URL: ${SAP_BASE_URL}`);
    console.log(`🏢 Company DB: ${SAP_COMPANY_DB}`);

    // Test database connection
    const dbOk = await testConnection();

    // Live tracking: ensure tables exist and start the shift auto-logout sweeper
    if (dbOk) {
        try {
            await liveTracking.ensureTables();
            liveTracking.startAutoLogoutSweeper();
            console.log('🟢 Live tracking ready (auto-logout sweeper running)');
        } catch (err) {
            console.error('⚠️  Live tracking setup failed:', err.message);
        }
    }

    console.log(`\nAvailable endpoints:`);
    console.log(`  GET  /api/health`);
    console.log(`  GET  /api/production-order/:docNumber`);
    console.log(`\nMaterial Issue endpoints:`);
    console.log(`  POST /api/issue-material`);
    console.log(`  POST /api/issue-materials-bulk`);
    console.log(`  POST /api/check-availability`);
    console.log(`\nValidation endpoints:`);
    console.log(`  POST /api/validate/job-completion`);
    console.log(`  POST /api/validate/quantities`);
    console.log(`  GET  /api/validate/config`);
    console.log(`\nDatabase endpoints (New Schema):`);
    console.log(`  POST /api/job-complete`);
    console.log(`  GET  /api/activities/batch/:batchNum`);
    console.log(`  GET  /api/batches/po/:poNum`);
    console.log(`  GET  /api/job-summary/:batchNum`);
    console.log(`  GET  /api/shift-summary?machineName=X&date=YYYY-MM-DD&shiftType=day`);
    console.log(`  GET  /api/activities/machine/:machineName/date/:date`);
    console.log(`  PUT  /api/batch/:batchNum`);
    console.log(`  GET  /api/best-performance/:fgNum`);
    console.log(`\nTraceability endpoints:`);
    console.log(`  GET  /api/traceability/by-po/:poNum`);
    console.log(`  GET  /api/traceability/by-batch/:batchNum`);
    console.log(`\nLive tracking endpoints:`);
    console.log(`  POST /api/live/login            (machineId, operator, ...)`);
    console.log(`  POST /api/live/logout           (machineId, reason)`);
    console.log(`  POST /api/live/job-load         (machineId, po, jobName, ...)`);
    console.log(`  POST /api/live/job-unload       (machineId)`);
    console.log(`  POST /api/live/state            (machineId, state)`);
    console.log(`  GET  /api/live/status/:machineId`);
    console.log(`  GET  /api/live/dashboard`);
    console.log(`  GET  /api/live/sessions?date=&shift=&machineId=`);
    console.log(`  GET  /api/live/state-history?machineId=&date=&shift=\n`);
});

httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} is already in use (another server is still running).`);
        console.error(`   Windows: netstat -ano | findstr :${PORT}`);
        console.error(`   Then:    taskkill /PID <pid> /F`);
        console.error(`   Or close the other terminal where npm start is running.\n`);
    } else {
        console.error('❌ Server failed to start:', err.message);
    }
    process.exit(1);
});
