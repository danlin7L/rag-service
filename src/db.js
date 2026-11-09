// db 连接池： 所有读写DB的地方都用它
console.log("db.js, db 连接池： 所有读写DB的地方都用它");

import pg from 'pg';
export const pool = new pg.Pool({
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'dev',
    database: 'postgres',
});
pool.on('connect', () => console.log('db.js:连上DB了！'));