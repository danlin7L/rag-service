//找资料：把问题变成向量，找出最接近的5块
import { pool } from './db.js';
import { embed } from './embed.js';
export async function search(question, k = 5){
    console.log("search.js, 找资料：把问题变成向量，找出最接近的5块");

    const vector = await embed(question);
    const res = await pool.query(
        `SELECT source, position, content FROM chunks ORDER BY embedding <=> $1 LIMIT $2`,
        [JSON.stringify(vector), k]
    );
    return res.rows;
}