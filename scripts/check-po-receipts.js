require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });

(async () => {
    const login = await axios.post(`${process.env.SAP_BASE_URL}/Login`, {
        CompanyDB: process.env.SAP_COMPANY_DB,
        UserName: process.env.SAP_USERNAME,
        Password: process.env.SAP_PASSWORD
    }, { httpsAgent: agent });
    const h = { 'B1S-SessionId': login.data.SessionId, Cookie: login.headers['set-cookie']?.join('; ') };

    for (const ae of [141549, 141550]) {
        const code = `POReceipt_${ae}_${Date.now()}`;
        await axios.post(`${process.env.SAP_BASE_URL}/SQLQueries`, {
            SqlCode: code,
            SqlName: code,
            SqlText: `SELECT T0."DocEntry", T1."Quantity", T1."ItemCode" FROM OIGN T0 INNER JOIN IGN1 T1 ON T0."DocEntry" = T1."DocEntry" WHERE T1."BaseType" = 202 AND T1."BaseEntry" = ${ae}`
        }, { headers: h, httpsAgent: agent });
        const rows = await axios.get(`${process.env.SAP_BASE_URL}/SQLQueries('${code}')/List`, { headers: h, httpsAgent: agent });
        console.log('AbsoluteEntry', ae, rows.data.value);
        axios.delete(`${process.env.SAP_BASE_URL}/SQLQueries('${code}')`, { headers: h, httpsAgent: agent }).catch(() => {});
    }
})().catch((e) => console.error(e.response?.data || e.message));
