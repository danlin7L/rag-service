//test: check 能不能连上DB
console.log("test-db.js, test: check 能不能连上DB");

import { pool } from './db.js';
const res = await pool.query('SELECT COUNT(*) FROM chunks');
console.log('连接成功，chunks 行数： ',res.rows[0].count);
await pool.end();