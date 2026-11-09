// rag.js：/query 和 /query/stream 共用的逻辑
//   retrieve()        找资料 + 判断够不够相关
//   generate()        一次性拿到完整答案
//   generateStream()  一个字一个字地拿答案（给 SSE 用）
import { search } from './search.js';

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'llama3.1';

// 距离阈值：相关问题约 0.39–0.42，无关问题约 0.64，取中间值
const MAX_DISTANCE = 0.5;
// 关键词覆盖率阈值：相关问题 1.0，无关问题最多 0.4；某块含有问题里 ≥80% 的关键词，也算找到了
// （专有名词如 "Guisachan" 向量距离 0.61 会被误判，但关键词能精确命中）
const MIN_KEYWORD_COVERAGE = 0.8;

export const IDK_ANSWER = "I don't know";

// 返回 { chunks, relevant, sources }
export async function retrieve(question) {
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

    // 意思不够近，关键词也没怎么命中 → 资料里没有答案
    const relevant = chunks.length > 0 &&
        (bestDistance <= MAX_DISTANCE || bestCoverage >= MIN_KEYWORD_COVERAGE);

    return {
        chunks,
        relevant,
        sources: relevant ? chunks.map(c => ({ source: c.source, position: c.position })) : []
    };
}

function buildPrompt(question, chunks) {
    const context = chunks.map(c => c.content).join('\n---\n');
    return `Answer only using the context below. Context:${context}  Question: ${question}`;
}

// 一次性：等 llama3.1 全部生成完再返回
export async function generate(question, chunks) {
    const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: buildPrompt(question, chunks), stream: false })
    });
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
    const data = await res.json();
    return data.response;
}

// 流式：async generator，llama3.1 每生成一小段就 yield 出来
// signal：客户端断开时用来取消请求，别让 Ollama 白白继续生成
export async function* generateStream(question, chunks, signal) {
    const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, prompt: buildPrompt(question, chunks), stream: true }),
        signal
    });
    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);

    // Ollama 的流是 NDJSON：每行一个 JSON，例如 {"response":"Yes","done":false}
    // 网络传过来的一块数据可能是半行，所以先攒到 buffer 里，凑够整行再解析
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of res.body) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();                 // 最后一段可能不完整，留到下一轮
        for (const line of lines) {
            if (!line.trim()) continue;
            const data = JSON.parse(line);
            if (data.error) throw new Error(`Ollama error: ${data.error}`);
            if (data.response) yield data.response;
            if (data.done) return;
        }
    }
}
