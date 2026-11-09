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

// 缓存版本号：每次 ingest 加 1。key 里带着版本号，版本一变，旧答案就全部“找不到”了
// 注意名字不能以 answer: 开头，否则 clearAnswerCache 的 SCAN 会把它也删掉
const VERSION_KEY = 'answer-version';

// 问题 + 版本 → key。先统一大小写和空格，"Sports?" 和 " sports? " 算同一个问题
// 用 sha256 是因为问题可能很长，key 短一点、长度固定
function keyFor(question, version) {
    const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
    return `${PREFIX}v${version}:` + createHash('sha256').update(normalized).digest('hex');
}

// 为什么不直接 get / set：
//   /query 开始 → 用旧资料生成答案（要 10 秒）→ 这期间 ingest 写入新资料并清空缓存
//   → /query 结束时把“旧答案”写进缓存 → 之后 1 小时大家都拿到旧答案
// 解决：在请求一开始就记下版本号，最后按这个版本号写。中途 ingest 把版本号加了 1，
//      这次的答案就写到旧版本下，没人会再读到它，等 TTL 到了自动删掉
//
// 用法：
//   const cache = await openAnswerCache(question);   // 一定要在搜索之前调用
//   if (cache.hit) return cache.hit;
//   ...生成答案...
//   await cache.save(result);
export async function openAnswerCache(question) {
    const noCache = { hit: null, save: async () => {} };
    if (!client.isReady) return noCache;
    try {
        const version = Number(await client.get(VERSION_KEY)) || 0;
        const key = keyFor(question, version);
        const value = await client.get(key);
        return {
            hit: value ? JSON.parse(value) : null,
            save: async result => {
                if (!client.isReady) return;
                try {
                    await client.set(key, JSON.stringify(result), { EX: TTL_SECONDS });
                } catch (err) {
                    console.error('cache.js: 写缓存失败：', err.message);
                }
            }
        };
    } catch (err) {
        console.error('cache.js: 读缓存失败：', err.message);
        return noCache;
    }
}

// 文档变了，旧答案可能就不对了：
//   1. 版本号 +1 → 所有旧答案立刻失效（这一步才是关键）
//   2. 再把旧的 answer:* key 删掉，省内存（不删也行，TTL 到了也会自动删）
// 用 SCAN 分批找，不用 KEYS（KEYS 会一次扫完整个库，key 多时会卡住 Redis）
export async function clearAnswerCache() {
    if (!client.isReady) return 0;
    let deleted = 0;
    try {
        await client.incr(VERSION_KEY);
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
