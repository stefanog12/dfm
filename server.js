import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import OpenAI from 'openai';
import { searchMemory } from './rag.js';
import fs from 'fs';

dotenv.config();

console.log("Chiave API:", process.env.OPENAI_API_KEY);

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

// 🎙️ Load prerecorded welcome message
let WELCOME_AUDIO = null;
try {
    WELCOME_AUDIO = fs.readFileSync("welcome_message.ulaw");
    console.log("✅ Welcome message loaded");
} catch (err) {
    console.warn("⚠️ Welcome message not found. Generate it with: node generate_welcome.js");
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const BASE_SYSTEM_MESSAGE = 'You are a friendly and concise AI voice assistant. Keep your answers short and conversational, like a real phone call. Your voice and personality should be warm and engaging, with a lively and playful tone. If interacting in a non-English language, start by using the standard accent or dialect familiar to the user. Prefer sentences under 15 seconds. If the user wants more, ask "Do you want me to continue?"';
const VOICE = 'coral';
const PORT = process.env.PORT || 3000;

const LOG_EVENT_TYPES = [ 'error', 'response.content.done', 'rate_limits.updated', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created' ];

fastify.get('/', async (req, reply) => {
    reply.send({ message: '🟢 Server Twilio/OpenAI + RAG attivo!' });
});

fastify.all('/incoming-call', async (req, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
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
        let welcomeSent = false;
        
        // 🆕 RAG state
        let ragContext = "";
        let hasCalledRag = false;

        const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        // 🎙️ Send prerecorded welcome message
        const sendWelcomeMessage = () => {
            if (!WELCOME_AUDIO || !streamSid || welcomeSent) return;
            
            console.log('🎤 Sending prerecorded welcome message');
            
            // Split audio into chunks (Twilio prefers ~20ms chunks for 8kHz μ-law)
            const CHUNK_SIZE = 160; // 20ms at 8kHz
            const base64Audio = WELCOME_AUDIO.toString('base64');
            
            // Send the entire audio as base64
            conn.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: {
                    payload: base64Audio
                }
            }));
            
            welcomeSent = true;
            console.log('✅ Welcome message sent');
        };

        // Initialize session with current instructions
        const initializeSession = () => {
            const instructions = BASE_SYSTEM_MESSAGE + (ragContext ? `\n\n🎯 Adatta il tuo stile seguendo questi esempi di conversazioni passate:\n${ragContext}` : "");
            
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: {
                          type: "server_vad",
                          silence_duration_ms: 500,      // Fermati dopo 0.5 secondi di silenzio
                          prefix_padding_ms: 150,        // taglia un po' prima
                          min_speech_duration_ms: 250,   // serve solo un quarto di secondo per attivarsi
                          threshold: 0.5                 // più sensibile al parlato
                    },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: instructions,
                    modalities: ["text", "audio"],
                    temperature: 1.0,
                    input_audio_transcription: {
                        model: "whisper-1"
                    }
                }
            };

            console.log('💉 [SESSION INIT] Sending session update');
            if (ragContext) {
                console.log('📚 [RAG CONTEXT] Instructions include RAG context');
            }
            
            try {
                openAiWs.send(JSON.stringify(sessionUpdate));
            } catch (err) {
                console.error('🚨 [SESSION INIT] Failed to send session update:', err);
            }
        };

        // 🆕 Generate embedding and search similar conversations
        async function callRagOnFirstQuery(userText) {
            try {
                console.log('🔍 [RAG] Generating embedding for user query:', userText);
                
                const embeddingResponse = await openaiClient.embeddings.create({
                    model: "text-embedding-3-small",
                    input: userText
                });

                const queryEmbedding = embeddingResponse.data[0].embedding;
                console.log('✅ [RAG] Embedding generated');

                // Search similar conversations
                const results = await searchMemory(queryEmbedding, 3);
                
                console.log('📊 [RAG] Top 3 similar conversations:');
                results.forEach((r, idx) => {
                    console.log(`   ${idx + 1}. ${r.id} (score: ${r.score.toFixed(4)})`);
                    console.log(`      Preview: ${r.text.substring(0, 100)}...`);
                });

                // Format context from top results
                ragContext = results.map((r, idx) => 
                    `Esempio ${idx + 1} (${r.id}):\n${r.text}`
                ).join('\n\n');

                console.log('✨ [RAG] Context updated, triggering session update');
                
                // Update session with new context
                initializeSession();
                
                hasCalledRag = true;
                
            } catch (err) {
                console.error('❌ [RAG] Error:', err);
            }
        }

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
                conn.send(JSON.stringify({
                    event: 'mark',
                    streamSid,
                    mark: { name: 'responsePart' }
                }));
                markQueue.push('responsePart');
            }
        };

        openAiWs.on('open', () => {
            console.log('🧠 OpenAI WebSocket connection opened (readyState:', openAiWs.readyState, ')');
            initializeSession();
        });

        openAiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                
                if (LOG_EVENT_TYPES.includes(msg.type)) {
                    console.log(`[OpenAI EVENT] ${msg.type}`);
                }

                // 🚨 Log detailed errors
                if (msg.type === 'error') {
                    console.error('❌ [OpenAI ERROR]:', JSON.stringify(msg, null, 2));
                }

                // Handle audio streaming
                if (msg.type === 'response.audio.delta' && msg.delta) {
                    conn.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: msg.delta }
                    }));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }

                    if (msg.item_id) lastAssistantItem = msg.item_id;

                    sendMark();
                }

                // 🆕 Capture user speech for RAG (first time only)
                if (msg.type === 'conversation.item.input_audio_transcription.completed' && !hasCalledRag) {
                    const userText = msg.transcript;
                    if (userText && userText.trim().length > 0) {
                        console.log('💬 [FIRST USER MESSAGE]:', userText);
                        callRagOnFirstQuery(userText);
                    }
                }

                // Handle speech interruption
                if (msg.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
                
            } catch (err) {
                console.error('Errore parsing da OpenAI:', err);
            }
        });

        conn.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);
                
                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        } else {
                            console.warn('⚠️ OpenAI WebSocket not open, cannot send audio');
                        }
                        break;
                        
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('🚀 Stream started. SID:', streamSid);
                        // 🎙️ Send welcome message as soon as stream starts
                        setTimeout(() => sendWelcomeMessage(), 100);
                        break;
                        
                    case 'mark':
                        if (markQueue.length > 0) markQueue.shift();
                        break;
                        
                    default:
                        break;
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
