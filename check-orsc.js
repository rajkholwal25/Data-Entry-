require('dotenv').config();
const axios = require('axios');
const https = require('https');

const SAP_BASE_URL = process.env.SAP_BASE_URL || 'https://192.168.3.6:50000/b1s/v1';
const agent = new https.Agent({ rejectUnauthorized: false });

const codes = [
    'EMB-01', 'EMB-02', 'EMB-03',
    'REW-01', 'REW-02',
    'SLT-01', 'SLT-02',
    'MET-01',
    'RWD-01', 'MLT-01' // old codes for comparison
];

async function main() {
    const login = await axios.post(
        `${SAP_BASE_URL}/Login`,
        {
            CompanyDB: process.env.SAP_COMPANY_DB,
            UserName: process.env.SAP_USERNAME,
            Password: process.env.SAP_PASSWORD
        },
        { headers: { 'Content-Type': 'application/json' }, httpsAgent: agent }
    );

    const headers = {
        'Content-Type': 'application/json',
        'B1S-SessionId': login.data.SessionId
    };
    if (login.headers['set-cookie']) {
        headers.Cookie = login.headers['set-cookie'].join('; ');
    }

    console.log('SAP login OK — company:', process.env.SAP_COMPANY_DB);
    console.log('');

    async function checkResource(code) {
        const k = code.replace(/'/g, "''");
        const endpoints = [
            `/Resources('${k}')`,
            `/Resources?$filter=Code eq '${k}'&$top=1`,
            `/Resources?$filter=VisResourceCode eq '${k}'&$top=1`
        ];

        for (const ep of endpoints) {
            try {
                const r = await axios.get(`${SAP_BASE_URL}${ep}`, { headers, httpsAgent: agent });
                const d = r.data;
                const row = d.Code ? d : (d.value && d.value[0]) || null;
                if (row) {
                    return {
                        found: true,
                        code: row.Code || row.VisResourceCode || code,
                        name: row.Name || row.ResourceName || ''
                    };
                }
            } catch (e) {
                if (e.response && e.response.status === 404) continue;
            }
        }
        return { found: false };
    }

    for (const c of codes) {
        const res = await checkResource(c);
        const tag = res.found ? `FOUND${res.name ? ` (${res.name})` : ''}` : 'NOT FOUND';
        console.log(`${c.padEnd(8)} → ${tag}`);
    }

    console.log('\n--- Resources in SAP matching EMB/REW/SLT/MET/RWD/MLT ---');
    try {
        const list = await axios.get(
            `${SAP_BASE_URL}/Resources?$select=Code,Name&$top=500`,
            { headers, httpsAgent: agent }
        );
        const rows = (list.data.value || []).filter(r =>
            /^(EMB|REW|SLT|MET|RWD|MLT)-/i.test(String(r.Code || ''))
        );
        rows.sort((a, b) => String(a.Code).localeCompare(String(b.Code)));
        rows.forEach(r => console.log(`  ${r.Code} | ${r.Name || ''}`));
        if (rows.length === 0) console.log('  (none found via /Resources list)');
    } catch (e) {
        console.log('List failed:', e.response?.status, e.response?.data?.error?.message?.value || e.message);
    }

    // Query ORSC table directly (SAP HANA/SQL)
    console.log('\n--- ORSC table (SQL) — codes like EMB/REW/SLT/MET ---');
    try {
        const queryCode = `ORSC_CHK_${Date.now()}`;
        await axios.post(
            `${SAP_BASE_URL}/SQLQueries`,
            {
                SqlCode: queryCode,
                SqlName: `ORSC check ${Date.now()}`,
                SqlText: `SELECT "ResCode", "ResName" FROM ORSC WHERE "ResCode" LIKE 'EMB-%' OR "ResCode" LIKE 'REW-%' OR "ResCode" LIKE 'SLT-%' OR "ResCode" LIKE 'MET-%' OR "ResCode" LIKE 'RWD-%' OR "ResCode" LIKE 'MLT-%' ORDER BY "ResCode"`
            },
            { headers, httpsAgent: agent }
        );
        const sqlRes = await axios.get(`${SAP_BASE_URL}/SQLQueries('${queryCode}')/List`, { headers, httpsAgent: agent });
        const sqlRows = sqlRes.data.value || [];
        if (sqlRows.length === 0) {
            console.log('  (no rows — ORSC may use different code format)');
        } else {
            sqlRows.forEach(r => console.log(`  ${r.ResCode} | ${r.ResName || ''}`));
        }
        await axios.delete(`${SAP_BASE_URL}/SQLQueries('${queryCode}')`, { headers, httpsAgent: agent }).catch(() => {});
    } catch (e) {
        console.log('SQL ORSC query failed:', e.response?.status, e.response?.data?.error?.message?.value || e.message);
    }

    // Broader: any ORSC starting with E, R, S, M
    console.log('\n--- ORSC table — first 50 resources ---');
    try {
        const queryCode2 = `ORSC_ALL_${Date.now()}`;
        await axios.post(
            `${SAP_BASE_URL}/SQLQueries`,
            {
                SqlCode: queryCode2,
                SqlName: `ORSC all ${Date.now()}`,
                SqlText: `SELECT "ResCode", "ResName" FROM ORSC WHERE UPPER("ResCode") LIKE '%EMB%' OR UPPER("ResCode") LIKE '%REW%' OR UPPER("ResCode") LIKE '%SLT%' OR UPPER("ResCode") LIKE '%MET%' OR UPPER("ResName") LIKE '%EMBOSS%' OR UPPER("ResName") LIKE '%REWIND%' OR UPPER("ResName") LIKE '%SLIT%' OR UPPER("ResName") LIKE '%METALL%' ORDER BY "ResCode"`
            },
            { headers, httpsAgent: agent }
        );
        const sqlRes2 = await axios.get(`${SAP_BASE_URL}/SQLQueries('${queryCode2}')/List`, { headers, httpsAgent: agent });
        (sqlRes2.data.value || []).forEach(r => console.log(`  ${r.ResCode} | ${r.ResName || ''}`));
        await axios.delete(`${SAP_BASE_URL}/SQLQueries('${queryCode2}')`, { headers, httpsAgent: agent }).catch(() => {});
    } catch (e) {
        console.log('SQL list failed:', e.response?.status, e.response?.data?.error?.message?.value || e.message);
    }

    await axios.post(`${SAP_BASE_URL}/Logout`, {}, { headers, httpsAgent: agent }).catch(() => {});
}

main().catch(e => {
    console.error('ERR', e.response?.status, JSON.stringify(e.response?.data || e.message));
    process.exit(1);
});
