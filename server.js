import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import * as calendar from './calendar.js';  // QUESTO
import authRoutes from "./auth.js";         // QUESTO da copilot
import fs from 'fs';

dotenv.config();

console.log("Chiave API:", process.env.OPENAI_API_KEY);

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(authRoutes);

const BASE_SYSTEM_MESSAGE = `
You are a friendly and concise AI voice assistant. Keep your answers short and conversational, like a real phone call.
Your voice and personality should be warm and engaging, with a lively and playful tone.
If interacting in a non-English language, start by using the standard accent or dialect familiar to the user.
Prefer sentences under 10 seconds. Keep responses SHORT (2-3 sentences max). If the user wants more, ask "Do you want me to continue?".

IMPORTANT: When the customer mentions scheduling, appointments, or asks about availability:
- Use the find_available_slots function to check calendar availability
- Use the create_appointment function to book appointments after confirming details
`;


const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;

// Definizione tools per Google Calendar
const CALENDAR_TOOLS = [
    {
        type: "function",
        name: "find_available_slots",
        description: "Trova slot disponibili per appuntamenti. Usala quando il cliente chiede disponibilità o vuole prenotare l'intervento di un tecnico.",
        parameters: {
            type: "object",
            properties: {
                request: {
                    type: "string",
                    description: "La richiesta del cliente in linguaggio naturale, es: 'primo slot disponibile', 'settimana prossima pomeriggio'",
                },
            },
            required: ["request"],
        },
    },
    {
        type: "function",
        name: "create_appointment",
        description: "Crea un appuntamento nel calendario. Usala SOLO dopo aver confermato i dettagli con il cliente.",
        parameters: {
            type: "object",
            properties: {
                date: {
                    type: "string",
                    description: "Data in formato DD/MM/YYYY",
                },
                time: {
                    type: "string",
                    description: "Ora in formato HH:MM",
                },
                customer_name: {
                    type: "string",
                    description: "Nome del cliente",
                },
                customer_phone: {
                    type: "string",
                    description: "Numero di telefono del cliente",
                },
                address: {
                    type: "string",
                    description: "Indirizzo del cliente",
                },
            },
            required: ["date", "time", "customer_name", "customer_phone", "address"],
        },
    },
];


const LOG_EVENT_TYPES = [ 'error', 'response.content.done', 'rate_limits.updated', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created', 'session.updated' ];
const SHOW_TIMING_MATH = false;

fastify.get('/', async (req, reply) => {
    reply.send({ message: 'ðŸŸ¢ Server Twilio/OpenAI con calendar attivo!' });
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
        console.log('ðŸŽ§ Client Twilio connesso');
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
		let NotYetCommitted = false;  // True se è già stato committato 
		let GoAppend = true;  // False se è in corso la risposta  
		
	
		let speechTimeout = null;
        const MAX_SPEECH_DURATION = 8000; // 8 secondi
		

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
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
                    turn_detection: { 
                        type: 'server_vad',
                        threshold: 0.55,
                        prefix_padding_ms: 200,
                        silence_duration_ms: 400,
						interrupt_response: false 
                    },
                    input_audio_format: 'g711_ulaw',    // IMPORTANT: Twilio sends PCMU
                    output_audio_format: 'g711_ulaw',   // Match PCMU output
                    voice: VOICE,
                    instructions: BASE_SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
					temperature: 0.8,
					tools: CALENDAR_TOOLS,              // QUESTO
					tool_choice: "auto"					// QUESTO
                }
            };
			
            // console.log('ðŸ‘‰ [SESSION INIT] Sending session update:', JSON.stringify(sessionUpdate, null, 2));
			console.log('ðŸ‘‰ [SESSION INIT] Sending session update:');

            try {
                openAiWs.send(JSON.stringify(sessionUpdate));
            } catch (err) {
                console.error('ðŸš¨ [SESSION INIT] Failed to send session update:', err);
            }
        };
		
		
		
		 // Gestione chiamate a funzioni
        async function handleFunctionCall(functionName, args) {
            console.log(`?? [FUNCTION CALL] ${functionName}`, args);
            
            try {
                if (functionName === 'find_available_slots') {
                    const result = await calendar.parseSchedulingRequest(args.request);
                    return JSON.stringify(result);
                }
                
                if (functionName === 'create_appointment') {
                    // Parse date e time
                    const [day, month, year] = args.date.split('/');
                    const [hour, minute] = args.time.split(':');
                    const appointmentDate = new Date(year, month - 1, day, hour, minute);
                    
                    const result = await calendar.createAppointment(
                        appointmentDate,
                        args.customer_name,
                        args.customer_phone,
                        args.address
                    );
                    
                    return JSON.stringify(result);
                }
                
                return JSON.stringify({ error: 'Unknown function' });
                
            } catch (error) {
                console.error('? [FUNCTION ERROR]:', error);
                return JSON.stringify({ error: error.message });
            }
        }

		const MIN_TIME_BEFORE_INTERRUPT_MS = 700; // evita di interrompere per rumore immediato
		
        const handleSpeechStartedEvent = () => {
            console.log('ðŸ”Š Speech started detected from OpenAI');
			
			if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                console.log(`â±ï¸ Truncating last assistant item at ${elapsedTime} ms`);
                if (lastAssistantItem) {
					console.log('ðŸ”Š Speech truncated!!');
                    openAiWs.send(JSON.stringify({
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    }));
                }
                conn.send(JSON.stringify({ event: 'clear', streamSid }));
                markQueue = [];
				NotYetCommitted = true;
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = () => {
            if (streamSid) {
                // console.log('âœ… Sending mark to Twilio');
                conn.send(JSON.stringify({
                    event: 'mark',
                    streamSid,
                    mark: { name: 'responsePart' }
                }));
                markQueue.push('responsePart');
            }
        };

        openAiWs.on('open', () => {
			console.log('ðŸ§  Connessione OpenAI attiva');
            // console.log('ðŸ§  OpenAI WebSocket connection opened (readyState:', openAiWs.readyState, ')');
            initializeSession();
        });

        openAiWs.on('message', async (data) => {
            
            try {
                const msg = JSON.parse(data);
                
				// if (LOG_EVENT_TYPES.includes(msg.type)) {
                   // console.log(`[OpenAI] ${msg.type}`, msg);
                    // console.log(`[OpenAI EVENT] ${msg.type}`, JSON.stringify(msg, null, 2));
                // }
				
				
				// Reinvia session.update dopo session.created
				if (msg.type === "session.created") {
					console.log("SESSION CREATED RECEIVED");	
				}

				if (msg.type === "session.updated") {
					console.log("SESSION UPDATED RECEIVED:");
					// console.log(JSON.stringify(msg.session, null, 2));
				}
				
				// VAD ha ricevuto commit
				if (msg.type === "input_audio_buffer.committed") {
					console.log("?INPUT COMMITTED - START RESPONSE");
					console.log('?? Requesting response without RAG context');
					openAiWs.send(JSON.stringify({
						type: "response.create",
						response: {
							modalities: ["audio", "text"],
							voice: VOICE,
							temperature: 0.8
						}
					}));					
				}
				
				if (msg.type === "response.created") {
					console.log("RESPONSE CREATED");
					//console.log(JSON.stringify(msg.session, null, 2));
				}
				
                if (msg.type === 'response.audio.delta' && msg.delta) {
                    // console.log('ðŸ”Š [AUDIO DELTA] Sending audio chunk to Twilio');
                    conn.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: msg.delta }
                    }));

                    if (!responseStartTimestampTwilio) {
                        // console.log('â³ First audio chunk, marking timestamp');
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }

                    if (msg.item_id) lastAssistantItem = msg.item_id;

                    sendMark();
                }

                if (msg.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
					
					if (speechTimeout) clearTimeout(speechTimeout);
						speechTimeout = setTimeout(() => {
							console.warn('? [TIMEOUT] Forcing speech_stopped after 8s');
							NotYetCommitted = false;
							GoAppend = true;
							if (openAiWs.readyState === WebSocket.OPEN) {
								openAiWs.send(JSON.stringify({
									type: 'input_audio_buffer.commit'
								}));
								
							} else {
							console.log('?? Timeout: nessun audio utente da committare, salto il commit');
							}
							
						}, MAX_SPEECH_DURATION);
                }
				
				if (msg.type === 'input_audio_buffer.speech_stopped') {
					console.log("?? SPEECH STOPPED");

					if (speechTimeout) {
					clearTimeout(speechTimeout);
					speechTimeout = null;
					}

					// Se c'è audio utente nel buffer, committiamo subito (turno naturale)
					if (openAiWs.readyState === WebSocket.OPEN && NotYetCommitted) {
						openAiWs.send(JSON.stringify({
							type: 'input_audio_buffer.commit'
						}));
						NotYetCommitted = false;
						GoAppend = false;
						userTurnOpen = false;
						console.log('!! speech_stopped naturale, ---> commit');
					} else {
						console.log('?? speech_stopped ma già committato, non faccio commit');
					}
				}
				
if (msg.type === 'response.output_item.added') {
    console.log('?? [OUTPUT ITEM]:', msg.item);
    if (msg.item && msg.item.type === 'function_call') {
        console.log('?? [FUNCTION CALL DETECTED]:', msg.item.name);
    }
}

if (msg.type === 'response.function_call_arguments.delta') {
    console.log('?? [FUNCTION ARGS DELTA]:', msg.delta);
}

if (msg.type === 'response.function_call_arguments.done') {
    console.log('? [FUNCTION CALL COMPLETE]');
    console.log('   Function:', msg.name);
    console.log('   Arguments:', msg.arguments);
    console.log('   Call ID:', msg.call_id);
    
    const functionName = msg.name;
    const args = JSON.parse(msg.arguments);
    
    const result = await handleFunctionCall(functionName, args);
    
    // Invia il risultato
    openAiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
            type: 'function_call_output',
            call_id: msg.call_id,
            output: result,
        }
    }));
    
    // Richiedi risposta con il risultato
    openAiWs.send(JSON.stringify({
        type: 'response.create'
    }));
}
								
				// Reinvia session.update dopo session.created
				if (msg.type === "response.done") {
					console.log("RESPONSE DONE");
					GoAppend = true;
				}
				
            } catch (err) {
                console.error('Errore parsing da OpenAI:', err);
            }
        });

        conn.on('message', (msg) => {
            // console.log('ðŸ“¨ [FROM TWILIO] Message received');
            try {
                const data = JSON.parse(msg);
               // console.log('[FROM TWILIO] Event:', data.event);
                switch (data.event) {
                    case 'media':
					
		               // latestMediaTimestamp = data.media.timestamp;
                       // console.log(`ðŸŽ™ï¸ [MEDIA] Timestamp: ${latestMediaTimestamp}`);
					
					    if (openAiWs.readyState === WebSocket.OPEN && GoAppend) {
                            // console.log('âž¡ï¸ Sending audio to OpenAI (buffer.append)');
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }else {
                            console.warn('âš ï¸ OpenAI WebSocket not open or response in progress : cannot send audio');
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('ðŸš€ Stream started. SID:', streamSid);
                        break;
                    case 'mark':
                        // console.log('âœ… [MARK] Acknowledged by Twilio');
                        if (markQueue.length > 0) markQueue.shift();
                        break;
                    default:
                        console.log('â„¹ï¸ [OTHER EVENT] Full data:', JSON.stringify(data));
                }
            } catch (err) {
                console.error('Errore parsing da Twilio:', err);
            }
        });

        conn.on('close', () => {
            console.log('âŒ Twilio WebSocket connection closed');
            if (openAiWs.readyState === WebSocket.OPEN) {
                console.log('ðŸ”’ Closing OpenAI WebSocket as well');
                openAiWs.close();
            } else {
                console.log('âœ… OpenAI WebSocket already closed');
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
    console.log(`ðŸš€ Server avviato su http://0.0.0.0:${PORT}`);
});
