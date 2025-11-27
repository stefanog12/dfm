import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

// ==== RAG: caricamento embeddings stile ====
import fs from "fs";
import path from "path";

const EMBEDDINGS_PATH = path.join(process.cwd(), "memory_vectors.json");
let RAG_DATA = [];

try {
    if (fs.existsSync(EMBEDDINGS_PATH)) {
        RAG_DATA = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, "utf8"));
        console.log(`📚 RAG: caricati ${RAG_DATA.length} embeddings`);
    } else {
        console.log("⚠️ RAG: nessun embeddings.json trovato");
    }
} catch (err) {
    console.error("❌ Errore caricamento RAG:", err);
}

// funzione minimale cosine similarity
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Recupera i migliori 3 messaggi simili allo stile richiesto
function ragRetrieve(queryEmbedding, topK = 3) {
    return RAG_DATA
        .map(item => ({
            ...item,
            score: cosine(queryEmbedding, item.embedding)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

console.log("Chiave API:", process.env.OPENAI_API_KEY);

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'You are a friendly and concise AI voice assistant. Keep your answers short and conversational, like a real phone call. Your voice and personality should be warm and engaging, with a lively and playful tone. If interacting in a non-English language, start by using the standard accent or dialect familiar to the user. Prefer sentences under 15 seconds. If the user wants more, ask "Do you want me to continue?"';
const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;

const LOG_EVENT_TYPES = [ 'error', 'response.content.done', 'rate_limits.updated', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created' ];
const SHOW_TIMING_MATH = false;

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

       // Initialize session with correct audio format for Twilio (PCMU)
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',    // IMPORTANT: Twilio sends PCMU
                    output_audio_format: 'g711_ulaw',   // Match PCMU output
                    voice: VOICE,
                   // senza RAG instructions: SYSTEM_MESSAGE,
                    instructions: SYSTEM_MESSAGE + (globalThis.STYLE_HINT ? ("\n\n### Style guidance:\n" + globalThis.STYLE_HINT) : ""),
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            // console.log('👉 Sending session update:', JSON.stringify(sessionUpdate));
           // openAiWs.send(JSON.stringify(sessionUpdate));

            console.log('👉 [SESSION INIT] Sending session update:', JSON.stringify(sessionUpdate, null, 2));
            try {
                openAiWs.send(JSON.stringify(sessionUpdate));
            } catch (err) {
                console.error('🚨 [SESSION INIT] Failed to send session update:', err);
            }
        };

        const handleSpeechStartedEvent = () => {
            console.log('🔊 Speech started detected from OpenAI');
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                console.log(`⏱️ Truncating last assistant item at ${elapsedTime} ms`);
                if (lastAssistantItem) {
                    openAiWs.send(JSON.stringify({
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    }));
                }
                conn.send(JSON.stringify({ event: 'clear', streamSid }));
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = () => {
            if (streamSid) {
                console.log('✅ Sending mark to Twilio');
                conn.send(JSON.stringify({
                    event: 'mark',
                    streamSid,
                    mark: { name: 'responsePart' }
                }));
                markQueue.push('responsePart');
            }
        };

        openAiWs.on('open', () => {
           // console.log('🧠 Connessione OpenAI attiva');
            console.log('🧠 OpenAI WebSocket connection opened (readyState:', openAiWs.readyState, ')');
            initializeSession();
        });

        openAiWs.on('message', (data) => {
            console.log('📩 [FROM OPENAI] Message received');
            try {
                const msg = JSON.parse(data);
                if (LOG_EVENT_TYPES.includes(msg.type)) {
                   // console.log(`[OpenAI] ${msg.type}`, msg);
                    console.log(`[OpenAI EVENT] ${msg.type}`, JSON.stringify(msg, null, 2));
                }

                if (msg.type === 'response.audio.delta' && msg.delta) {
                     console.log('🔊 [AUDIO DELTA] Sending audio chunk to Twilio');
                    conn.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: msg.delta }
                    }));

                    if (!responseStartTimestampTwilio) {
                        console.log('⏳ First audio chunk, marking timestamp');
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }

                    if (msg.item_id) lastAssistantItem = msg.item_id;

                    sendMark();
                }

                // ==== RAG STYLE INJECTION ====

                if (msg.type === "response.created") {
                       const userText = msg.response?.input_text || "";

                if (userText && userText.length > 0) {
                        ragSearch(userText).then(results => {
                if (results.length > 0) {
                        const styleNotes = results.map(r => `- ${r.content}`).join("\n");

                        console.log("🎨 RAG style injected:\n", styleNotes);

                        openAiWs.send(JSON.stringify({
                           type: "session.update",
                            session: {
                                instructions:
                                 SYSTEM_MESSAGE +
                                 "\n\n### Voice Style Examples from previous calls:\n" +
                                 styleNotes
                            }
                         }));
            }
        });
    }
}

                if (msg.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (err) {
                console.error('Errore parsing da OpenAI:', err);
            }
        });

        conn.on('message', (msg) => {
            console.log('📨 [FROM TWILIO] Message received');
            try {
                const data = JSON.parse(msg);
                console.log('[FROM TWILIO] Event:', data.event);
                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                         console.log(`🎙️ [MEDIA] Timestamp: ${latestMediaTimestamp}`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            console.log('➡️ Sending audio to OpenAI (buffer.append)');
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }else {
                            console.warn('⚠️ OpenAI WebSocket not open, cannot send audio');
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('🚀 Stream started. SID:', streamSid);
                        break;
                    case 'mark':
                        console.log('✅ [MARK] Acknowledged by Twilio');
                        if (markQueue.length > 0) markQueue.shift();
                        break;
                    default:
                        console.log('ℹ️ [OTHER EVENT] Full data:', JSON.stringify(data));
                }
            } catch (err) {
                console.error('Errore parsing da Twilio:', err);
            }
        });

        conn.on('close', () => {
            console.log('❌ Twilio WebSocket connection closed');
            if (openAiWs.readyState === WebSocket.OPEN) {
                console.log('🔒 Closing OpenAI WebSocket as well');
                openAiWs.close();
            } else {
                console.log('✅ OpenAI WebSocket already closed');
            }
        });

        openAiWs.on('error', (err) => {
            console.error('Errore OpenAI WS:', err);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Errore di avvio:', err);
        process.exit(1);
    }
    console.log(`🚀 Server avviato su http://0.0.0.0:${PORT}`);
});

