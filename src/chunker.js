//切块：把长文章切成重叠的小块

export function chunkText(text,size = 1000, overlap = 200) {
    console.log("chunker.js, 切块：把长文章切成重叠的小块");

    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start+size, text.length);
        chunks.push(text.slice(start, end));
        if (end == text.length) break;
        start = end - overlap;
    }
    return chunks;
}