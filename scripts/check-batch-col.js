require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../db-config');

(async () => {
    await db.ensureSchema();
    const prefix = db.buildUnit1BatchPrefix('PBP-12-1003-ALO-EMB', 'EMB');
    console.log('prefix:', prefix + '001');
    const [rows] = await db.pool.query(
        `SELECT character_maximum_length AS len FROM information_schema.columns
         WHERE table_name = 'production_records' AND column_name = 'batch_num'`
    );
    console.log('batch_num max len:', rows[0]?.len);
    await db.pool.end();
})();
