//入口：读docs文件夹里的所有文章并存进DB

import fs from 'fs/promises';
import path from 'path';
import { ingestDocument } from './ingest.js';
import { pool } from './db.js';
import { closeCache } from './cache.js';

const files = await fs.readdir('docs');
for (const file of files) {
    console.log("run-ingest.js, 入口：读docs文件夹里的所有文章并存进DB");

    const text = await fs.readFile(path.join('docs',file), 'utf8');
    const count = await ingestDocument(file, text);
    console.log(`${file}: 存入 ${count}块`);
}
await pool.end();
await closeCache();   // 关掉 Redis 连接，否则脚本不会退出
