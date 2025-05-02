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
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('👉 Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
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
            console.log('🧠 Connessione OpenAI attiva');
            initializeSession();
        });

        openAiWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (LOG_EVENT_TYPES.includes(msg.type)) {
                    console.log(`[OpenAI] ${msg.type}`, msg);
                }

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
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Stream iniziato:', streamSid);
                        break;
                    case 'mark':
                        if (markQueue.length > 0) markQueue.shift();
                        break;
                }
            } catch (err) {
                console.error('Errore parsing da Twilio:', err);
            }
        });

        conn.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('❌ Client Twilio disconnesso');
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

