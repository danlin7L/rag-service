// 缓存：把 /query 的答案存进 Redis，同样的问题第二次直接返回
// Redis 挂了也不影响服务：所有操作出错都只打日志，当作“没缓存”
import { createHash } from 'crypto';
import { createClient } from 'redis';

const TTL_SECONDS = 60 * 60;  // 答案缓存 1 小时，过期 Redis 自动删
const PREFIX = 'answer:';

const client = createClient({
    url: 'redis://localhost:6379',
    // 断线后自动重连：等 0.1s、0.2s……最多每 5s 试一次
    socket: { reconnectStrategy: retries => Math.min(retries * 100, 5000) }
});

// 断线时一直重连会一直报错，只在“刚断开”时打一次日志
let warned = false;
client.on('error', err => {
    if (!warned) console.error('cache.js: 连不上 Redis，先不用缓存（后台会自动重连）：', err.message);
    warned = true;
});
client.on('ready', () => {
    console.log('cache.js: 连上 Redis 了！');
    warned = false;
});

// 不 await：Redis 没起来时 connect() 会一直重试，await 会卡住整个服务启动
// 连上之前 client.isReady 是 false，下面的函数就当作没缓存
client.connect().catch(() => {});

// 问题 → key。先统一大小写和空格，"Sports?" 和 " sports? " 算同一个问题
// 用 sha256 是因为问题可能很长，key 短一点、长度固定
function keyFor(question) {
    const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
    return PREFIX + createHash('sha256').update(normalized).digest('hex');
}

export async function getCachedAnswer(question) {
    if (!client.isReady) return null;
    try {
        const value = await client.get(keyFor(question));
        return value ? JSON.parse(value) : null;
    } catch (err) {
        console.error('cache.js: 读缓存失败：', err.message);
        return null;
    }
}

export async function setCachedAnswer(question, result) {
    if (!client.isReady) return;
    try {
        await client.set(keyFor(question), JSON.stringify(result), { EX: TTL_SECONDS });
    } catch (err) {
        console.error('cache.js: 写缓存失败：', err.message);
    }
}

// 文档变了，旧答案可能就不对了 → 删掉所有 answer:* 的 key
// 用 SCAN 分批找，不用 KEYS（KEYS 会一次扫完整个库，key 多时会卡住 Redis）
export async function clearAnswerCache() {
    if (!client.isReady) return 0;
    let deleted = 0;
    try {
        for await (const keys of client.scanIterator({ MATCH: PREFIX + '*', COUNT: 100 })) {
            if (keys.length) deleted += await client.del(keys);
        }
    } catch (err) {
        console.error('cache.js: 清缓存失败：', err.message);
    }
    return deleted;
}

export async function closeCache() {
    if (client.isOpen) await client.quit();
}
