//test: 完整回答，检索后交给 llama3.1写答案

import { search } from './search.js';
import { pool } from './db.js';

const question = "Will a new drawer fit an older unit?";
console.log("answer.js, 开始提问");

const chunks = await search(question);
const context = chunks.map(c => c.content).join('\n---\n');
console.log("answer.js, 把资料交给llama3.1");
const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        model: 'llama3.1',
        prompt: `Answer only using the context below. \n\nContext:\n${context}\n\nQuestion: ${question}`,
        stream: false,
    }),
});
const data = await res.json();
console.log(data.response);
await pool.end()