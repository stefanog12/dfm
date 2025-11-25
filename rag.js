import fs from "fs";

const vectors = JSON.parse(fs.readFileSync("memory_vectors.json", "utf8"));

// cosine similarity between 2 vectors
function cosineSim(a, b) {
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function searchMemory(queryEmbedding, topK = 5) {
  const scored = vectors.map(v => ({
    id: v.id,
    text: v.text,
    score: cosineSim(queryEmbedding, v.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}
