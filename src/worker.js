// worker：从队列里取 /ingest 任务，一个一个处理
// 单独运行：node src/worker.js（和 server.js 是两个进程，可以开多个 worker）
import { Worker } from 'bullmq';
import { QUEUE_NAME, connection } from './queue.js';
import { ingestDocument } from './ingest.js';
import { pool } from './db.js';
import { closeCache } from './cache.js';

function describeError(err) {
    if (err.message) return err.message;
    if (err.errors?.length) return err.errors.map(e => e.message || e.code).join('; ');  // AggregateError
    return err.code || err.name || String(err);
}

const worker = new Worker(
    QUEUE_NAME,
    async job => {
        const { source, text } = job.data;
        console.log(`worker.js: 开始任务 ${job.id}（${source}，第 ${job.attemptsMade + 1} 次）`);

        try {
            const count = await ingestDocument(source, text, async (done, total) => {
                await job.updateProgress(Math.round(done / total * 100));  // 0~100，GET /ingest/:id 能看到
            });
            return { source, chunks: count };   // 返回值会存成任务的 returnvalue
        } catch (err) {
            // 有些错误 message 是空的（比如连不上数据库时的 AggregateError），换成能看懂的再抛出，
            // 这样日志和 GET /ingest/:id 的 error 字段里才有原因
            throw new Error(describeError(err));
        }
    },
    {
        connection,
        concurrency: 1   // 一次只处理一个：Ollama 本地跑，同时 embed 好几篇也不会更快
    }
);

worker.on('completed', (job, result) => console.log(`worker.js: 任务 ${job.id} 完成：${result.chunks} 块`));
worker.on('failed', (job, err) => console.error(`worker.js: 任务 ${job?.id} 失败（第 ${job?.attemptsMade} 次）：${err.message}`));

console.log('worker.js: 等待 ingest 任务……');

// Ctrl+C 时先把手上的任务做完再退出，不留下半个任务
async function shutdown() {
    console.log('worker.js: 正在退出，等当前任务做完……');
    await worker.close();
    await pool.end();
    await closeCache();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
