/**
 * Set default bin for all coating FG items in warehouse OHJW-U1.
 * Usage: node scripts/setup-coating-bins-ohjw-u1.js
 *        node scripts/setup-coating-bins-ohjw-u1.js PBP-12-1003-ALO-COT
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');

const SAP_BASE_URL = process.env.SAP_BASE_URL || 'https://192.168.3.6:50000/b1s/v1';
const WAREHOUSE = 'OHJW-U1';
const sapHttpsAgent = new https.Agent({ rejectUnauthorized: process.env.SAP_SSL_VERIFY !== 'false' });

let session = null;

async function login() {
    const res = await axios.post(
        `${SAP_BASE_URL}/Login`,
        {
            CompanyDB: process.env.SAP_COMPANY_DB,
            UserName: process.env.SAP_USERNAME,
            Password: process.env.SAP_PASSWORD
        },
        { httpsAgent: sapHttpsAgent }
    );
    session = {
        sessionId: res.data.SessionId,
        cookie: res.headers['set-cookie']?.join('; ')
    };
}

function headers() {
    const h = { 'Content-Type': 'application/json', 'B1S-SessionId': session.sessionId };
    if (session.cookie) h.Cookie = session.cookie;
    return h;
}

async function sapGet(path) {
    const res = await axios.get(`${SAP_BASE_URL}${path}`, { headers: headers(), httpsAgent: sapHttpsAgent });
    return res.data;
}

async function sapPatch(path, body) {
    await axios.patch(`${SAP_BASE_URL}${path}`, body, { headers: headers(), httpsAgent: sapHttpsAgent });
}

async function sapPost(path, body) {
    const res = await axios.post(`${SAP_BASE_URL}${path}`, body, { headers: headers(), httpsAgent: sapHttpsAgent });
    return res.data;
}

async function runSql(sqlText, label) {
    const code = `${label}_${Date.now()}`;
    await sapPost('/SQLQueries', { SqlCode: code, SqlName: code, SqlText: sqlText });
    const result = await sapGet(`/SQLQueries('${code}')/List`);
    axios.delete(`${SAP_BASE_URL}/SQLQueries('${code}')`, { headers: headers(), httpsAgent: sapHttpsAgent }).catch(() => {});
    return result?.value || [];
}

async function listBins() {
    const rows = await runSql(
        `SELECT T0."AbsEntry", T0."BinCode", T0."WhsCode" FROM OBIN T0 WHERE T0."WhsCode" = '${WAREHOUSE}' ORDER BY T0."BinCode"`,
        'list_bins'
    );
    return rows.map((r) => ({
        absEntry: Number(r.AbsEntry ?? r.ABSENTRY ?? r.absEntry),
        binCode: r.BinCode ?? r.BINCODE ?? r.binCode
    }));
}

async function listCoatingItems(explicitCodes) {
    if (explicitCodes.length > 0) return explicitCodes;
    const rows = await runSql(
        `SELECT T0."ItemCode" FROM OITM T0 WHERE T0."ItemCode" LIKE '%-COT' AND T0."validFor" = 'Y' ORDER BY T0."ItemCode"`,
        'coating_items'
    );
    return rows.map((r) => r.ItemCode ?? r.ITEMCODE ?? r.itemCode).filter(Boolean);
}

async function getItemWarehouseRow(itemCode) {
    const k = encodeURIComponent(itemCode);
    const data = await sapGet(`/Items('${k}')?$select=ItemCode,ItemWarehouseInfoCollection`);
    return (data?.ItemWarehouseInfoCollection || []).find((w) => w.WarehouseCode === WAREHOUSE) || null;
}

async function ensureItemInWarehouse(itemCode, binAbsEntry, binCode) {
    const k = encodeURIComponent(itemCode);
    const existing = await getItemWarehouseRow(itemCode);

    if (existing) {
        const currentBin = Number(existing.DefaultBin ?? existing.defaultBin ?? 0);
        if (currentBin > 0) {
            console.log(`   ✅ ${itemCode} — already DefaultBin AbsEntry=${currentBin}`);
            return { itemCode, action: 'skipped', defaultBin: currentBin };
        }
        const allWh = (await sapGet(`/Items('${k}')?$select=ItemWarehouseInfoCollection`)).ItemWarehouseInfoCollection;
        const updated = allWh.map((w) => {
            if (w.WarehouseCode !== WAREHOUSE) return { WarehouseCode: w.WarehouseCode };
            return { WarehouseCode: WAREHOUSE, DefaultBin: binAbsEntry };
        });
        await sapPatch(`/Items('${k}')`, { ItemWarehouseInfoCollection: updated });
        console.log(`   ✅ ${itemCode} — DefaultBin AbsEntry=${binAbsEntry} (${binCode})`);
        return { itemCode, action: 'updated', defaultBin: binAbsEntry };
    }

    await sapPatch(`/Items('${k}')`, {
        ItemWarehouseInfoCollection: [{ WarehouseCode: WAREHOUSE, DefaultBin: binAbsEntry }]
    });
    console.log(`   ✅ ${itemCode} — warehouse added, DefaultBin AbsEntry=${binAbsEntry} (${binCode})`);
    return { itemCode, action: 'created', defaultBin: binAbsEntry };
}

async function main() {
    const explicit = process.argv.slice(2).filter(Boolean);
    await login();

    console.log(`\n📦 Warehouse: ${WAREHOUSE}`);
    const bins = await listBins();
    if (bins.length === 0) {
        console.error(`❌ No bins in ${WAREHOUSE}. Create bin locations in SAP first.`);
        process.exit(1);
    }
    console.log(`   Bins: ${bins.map((b) => b.binCode).join(', ')}`);
    const pick = bins.find((b) => !String(b.binCode).includes('SYSTEM')) || bins[0];
    console.log(`   Using: ${pick.binCode} (AbsEntry ${pick.absEntry})\n`);

    const items = await listCoatingItems(explicit);
    if (items.length === 0) {
        console.error('❌ No coating items (ItemCode ending with -COT)');
        process.exit(1);
    }
    console.log(`🎨 Items (${items.length}):`);
    items.forEach((ic) => console.log(`   - ${ic}`));

    const results = [];
    for (const itemCode of items) {
        try {
            results.push(await ensureItemInWarehouse(itemCode, pick.absEntry, pick.binCode));
        } catch (err) {
            const msg = err.response?.data?.error?.message?.value || err.message;
            console.error(`   ❌ ${itemCode}: ${msg}`);
            results.push({ itemCode, action: 'failed', error: msg });
        }
    }

    console.log('\n--- Summary ---');
    console.log(`OK: ${results.filter((r) => r.action !== 'failed').length}/${results.length}`);
    process.exit(results.some((r) => r.action === 'failed') ? 1 : 0);
}

main().catch((e) => {
    console.error(e.response?.data || e.message);
    process.exit(1);
});
