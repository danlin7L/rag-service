//存资料：切块 -> 变向量 -> 存进chunks表

import { pool } from './db.js';
import { chunkText } from './chunker.js';
import { embed } from './embed.js';

export async function ingestDocument(source, text){
    console.log("ingest.js, 存资料：切块 -> 变向量 -> 存进chunks表");

    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
        const vector = await embed(chunks[i]);
        await pool.query( 
            `INSERT INTO chunks (source, position, content, embedding) VALUES ($1, $2, $3, $4)`,
            [source, i , chunks[i], JSON.stringify(vector)]
        );
    }
    return chunks.length;
}