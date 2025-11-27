import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

dotenv.config();

console.log("Chiave API:", process.env.OPENAI_API_KEY);
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// ==== RAG: caricamento embeddings stile ====
const EMBEDDINGS_PATH = path.join(process.cwd(), 'memory_vectors.json');
let RAG_DATA = [];
try {
  if (fs.existsSync(EMBEDDINGS_PATH)) {
    RAG_DATA = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf8'));
    console.log(`📚 RAG: caricati ${RAG_DATA.length} embeddings`);
  } else {
    console.log('⚠️ RAG: nessun memory_vectors.json trovato');
  }
} catch (err) {
  console.error('❌ Errore caricamento RAG:', err);
}

function ragRetrieve(queryEmbedding, topK = 3) {
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  return RAG_DATA
    .map(item => ({ ...item, score: cosine(queryEmbedding, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'You are a friendly and concise AI voice assistant. Keep your answers short and conversational, like a real phone call. Your voice and personality should be warm and engaging, with a lively and playful tone. If the user wants more, ask "Do you want me to continue?"';
const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;
const LOG_EVENT_TYPES = [ 'error', 'response.content.done', 'rate_limits.updated', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created' ];

fastify.get('/', async (req, reply) => {
    reply.send({ message: '🟢 Server Twilio/OpenAI attivo!' });
});

fastify.all('/incoming-call', async (req, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Say>Connettendo con l'assistente A.I.</Say>
            <Pause length="1"/>
            <Say>Puoi iniziare a parlare!</Say>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
        </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (conn, req) => {
        console.log('🎧 Client Twilio connesso');
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8
                }
            };
            try {
                openAiWs.send(JSON.stringify(sessionUpdate));
            } catch (err) {
                console.error('🚨 [SESSION INIT] Failed to send session update:', err);
            }
        };

        openAiWs.on('open', () => {
            console.log('🧠 OpenAI WebSocket connection opened');
            initializeSession();
        });

        conn.on('message', async (msg) => {
            try {
                const data = JSON.parse(msg);
                if (data.event === 'media' && data.media.text) {
                    const userText = data.media.text;

                    // crea embedding
                    const clientOpenAI = new OpenAI({ apiKey: OPENAI_API_KEY });
                    const emb = await clientOpenAI.embeddings.create({
                        model: "text-embedding-3-small",
                        input: userText
                    });
                    const queryEmbedding = emb.data[0].embedding;

                    // RAG retrieval
                    const matches = ragRetrieve(queryEmbedding, 3);
                    console.log('📝 RAG: conversazioni recuperate:', matches.map(m => `${m.id} (score: ${m.score.toFixed(2)})`));

                    const contextText = matches.map(m => m.text).join('\n\n---\n\n');

                    // invio session.update con contesto
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.send(JSON.stringify({
                            type: 'session.update',
                            session: {
                                instructions: `Sei un assistente telefonico professionale.\nPrendi come riferimento lo stile delle seguenti conversazioni:\n\n${contextText}\n\nOra rispondi allo stesso modo.`
                            }
                        }));
                    }
                }
            } catch (err) {
                console.error('Errore parsing da Twilio o generazione embedding:', err);
            }
        });

        conn.on('close', () => {
            console.log('❌ Twilio WebSocket connection closed');
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        });

        openAiWs.on('error', (err) => console.error('Errore OpenAI WS:', err));
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Errore di avvio:', err);
        process.exit(1);
    }
    console.log(`🚀 Server avviato su http://0.0.0.0:${PORT}`);
});
