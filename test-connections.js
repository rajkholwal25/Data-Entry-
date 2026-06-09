const mysql = require('mysql2/promise');

const configs = [
    { label: 'Localhost (SAP User)', host: 'localhost', user: 'sap', password: 'vkgp_123', database: 'sap' },
    { label: 'Localhost (Root User)', host: 'localhost', user: 'root', password: '', database: 'sap' },
    { label: 'Remote 3.4 (SAP User)', host: '192.168.3.4', user: 'sap', password: 'vkgp_123', database: 'sap' },
    { label: 'Remote 3.12 (Root User)', host: '192.168.3.12', user: 'root', password: 'hapWup-pagvy0-dowqeb', database: 'sap' }
];

async function testAll() {
    console.log('🔍 Testing Database Connections...\n');

    for (const config of configs) {
        process.stdout.write(`Testing ${config.label} (${config.host})... `);
        try {
            const conn = await mysql.createConnection({
                host: config.host,
                user: config.user,
                password: config.password,
                database: config.database,
                connectTimeout: 3000
            });
            console.log('✅ SUCCESS!');
            await conn.end();

            console.log('\n✨ FOUND WORKING CONFIGURATION!');
            console.log(`Host: ${config.host}`);
            console.log(`User: ${config.user}`);
            console.log(`Password: ${config.password}`);
            console.log('\nUse these details in your .env file.');
            return;
        } catch (err) {
            console.log('❌ FAILED');
            console.log(`   ${err.message}`);
        }
    }

    console.log('\n⚠️  No working connection found. Please check:');
    console.log('1. IS MySQL Server running?');
    console.log('2. Are these IPs reachable?');
    console.log('3. Are credentials correct?');
}

testAll();
