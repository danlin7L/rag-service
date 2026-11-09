
// server.js
// 正式服务：提供 /ingest、/query 和 /query/stream 接口
// 摄取是异步的：要同时运行 node src/worker.js，否则任务只会排队不会被处理

import Fastify from 'fastify';
import { ingestQueue } from './queue.js';
import { retrieve, generate, generateStream, IDK_ANSWER } from './rag.js';
import { getCachedAnswer, setCachedAnswer } from './cache.js';

const app = Fastify({ logger: true });

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
// 搜索相关文档，并调用 Llama 生成答案（等全部生成完再一次性返回）
// =====================================

app.post('/query', async (req, reply) => {
    try {
        const { question } = req.body;

        // 先查缓存：问过的问题直接返回，省掉 embed + 搜索 + llama3.1（几秒 → 几毫秒）
        const cached = await getCachedAnswer(question);
        if (cached) {
            return { ...cached, cached: true };
        }

        const { chunks, relevant, sources } = await retrieve(question);

        // 资料里没有答案 → 直接说不知道，不调用 llama3.1
        const answer = relevant ? await generate(question, chunks) : IDK_ANSWER;

        const result = { answer, sources };
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
// 2b. GET /query/stream?question=...
// SSE（Server-Sent Events）：llama3.1 生成一点就推一点，不用干等十几秒
// 用 GET 是因为浏览器自带的 EventSource 只支持 GET
//
// 推送的事件依次是：
//   event: sources  data: [{"source":...,"position":...}]   先告诉你用了哪些资料
//   event: token    data: {"text":"Yes"}                     答案的一小段，会有很多个
//   event: done     data: {"cached":false}                   结束
//   event: error    data: {"error":"..."}                    出错（之后连接关闭）
// =====================================

// SSE 的格式：每条消息是 "event: 名字\ndata: 内容\n\n"（空行表示一条消息结束）
// data 统一用 JSON：答案里可能有换行，原样写进去会把消息格式弄乱
function sseSend(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.get('/query/stream', async (req, reply) => {
    const question = req.query.question;
    if (typeof question !== 'string' || !question.trim()) {
        reply.code(400);
        return { error: 'question query parameter is required' };
    }

    // 接管原始的 Node response，Fastify 不再自动发送返回值；之后自己 write / end
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',   // 别缓存，每次都是新的流
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'      // 前面有 nginx 的话，让它别攒着不发
    });

    // 客户端中途关掉（关网页、Ctrl+C）→ 取消 Ollama 请求，别让它继续白白生成
    // 注意要监听 res 的 close，不是 req 的：GET 请求读完就会触发 req 的 close
    const abort = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) {
            req.log.info('客户端断开了，取消生成');
            abort.abort();
        }
    });

    try {
        // 缓存命中：一次把整个答案推过去
        const cached = await getCachedAnswer(question);
        if (cached) {
            sseSend(res, 'sources', cached.sources);
            sseSend(res, 'token', { text: cached.answer });
            sseSend(res, 'done', { cached: true });
            return res.end();
        }

        const { chunks, relevant, sources } = await retrieve(question);
        sseSend(res, 'sources', sources);

        let answer = '';
        if (!relevant) {
            answer = IDK_ANSWER;
            sseSend(res, 'token', { text: answer });
        } else {
            for await (const text of generateStream(question, chunks, abort.signal)) {
                answer += text;
                sseSend(res, 'token', { text });
            }
        }

        // 完整答案拼好后存缓存：下次 /query 和 /query/stream 都能用
        await setCachedAnswer(question, { answer, sources });
        sseSend(res, 'done', { cached: false });
        res.end();

    } catch (error) {
        if (abort.signal.aborted) return;   // 客户端自己走了，不用报错，也不缓存半截答案
        req.log.error(error);
        sseSend(res, 'error', { error: 'Failed to process query' });
        res.end();
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
