import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

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

const BASE_SYSTEM_MESSAGE = 'You are a friendly and concise AI voice assistant. Keep your answers short and conversational, like a real phone call. Your voice and personality should be warm and engaging, with a lively and playful tone. If interacting in a non-English language, start by using the standard accent or dialect familiar to the user. Prefer sentences under 15 seconds. If the user wants more, ask "Do you want me to continue?"';
const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;

const LOG_EVENT_TYPES = [ 'error', 'response.content.done', 'rate_limits.updated', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created', 'session.updated' ];
const SHOW_TIMING_MATH = false;

fastify.get('/', async (req, reply) => {
    reply.send({ message: 'ðŸŸ¢ Server Twilio/OpenAI attivo!' });
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
                        threshold: 0.75,
                        prefix_padding_ms: 200,
                        silence_duration_ms: 700
                    },
                    input_audio_format: 'g711_ulaw',    // IMPORTANT: Twilio sends PCMU
                    output_audio_format: 'g711_ulaw',   // Match PCMU output
                    voice: VOICE,
                    instructions: BASE_SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
					"interrupt_response": false,
                    temperature: 0.8
                }
            };
			
            console.log('ðŸ‘‰ [SESSION INIT] Sending session update:', JSON.stringify(sessionUpdate, null, 2));
            try {
                openAiWs.send(JSON.stringify(sessionUpdate));
            } catch (err) {
                console.error('ðŸš¨ [SESSION INIT] Failed to send session update:', err);
            }
        };

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
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = () => {
            if (streamSid) {
                console.log('âœ… Sending mark to Twilio');
                conn.send(JSON.stringify({
                    event: 'mark',
                    streamSid,
                    mark: { name: 'responsePart' }
                }));
                markQueue.push('responsePart');
            }
        };

        openAiWs.on('open', () => {
           // console.log('ðŸ§  Connessione OpenAI attiva');
            console.log('ðŸ§  OpenAI WebSocket connection opened (readyState:', openAiWs.readyState, ')');
            initializeSession();
        });

        openAiWs.on('message', (data) => {
            
            try {
                const msg = JSON.parse(data);
                if (LOG_EVENT_TYPES.includes(msg.type)) {
                   // console.log(`[OpenAI] ${msg.type}`, msg);
                    console.log(`[OpenAI EVENT] ${msg.type}`, JSON.stringify(msg, null, 2));
                }
				
				
				// Reinvia session.update dopo session.created
				if (msg.type === "session.created") {
					console.log("? SESSION CREATED RECEIVED");	
				}

				if (msg.type === "session.updated") {
					console.log("? SESSION UPDATED RECEIVED:");
					console.log(JSON.stringify(msg.session, null, 2));
				}

                if (msg.type === 'response.audio.delta' && msg.delta) {
                     console.log('ðŸ”Š [AUDIO DELTA] Sending audio chunk to Twilio');
                    conn.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: msg.delta }
                    }));

                    if (!responseStartTimestampTwilio) {
                        console.log('â³ First audio chunk, marking timestamp');
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
							if (openAiWs.readyState === WebSocket.OPEN) {
								openAiWs.send(JSON.stringify({
									type: 'input_audio_buffer.commit'
								}));
								
							} else {
							console.log('?? Timeout: nessun audio utente da committare, salto il commit');
							}
						}, MAX_SPEECH_DURATION);
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
                        latestMediaTimestamp = data.media.timestamp;
                        // console.log(`ðŸŽ™ï¸ [MEDIA] Timestamp: ${latestMediaTimestamp}`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                         //   console.log('âž¡ï¸ Sending audio to OpenAI (buffer.append)');
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }else {
                            console.warn('âš ï¸ OpenAI WebSocket not open, cannot send audio');
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('ðŸš€ Stream started. SID:', streamSid);
                        break;
                    case 'mark':
                        console.log('âœ… [MARK] Acknowledged by Twilio');
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
