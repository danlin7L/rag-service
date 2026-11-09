
// server.js
// 正式服务：提供 /ingest 和 /query 两个接口

import Fastify from 'fastify';
import { ingestDocument } from './ingest.js';
import { search } from './search.js';

const app = Fastify({ logger: true });

// 距离阈值：相关问题约 0.39–0.42，无关问题约 0.64，取中间值
const MAX_DISTANCE = 0.5;
// 关键词覆盖率阈值：相关问题 1.0，无关问题最多 0.4；某块含有问题里 ≥80% 的关键词，也算找到了
// （专有名词如 "Guisachan" 向量距离 0.61 会被误判，但关键词能精确命中）
const MIN_KEYWORD_COVERAGE = 0.8;

// =====================================
// 1. POST /ingest
// 接收文档并存入数据库
// =====================================

app.post('/ingest', async (req, reply) => {
    try {
        const { source, text } = req.body;

        const count = await ingestDocument(source, text);

        return {
            source,
            chunks: count
        };
    } catch (error) {
        req.log.error(error);
        reply.code(500);

        return {
            error: 'Failed to ingest document'
        };
    }
});

// =====================================
// 2. POST /query
// 搜索相关文档，并调用 Llama 生成答案
// =====================================

app.post('/query', async (req, reply) => {
    try {
        const { question } = req.body;

        const chunks = await search(question);
        console.table(chunks.map(c => ({            // 打印每块的距离和两边的名次，看 hybrid 怎么排的
            position: c.position,
            distance: c.distance.toFixed(3),
            vector_rank: c.vector_rank,
            keyword_rank: c.keyword_rank,
            score: Number(c.score).toFixed(4),
            coverage: (c.keyword_coverage ?? 0).toFixed(2)
        })));

        // 结果按 RRF 分数排，第一块不一定最近，所以取最小距离来判断
        const bestDistance = Math.min(...chunks.map(c => c.distance));
        const bestCoverage = Math.max(...chunks.map(c => c.keyword_coverage ?? 0));

        // 意思不够近，关键词也没怎么命中 → 资料里没有答案，直接说不知道，不调用 llama3.1
        const relevant = bestDistance <= MAX_DISTANCE || bestCoverage >= MIN_KEYWORD_COVERAGE;
        if (chunks.length === 0 || !relevant) {
            return {
                answer: "I don't know",
                sources: []
            };
        }

        // Combine retrieved chunks into context
        const context = chunks
            .map(c => c.content)
            .join('\n---\n');

        // Call Ollama API
        const res = await fetch(
            'http://localhost:11434/api/generate',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'llama3.1',
                    prompt: `Answer only using the context below. Context:${context}  Question: ${question}`,
                    stream: false
                })
            }
        );

        if (!res.ok) {
            throw new Error(`Ollama API error: ${res.status}`);
        }

        const data = await res.json();

        return {
            answer: data.response,
            sources: chunks.map(c => ({
                source: c.source,
                position: c.position
            }))
        };

    } catch (error) {
        req.log.error(error);
        reply.code(500);

        return {
            error: 'Failed to process query'
        };
    }
});

// =====================================
// 3. Start Fastify server
// =====================================

try {
    await app.listen({
        port: 3000,
        host: '0.0.0.0'
    });

    console.log('Server running at http://localhost:3000');

} catch (error) {
    app.log.error(error);
    process.exit(1);
}
