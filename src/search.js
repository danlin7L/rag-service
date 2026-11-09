//找资料（hybrid）：向量搜索 + 关键词搜索，两份排名用 RRF 合并，取前5块
import { pool } from './db.js';
import { embed } from './embed.js';

const CANDIDATES = 20;  // 每种搜索各取前 20 名，再合并
const RRF_K = 60;       // RRF 常数：分数 = 1/(60+名次)，60 是论文里的常用值

export async function search(question, k = 5){
    console.log("search.js, 找资料：向量搜索 + 关键词搜索，用 RRF 合并，取前5块");

    const vector = await embed(question);
    const res = await pool.query(
        `WITH
         -- 1. 向量搜索：意思相近（同义词、换个说法也能找到）
         vec AS (
           SELECT id, row_number() OVER (ORDER BY embedding <=> $1) AS rank
           FROM chunks
           ORDER BY embedding <=> $1
           LIMIT $4
         ),
         -- 2. 关键词搜索：字面匹配（名字、型号、专有名词更准）
         --    websearch_to_tsquery 默认是 AND（所有词都要出现），太严；把 & 换成 |，变成 OR
         --    第二步要用 'simple'：websearch_to_tsquery 已经取过词根了，再用 'english' 会取第二次，
         --    比如 response → respons → respon，就和存的 'respons' 对不上了（'simple' 只转小写，不改词）
         q AS (
           SELECT to_tsquery('simple', replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')) AS query
         ),
         -- 问题里的关键词列表，例如 {drawer,fit,new,older,unit}
         qw AS (
           SELECT tsvector_to_array(to_tsvector('english', $2)) AS words
         ),
         kw AS (
           SELECT id, row_number() OVER (ORDER BY ts_rank(content_tsv, q.query) DESC) AS rank
           FROM chunks, q
           WHERE content_tsv @@ q.query
           ORDER BY ts_rank(content_tsv, q.query) DESC
           LIMIT $4
         )
         -- 3. RRF：两边名次各换算成分数再相加；只出现在一边的，另一边算 0
         SELECT c.source, c.position, c.content,
                c.embedding <=> $1 AS distance,
                vec.rank AS vector_rank,
                kw.rank  AS keyword_rank,
                COALESCE(1.0 / ($5 + vec.rank), 0) + COALESCE(1.0 / ($5 + kw.rank), 0) AS score,
                -- 关键词覆盖率：问题里的关键词（去掉停用词、取词根后），这块命中了几成；0~1
                --   "Guisachan" → 1/1 = 1.0；"Will a new drawer fit an older unit?" 只命中 "new" → 1/5 = 0.2
                (SELECT count(*) FROM unnest(qw.words) w WHERE w = ANY (tsvector_to_array(c.content_tsv)))::float
                  / NULLIF(cardinality(qw.words), 0) AS keyword_coverage
         FROM vec
         FULL OUTER JOIN kw ON vec.id = kw.id
         JOIN chunks c ON c.id = COALESCE(vec.id, kw.id)
         CROSS JOIN qw
         ORDER BY score DESC
         LIMIT $3`,
        [JSON.stringify(vector), question, k, CANDIDATES, RRF_K]
    );
    return res.rows;
}
