//存资料：切块 -> 变向量 -> 存进chunks表

import { pool } from './db.js';
import { chunkText } from './chunker.js';
import { embed } from './embed.js';
import { clearAnswerCache } from './cache.js';
export async function ingestDocument(source, text){
    await pool.query('DELETE FROM chunks WHERE source = $1', [source]); 

    console.log("ingest.js, 存资料：切块 -> 变向量 -> 存进chunks表");

    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
        const vector = await embed(chunks[i]);
        await pool.query( 
            `INSERT INTO chunks (source, position, content, embedding) VALUES ($1, $2, $3, $4)`,
            [source, i , chunks[i], JSON.stringify(vector)]
        );
    }

    // 资料变了，缓存里的旧答案可能已经不对了 → 全部清掉
    const cleared = await clearAnswerCache();
    console.log(`ingest.js: 清掉了 ${cleared} 条缓存的答案`);

    return chunks.length;
}