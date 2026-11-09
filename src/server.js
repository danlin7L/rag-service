
// server.js
// 正式服务：提供 /ingest 和 /query 两个接口

import Fastify from 'fastify';
import { ingestDocument } from './ingest.js';
import { search } from './search.js';

const app = Fastify({ logger: true });

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
                    prompt: `Answer only using the context below.

Context:
${context}

Question: ${question}`,
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
