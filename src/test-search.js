//test: check检索结果准不准

import { search } from './search.js';
import { pool } from './db.js';
const question = 'Do golden retrievers excel in dog sports?';
console.log("test-search.js, test: check检索结果准不准");

const results = await search(question);
for (const r of results) {

    console.log(`${r.source} 第 ${r.position} 块：`, r.content.slice(0,100));
}
await pool.end();
