// 队列：/ingest 不再当场处理，而是把任务放进 Redis 里的队列，马上返回
// 真正干活的是 worker.js（另一个进程），这样 server 不会被几分钟的 embed 卡住
import { Queue } from 'bullmq';

export const QUEUE_NAME = 'ingest';

// BullMQ 要求 maxRetriesPerRequest: null：Redis 断线时一直等，而不是让命令报错
export const connection = { host: 'localhost', port: 6379, maxRetriesPerRequest: null };

export const ingestQueue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
        attempts: 3,                                     // 失败了最多跑 3 次（比如 Ollama 临时挂了）
        backoff: { type: 'exponential', delay: 5000 },   // 重试前等 5s、10s……
        removeOnComplete: { age: 24 * 3600, count: 1000 }, // 完成的任务留 1 天，最多 1000 个，方便查状态
        removeOnFail: { age: 7 * 24 * 3600 }             // 失败的留 7 天，方便查原因
    }
});
