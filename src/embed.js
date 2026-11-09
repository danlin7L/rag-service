//向量化：call nomic-embed-text, 把文字变成768个数字

export async function embed(text){
    console.log("embed.js, 向量化：call nomic-embed-text, 把文字变成768个数字");

    const res = await fetch('http://localhost:11434/api/embed',{
        method: 'POST',
        headers: {'Content-Type' : 'application/json'},
        body: JSON.stringify({
            model: 'nomic-embed-text',
            input: text,
        }),
    });
    const data = await res.json();
    return data.embeddings[0];
}