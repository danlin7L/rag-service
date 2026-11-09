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
// 空闲连接断了（比如 Postgres 重启）时 pg 会发出 error 事件；没人监听的话 Node 会直接让整个进程崩溃
// 打个日志就行：坏掉的连接会被丢掉，下次查询时连接池自动建新连接
pool.on('error', err => console.error('db.js: 空闲连接出错（已丢弃）：', err.message));
