import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from "node-fetch";

dotenv.config();

const { OPENAI_API_KEY, RAG_ENDPOINT } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key.');
    process.exit(1);
}

if (!RAG_ENDPOINT) {
    console.error('Missing RAG_ENDPOINT in .env');
    process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const BASE_SYSTEM_MESSAGE = `
You are a friendly and concise AI voice assistant.
Your tone is warm, engaging, playful, and natural.
Keep all replies under 15 seconds unless the user asks for more.
If the user wants more, ask: "Vuoi che continui?"
`;

const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;

fastify.get('/', async () => ({ message: "🟢 Server Twilio + OpenAI + External RAG attivo!" }));

fastify.all('/incoming-call', async (req, reply) => {
    reply.type('text/xml').send(`
        <Response>
            <Say>Sto connettendo l'assistente A.I.</Say>
            <Pause length="1"/>
            <Say>Puoi iniziare a parlare!</Say>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
        </Response>
    `);
});

fastify.register(async () => {
    fastify.get('/media-stream', { websocket: true }, (conn, req) => {
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let responseStartTimestampTwilio = null;
        let lastAssistantItem = null;
        let markQueue = [];

        let dynamicStyleContext = ""; // 🆕 stile recuperato via RAG

        const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01", {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // ---------------------
        //  INIT SESSIONE OAI
        // ---------------------
        const sendSessionUpdate = () => {
            const prompt = BASE_SYSTEM_MESSAGE + "\n\n" +
                (dynamicStyleContext ? `Adatta lo stile seguendo questi esempi:\n${dynamicStyleContext}` : "");

            const update = {
                type: "session.update",
                session: {
                    turn_detection: { type: "server_vad" },
                    input_audio_format: "g711_ulaw",
                    output_audio_format: "g711_ulaw",
                    voice: VOICE,
                    instructions: prompt,
                    modalities: ["text", "audio"]
                }
            };

            console.log("🔧 [SESSION UPDATE] Nuove instructions inviate a OpenAI");
            console.log(prompt);

            openAiWs.send(JSON.stringify(update));
        };

        // -------------------
        //  RAG ESTERNA
        // -------------------
        async function callRag(userText) {
            try {
                const res = await fetch(RAG_ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query: userText })
                });

                const json = await res.json();

                console.log("📌 [RAG] Conversazioni recuperate:", json.results?.map(r => r.id));

                return json.context ?? "";
            } catch (err) {
                console.error("❌ Errore richiesta RAG:", err);
                return "";
            }
        }

        // ---------------------
        //  EVENTI OPENAI
        // ---------------------

      // === gestione coda messaggi ===
    let openAiReady = false;
    let queuedMessages = [];

    openAiWs.on('open', () => {
      console.log('🧠 OpenAI WebSocket connection opened');
      openAiReady = true;
      queuedMessages.forEach(msg => openAiWs.send(msg));
      queuedMessages = [];
    });
         function sendToOpenAI(message) {
      const msgStr = JSON.stringify(message);
      if (openAiReady && openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(msgStr);
      } else {
        queuedMessages.push(msgStr);
        console.log('🟡 OpenAI WS non pronta, messaggio messo in coda');
      }
    }

        openAiWs.on("message", (raw) => {
            const msg = JSON.parse(raw);

            if (msg.type === "response.audio.delta" && msg.delta) {
                conn.send(JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload: msg.delta }
                }));

                if (!responseStartTimestampTwilio) {
                    responseStartTimestampTwilio = latestMediaTimestamp;
                }

                if (msg.item_id) lastAssistantItem = msg.item_id;

                conn.send(JSON.stringify({
                    event: "mark",
                    streamSid,
                    mark: { name: "responsePart" }
                }));
                markQueue.push("responsePart");
            }
        });

        // -----------------------
        //  EVENTI DA TWILIO
        // -----------------------
        conn.on("message", async (raw) => {
            const data = JSON.parse(raw);

            switch (data.event) {
                case "start":
                    streamSid = data.start.streamSid;
                    console.log("🚀 Twilio stream avviato:", streamSid);
                    break;

                case "media":
                    latestMediaTimestamp = data.media.timestamp;

                    openAiWs.send(JSON.stringify({
                        type: "input_audio_buffer.append",
                        audio: data.media.payload
                    }));
                    break;

                case "stop":
                    console.log("⛔ STREAM STOP");
                    break;

                // ----------------------
                //  SPEECH DETECTED
                // ----------------------
                case "input_audio_buffer.speech_stopped":
                case "mark":
                    break;

                default:
                    break;
            }
        });

        // Quando OpenAI rileva l'inizio di un messaggio utente, chiediamo RAG
        openAiWs.on("message", async (raw) => {
            const msg = JSON.parse(raw);

            if (msg.type === "response.text.delta") return;

            if (msg.type === "input_audio_buffer.speech_stopped") {
                console.log("🎤 Fine frase utente → invio a RAG…");

                // 1. Richiedi testo dell'utente
                openAiWs.send(JSON.stringify({ type: "input_text_buffer.extract" }));
            }

            if (msg.type === "input_text_buffer.extracted") {
                const userText = msg.text;
                console.log("👤 Testo utente:", userText);

                // 2. Query RAG
                dynamicStyleContext = await callRag(userText);

                // 3. Aggiorna le instructions
                sendSessionUpdate();
            }
        });

        conn.on("close", () => {
            console.log("❌ Connessione Twilio chiusa");
            openAiWs.close();
        });
    });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
    console.log(`🚀 Server attivo su porta ${PORT}`);
});

