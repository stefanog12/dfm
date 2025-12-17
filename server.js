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

const BASE_SYSTEM_MESSAGE = 'You are a friendly and concise AI voice assistant. Keep your answers SHORT and conversational, like a real phone call. MAXIMUM 2-3 sentences per response. Your voice and personality should be warm and engaging. If interacting in a non-English language, use the standard accent familiar to the user.';
const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;

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
        
        let ragApplied = false;
        let welcomeSent = false;
        
        let speechTimeout = null;
        const MAX_SPEECH_DURATION = 8000; // 8 secondi

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        // Initialize session ONCE at the beginning
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { 
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 700
                    },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: BASE_SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
					// max_response_output_tokens: 150,
                    input_audio_transcription: {
                        model: "whisper-1"
                    }
                }
            };

		
				
            console.log('📤 Initializing session (ONCE)');
            openAiWs.send(JSON.stringify(sessionUpdate));
        };
		
		
        // Add RAG context as a conversation item (system message)
        async function addRagContext(userText) {
            try {
                console.log('🔍 [RAG] Searching for:', userText);
                
                const embeddingResponse = await openaiClient.embeddings.create({
                    model: "text-embedding-3-small",
                    input: userText
                });

                const queryEmbedding = embeddingResponse.data[0].embedding;
                const results = await searchMemory(queryEmbedding, 3);
                
                console.log('📊 [RAG] Found', results.length, 'similar conversations');
                results.forEach((r, idx) => {
                    console.log(`   ${idx + 1}. ${r.id} (score: ${r.score.toFixed(4)})`);
                });

                const ragContext = results.map((r, idx) => {
                    const preview = r.text.substring(0, 300);
                    return `Esempio ${idx + 1}: ${preview}`;
                }).join('\n\n');

                console.log('✨ [RAG] Adding context as conversation item');
                
                // Add RAG context as a system message in the conversation
                openAiWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'system',
                        content: [
                            {
                                type: 'input_text',
                                text: `🎯 Adatta il tuo stile seguendo questi esempi di conversazioni passate:\n\n${ragContext}`
                            }
                        ]
                    }
                }));
                
                ragApplied = true;
                console.log('✅ [RAG] Context added to conversation');
				
                
            } catch (err) {
                console.error('❌ [RAG] Error:', err);
            }
        }

        const handleSpeechStarted = () => {
            console.log('🎤 User started speaking');
            
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                console.log(`⏱️ Interrupting assistant at ${elapsedTime}ms`);
                
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
            console.log('🧠 OpenAI WebSocket connected');
            initializeSession(); // Initialize ONCE
        });

        openAiWs.on('message', async (data) => {
            try {
                const msg = JSON.parse(data);
                console.log(`[OpenAI EVENT] ${msg.type}`);

                // Send welcome message after session is ready
                if (msg.type === 'session.updated' && !welcomeSent) {
                    console.log('✅ Session ready');
                    welcomeSent = true;
                    
                    setTimeout(() => {
                        if (WELCOME_AUDIO && streamSid) {
                            console.log('📢 Sending prerecorded welcome message');
                            const audioBase64 = WELCOME_AUDIO.toString('base64');
                            const chunkSize = 160;
                            
                            for (let i = 0; i < audioBase64.length; i += chunkSize) {
                                const chunk = audioBase64.substring(i, i + chunkSize);
                                conn.send(JSON.stringify({
                                    event: 'media',
                                    streamSid,
                                    media: { payload: chunk }
                                }));
                            }
                        } else {
                            console.log('📢 Sending welcome message via OpenAI');
                            openAiWs.send(JSON.stringify({
                                type: 'response.create',
                                response: {
                                    modalities: ['text', 'audio'],
                                    instructions: 'Say: "DFM clima, buongiorno. Sono l\'assistente virtuale. Come posso aiutarla?"'
                                }
                            }));
                        }
                    }, 250);
                }

                if (msg.type === 'error') {
                    console.error('❌ [OpenAI ERROR]:', msg.error);
                }

                if (msg.type === 'response.audio.delta' && msg.delta) {
					// console.log("🔊 AUDIO CHUNK ARRIVATO", msg.delta.length);
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
				
				if (msg.type === 'response.audio.done') {
                    console.log('âœ… [AUDIO DONE] Full audio sent');
												
					responseStartTimestampTwilio = null;
                    lastAssistantItem = null;
                    markQueue = [];
				}
                
                if (msg.type === 'response.done') {
                    console.log('✅ Response completed');
					console.log("🎧 Ready for next user turn");		
				}

                if (msg.type === 'input_audio_buffer.speech_started') {
                    console.log('🎤 User speech detected');
                    handleSpeechStarted();
                    
                    // Timeout di sicurezza: forza commit dopo 8 secondi
                    if (speechTimeout) clearTimeout(speechTimeout);
                    speechTimeout = setTimeout(() => {
                        console.warn('⏰ [TIMEOUT] Forcing speech_stopped after 8s');
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.commit'
                            }));
                           
                        }
                    }, MAX_SPEECH_DURATION);
                }
                
                if (msg.type === 'input_audio_buffer.speech_stopped') {
                    console.log('🛑 Speech stopped detected');
                    if (speechTimeout) {
                        clearTimeout(speechTimeout);
                        speechTimeout = null;
                    }
                }

                // Do RAG only on first user message
                if (msg.type === 'conversation.item.input_audio_transcription.completed') {
                    const userText = msg.transcript;
                    console.log('💬 User said:', userText);
                    
                    if (!ragApplied && userText && userText.trim().length > 5) {
                        console.log('🎯 First message - applying RAG');
                        await addRagContext(userText);
						
						// End the turn cleanly (even if empty) 
						openAiWs.send(JSON.stringify({ 
							type: "input_audio_buffer.commit" 
						}));
						
                        
							// Forza una nuova risposta dopo aver aggiunto il RAG context
							setTimeout(() => {
								if (openAiWs.readyState === WebSocket.OPEN) {
									console.log('🔄 Requesting response with RAG context');
									openAiWs.send(JSON.stringify({
										type: "response.create",
										response: {
											modalities: ["audio", "text"],
													voice: VOICE,
													temperature: 0.8
										}
									}));

								}	
							}, 300);
						
                    }
                }
                
            } catch (err) {
                console.error('Error parsing OpenAI message:', err);
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
                        }
                        break;
                        
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('🚀 Stream started:', streamSid);
                        break;
                        
                    case 'mark':
                        if (markQueue.length > 0) markQueue.shift();
                        break;
                }
            } catch (err) {
                console.error('Error parsing Twilio message:', err);
            }
        });

        conn.on('close', () => {
            console.log('❌ Twilio connection closed');
            
            if (speechTimeout) {
                clearTimeout(speechTimeout);
                speechTimeout = null;
            }
            
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
        });

        openAiWs.on('error', (err) => {
            console.error('OpenAI WebSocket error:', err);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Server error:', err);
        process.exit(1);
    }
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
