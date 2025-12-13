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
const VOICE = 'alloy';
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
        
        // 🆕 RAG state
        let ragContext = "";
        let hasCalledRag = false;
        let pendingRagUpdate = false;
        let lastSessionUpdateTime = 0; // Track when we last updated session
        
        // ⏱️ SOLUZIONE 1: Timeout più aggressivo per speech bloccato
        let speechStartTime = null;
        let speechTimeoutTimer = null;
        const MAX_SPEECH_DURATION = 8000; // 🔴 RIDOTTO a 8 secondi (era 15)
        let isProcessingResponse = false; // 🆕 Previeni richieste simultanee
        
        // 🆕 SOLUZIONE 2: Tracciamento audio effettivo per distinguere silenzio da speech
        let audioChunksReceived = 0;
        let lastAudioTimestamp = 0;
        const SILENCE_THRESHOLD = 1000; // Se non arriva audio per 1 secondo = silenzio

        const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        // Initialize session with current instructions
        const initializeSession = () => {
            const instructions = BASE_SYSTEM_MESSAGE + (ragContext ? `\n\n🎯 Adatta il tuo stile seguendo questi esempi di conversazioni passate:\n${ragContext}` : "");
            
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { 
                        type: 'server_vad',
                        threshold: 0.8,           // 🔴 AUMENTATO: era 0.7, ora 0.8 (meno sensibile)
                        prefix_padding_ms: 200,   // 🔴 RIDOTTO: era 300ms (meno padding iniziale)
                        silence_duration_ms: 500  // 🔴 AUMENTATO: era 300ms, ora 500ms (attende più silenzio)
                    },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: instructions,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    input_audio_transcription: {
                        model: "whisper-1"
                    }
                }
            };

            console.log('👉 [SESSION INIT] Sending session update with optimized VAD');
            if (ragContext) {
                console.log('📚 [RAG CONTEXT] Instructions include RAG context');
            }
            
            lastSessionUpdateTime = Date.now(); // Track update time
            
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

                console.log('✨ [RAG] Context updated, will update session after current response');
                
                // Don't update immediately - wait for current response to finish
                pendingRagUpdate = true;
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
            
            // 🎤 Send welcome message via OpenAI
            setTimeout(() => {
                if (openAiWs.readyState === WebSocket.OPEN) {
                    console.log('📢 Sending welcome message via OpenAI');
                    openAiWs.send(JSON.stringify({
                        type: 'response.create',
                        response: {
                            modalities: ['text', 'audio'],
                            instructions: 'Say: "DFM clima, buongiorno. Sono l\'assistente virtuale. Come posso aiutarla?"'
                        }
                    }));
                }
            }, 500);
        });

        openAiWs.on('message', async (data) => {
            try {
                const msg = JSON.parse(data);
                
                // 📊 Log ALL events to debug
                console.log(`[OpenAI EVENT] ${msg.type}`);
                
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
                        isProcessingResponse = false; // Reset quando inizia effettivamente la risposta
                    }

                    if (msg.item_id) lastAssistantItem = msg.item_id;
                    sendMark();
                }
                
                if (msg.type === 'response.audio.done') {
                    console.log('✅ [AUDIO DONE] Full audio sent');
                    
                    // Reset stato per la prossima interazione
                    responseStartTimestampTwilio = null;
                    lastAssistantItem = null;
                    markQueue = [];
                    audioChunksReceived = 0;
                    isProcessingResponse = false;
                    
                    // 🆕 Apply pending RAG update after response completes
                    if (pendingRagUpdate) {
                        console.log('🔄 [RAG] Applying deferred session update');
                        initializeSession();
                        pendingRagUpdate = false;
                        
                        // 🔴 IMPORTANTE: Dopo il session update, pulisci il buffer audio
                        // per evitare che resti in uno stato inconsistente
                        setTimeout(() => {
                            if (openAiWs.readyState === WebSocket.OPEN) {
                                console.log('🧹 [RAG] Clearing audio buffer after session update');
                                openAiWs.send(JSON.stringify({
                                    type: 'input_audio_buffer.clear'
                                }));
                            }
                        }, 100);
                    }
                }

                // 🆕 Capture user speech for RAG (first time only)
                if (msg.type === 'conversation.item.input_audio_transcription.completed' && !hasCalledRag) {
                    const userText = msg.transcript;
                    if (userText && userText.trim().length > 0) {
                        console.log('💬 [FIRST USER MESSAGE]:', userText);
                        await callRagOnFirstQuery(userText);
                    }
                }

                // Handle speech interruption
                if (msg.type === 'input_audio_buffer.speech_started') {
                    console.log('🎤 [SPEECH STARTED] User started speaking');
                    speechStartTime = Date.now();
                    audioChunksReceived = 0; // Reset counter
                    lastAudioTimestamp = Date.now();
                    isProcessingResponse = false; // Reset flag quando inizia nuovo speech
                    
                    // Set timeout to force stop if speech goes too long
                    if (speechTimeoutTimer) clearTimeout(speechTimeoutTimer);
                    speechTimeoutTimer = setTimeout(() => {
                        if (isProcessingResponse) {
                            console.log('⏭️ [TIMEOUT] Already processing response, skipping');
                            return;
                        }
                        
                        console.warn('⚠️ [TIMEOUT] Speech exceeded max duration, forcing commit');
                        isProcessingResponse = true;
                        
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            // First commit the audio buffer
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.commit'
                            }));
                            
                            // 🔴 IMPORTANTE: Dopo il commit, chiedi esplicitamente una risposta
                            setTimeout(() => {
                                if (openAiWs.readyState === WebSocket.OPEN && isProcessingResponse) {
                                    console.log('🎯 [TIMEOUT] Requesting response after forced commit');
                                    openAiWs.send(JSON.stringify({
                                        type: 'response.create'
                                    }));
                                }
                            }, 200); // Aumentato a 200ms per dare tempo al commit
                        }
                    }, MAX_SPEECH_DURATION);
                    
                    handleSpeechStartedEvent();
                }
                
                if (msg.type === 'input_audio_buffer.speech_stopped') {
                    if (speechTimeoutTimer) {
                        clearTimeout(speechTimeoutTimer);
                        speechTimeoutTimer = null;
                    }
                    if (speechStartTime) {
                        const duration = Date.now() - speechStartTime;
                        console.log(`🎤 [SPEECH STOPPED] Duration: ${duration}ms, Audio chunks: ${audioChunksReceived}`);
                        
                        // 🔴 DIAGNOSTICO: Se durata > 10s con pochi chunks = falso positivo
                        if (duration > 10000 && audioChunksReceived < 50) {
                            console.warn('⚠️ [VAD WARNING] Long speech with few audio chunks - possible false positive');
                        }
                        
                        speechStartTime = null;
                        audioChunksReceived = 0;
                    }
                    // Non resettare isProcessingResponse qui - aspetta che la risposta inizi
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
                        audioChunksReceived++; // Track audio activity
                        lastAudioTimestamp = Date.now();
                        
                        // 🔴 DIAGNOSTICO: Avvisa se ricevi audio subito dopo un session update
                        if (lastSessionUpdateTime && (Date.now() - lastSessionUpdateTime) < 5000) {
                            if (audioChunksReceived % 100 === 0) { // Log ogni 100 chunks
                                console.log(`📊 [AUDIO] Receiving audio after session update (${audioChunksReceived} chunks)`);
                            }
                        }
                        
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }
                        break;
                        
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('🚀 Stream started. SID:', streamSid);
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
            
            // Clean up timeout
            if (speechTimeoutTimer) {
                clearTimeout(speechTimeoutTimer);
                speechTimeoutTimer = null;
            }
            
            if (openAiWs.readyState === WebSocket.OPEN) {
                console.log('🔒 Closing OpenAI WebSocket as well');
                openAiWs.close();
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
