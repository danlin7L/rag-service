//存资料：切块 -> 变向量 -> 存进chunks表

import { pool } from './db.js';
import { chunkText } from './chunker.js';
import { embed } from './embed.js';
import { clearAnswerCache } from './cache.js';

// onProgress(done, total)：每算完一块向量就报告一次，worker 用它更新任务进度
export async function ingestDocument(source, text, onProgress = () => {}){
    console.log("ingest.js, 存资料：切块 -> 变向量 -> 存进chunks表");

    const chunks = chunkText(text);

    // 1. 先把所有块的向量都算好（最慢的一步）。这时还没动数据库，
    //    中途失败的话旧数据完好无损，任务重试时从头再来就行
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
        vectors.push(await embed(chunks[i]));
        await onProgress(i + 1, chunks.length);
    }

    // 2. 删旧的 + 插新的 放在一个事务里：要么全部成功，要么全部不算
    //    查询的人只会看到“完整的旧版本”或“完整的新版本”，不会看到一半
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM chunks WHERE source = $1', [source]);
        for (let i = 0; i < chunks.length; i++) {
            await client.query(
                `INSERT INTO chunks (source, position, content, embedding) VALUES ($1, $2, $3, $4)`,
                [source, i, chunks[i], JSON.stringify(vectors[i])]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    // 资料变了，缓存里的旧答案可能已经不对了 → 全部清掉
    const cleared = await clearAnswerCache();
    console.log(`ingest.js: 清掉了 ${cleared} 条缓存的答案`);

    return chunks.length;
}
