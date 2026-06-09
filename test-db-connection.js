// Quick database connection test
const mysql = require('mysql2/promise');
const path = require('path');

// Load .env from same directory
const envPath = path.join(__dirname, '.env');
console.log('📁 Loading .env from:', envPath);
require('dotenv').config({ path: envPath });

// Show configuration
console.log('\n🔧 Database Configuration:');
console.log('   DB_HOST:', process.env.DB_HOST || '(not set)');
console.log('   DB_PORT:', process.env.DB_PORT || '3306');
console.log('   DB_USER:', process.env.DB_USER || '(not set)');
console.log('   DB_PASSWORD:', process.env.DB_PASSWORD ? '****' + process.env.DB_PASSWORD.slice(-4) : '(EMPTY!)');
console.log('   DB_NAME:', process.env.DB_NAME || '(not set)');

// Test connection
async function testConnection() {
    console.log('\n🔌 Testing connection...');
    
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'sap',
            connectTimeout: 5000
        });
        
        console.log('✅ SUCCESS! Database connected!');
        
        // Test query
        const [rows] = await connection.query('SELECT 1 as test');
        console.log('✅ Query test passed:', rows);
        
        await connection.end();
    } catch (error) {
        console.error('\n❌ CONNECTION FAILED!');
        console.error('   Error:', error.message);
        console.error('   Code:', error.code);
        
        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('\n💡 FIX: Wrong username or password');
            console.error('   Check your .env file has correct credentials');
        } else if (error.code === 'ECONNREFUSED') {
            console.error('\n💡 FIX: MySQL server not accepting connections');
            console.error('   - Is MySQL running?');
            console.error('   - Is it listening on the right host/port?');
        } else if (error.code === 'ENOTFOUND') {
            console.error('\n💡 FIX: Host not found');
            console.error('   Check DB_HOST in .env file');
        }
    }
}

testConnection();

