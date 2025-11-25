import fs from "fs";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateEmbeddings() {
  const corpus = JSON.parse(fs.readFileSync("memory_corpus.json", "utf8"));
  const output = [];

  for (const item of corpus) {
    const embedding = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: item.text
    });

    output.push({
      id: item.id,
      text: item.text,
      embedding: embedding.data[0].embedding
    });

    console.log("Embedded:", item.id);
  }

  fs.writeFileSync(
    "memory_vectors.json",
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log("👍 Embeddings generati in memory_vectors.json");
}

generateEmbeddings();
