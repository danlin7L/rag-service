
// server.js
// 正式服务：提供 /ingest 和 /query 两个接口
// 摄取是异步的：要同时运行 node src/worker.js，否则任务只会排队不会被处理

import Fastify from 'fastify';
import { ingestQueue } from './queue.js';
import { search } from './search.js';
import { getCachedAnswer, setCachedAnswer } from './cache.js';

const app = Fastify({ logger: true });

// 距离阈值：相关问题约 0.39–0.42，无关问题约 0.64，取中间值
const MAX_DISTANCE = 0.5;
// 关键词覆盖率阈值：相关问题 1.0，无关问题最多 0.4；某块含有问题里 ≥80% 的关键词，也算找到了
// （专有名词如 "Guisachan" 向量距离 0.61 会被误判，但关键词能精确命中）
const MIN_KEYWORD_COVERAGE = 0.8;

// =====================================
// 1. POST /ingest
// 把文档放进队列，马上返回任务 id；worker.js 在后台切块、embed、存库
// =====================================

app.post('/ingest', async (req, reply) => {
    try {
        const { source, text } = req.body ?? {};

        // 在入队前就检查：坏数据进了队列只会失败 3 次，白白浪费重试
        if (typeof source !== 'string' || !source || typeof text !== 'string' || !text) {
            reply.code(400);
            return { error: 'source and text are required strings' };
        }

        const job = await ingestQueue.add('ingest', { source, text });

        reply.code(202);   // 202 Accepted：收到了，但还没处理完
        return {
            jobId: job.id,
            status: 'queued',
            statusUrl: `/ingest/${job.id}`
        };
    } catch (error) {
        req.log.error(error);
        reply.code(500);

        return {
            error: 'Failed to queue document'
        };
    }
});

// =====================================
// 1b. GET /ingest/:id
// 查任务状态：waiting / active / completed / failed / delayed（等待重试）
// =====================================

app.get('/ingest/:id', async (req, reply) => {
    const job = await ingestQueue.getJob(req.params.id);
    if (!job) {
        reply.code(404);
        return { error: 'Job not found (unknown id, or already cleaned up)' };
    }

    const status = await job.getState();
    return {
        jobId: job.id,
        source: job.data.source,
        status,
        progress: job.progress,          // 0~100
        attempts: job.attemptsMade,
        result: job.returnvalue ?? null, // 完成后：{ source, chunks }
        // 失败或等待重试时：最后一次的错误信息。重试成功后就不显示了（旧错误已经不重要）
        error: status === 'failed' || status === 'delayed' ? job.failedReason ?? null : null
    };
});

// =====================================
// 2. POST /query
// 搜索相关文档，并调用 Llama 生成答案
// =====================================

app.post('/query', async (req, reply) => {
    try {
        const { question } = req.body;

        // 先查缓存：问过的问题直接返回，省掉 embed + 搜索 + llama3.1（几秒 → 几毫秒）
        const cached = await getCachedAnswer(question);
        if (cached) {
            return { ...cached, cached: true };
        }

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
            const result = {
                answer: "I don't know",
                sources: []
            };
            await setCachedAnswer(question, result);   // "不知道" 也缓存，下次不用再 embed + 搜索
            return { ...result, cached: false };
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

        const result = {
            answer: data.response,
            sources: chunks.map(c => ({
                source: c.source,
                position: c.position
            }))
        };
        await setCachedAnswer(question, result);       // 只缓存成功的答案；出错走 catch，不会被缓存
        return { ...result, cached: false };

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
        port: Number(process.env.PORT) || 3000,   // 默认 3000；PORT=3001 node src/server.js 可以换端口
        host: '0.0.0.0'
    });

    console.log(`Server running at http://localhost:${Number(process.env.PORT) || 3000}`);

} catch (error) {
    app.log.error(error);
    process.exit(1);
}
