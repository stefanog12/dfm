import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import OpenAI from "openai";
import { searchMemory } from "./rag.js";

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY");
    process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------------------
// SERVER SETUP
// ------------------------------
const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const BASE_SYSTEM_MESSAGE = `
Sei un'assistente telefonica cortese, femminile e molto naturale.
Fornisci risposte brevi, colloquiali e veloci.
Non attendere pause lunghe, rispondi non appena ricevi il testo.
`.trim();

const VOICE = "coral";   // 🔥 voce femminile e calda
const PORT = process.env.PORT || 3000;


// ------------------------------
// TWILIO ENDPOINT
// ------------------------------
fastify.all("/incoming-call", async (req, reply) => {
    const twiml = `
        <Response>
            <Say>Connessione con l'assistente. Puoi parlare.</Say>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
        </Response>
    `;
    reply.type("text/xml").send(twiml);
});


// ------------------------------------------------------------
// 🔥 VERSIONE ULTRA FAST — NO BLOCK / NO WAIT
// ------------------------------------------------------------
fastify.get("/media-stream", { websocket: true }, (conn, req) => {
    console.log("☎️ Client Twilio connesso");

    let streamSid = null;

    // ------------------------------
    //  OPENAI REALTIME WS
    // ------------------------------
    const openAiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-realtime",
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        }
    );

    // BUFFER audio da Twilio → OpenAI
    openAiWs.on("open", () => {
        console.log("🧠 OpenAI realtime connesso");

        openAiWs.send(
            JSON.stringify({
                type: "session.update",
                session: {
                    voice: VOICE,
                    input_audio_format: "g711_ulaw",
                    output_audio_format: "g711_ulaw",
                    turn_detection: { type: "server_vad" },
                    modalities: ["text", "audio"],
                    instructions: BASE_SYSTEM_MESSAGE,
                    temperature: 0.6,
                },
            })
        );
    });

    // ------------------------------
    //  STREAM AUDIO DA OPENAI → TWILIO
    // ------------------------------
    openAiWs.on("message", (raw) => {
        const msg = JSON.parse(raw);

        if (msg.type === "response.audio.delta") {
            conn.send(
                JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload: msg.delta },
                })
            );
        }

        // 🔍 RAG — NON blocca la risposta. parte fuori banda.
        if (
            msg.type === "conversation.item.input_audio_transcription.completed"
        ) {
            const text = msg.transcript?.trim();
            if (text) triggerRAG(text);
        }
    });

    openAiWs.on("error", (e) =>
        console.error("Errore WebSocket OpenAI:", e.message)
    );

    // ------------------------------
    // TWILIO → OPENAI
    // ------------------------------
    conn.on("message", (data) => {
        const msg = JSON.parse(data);

        switch (msg.event) {
            case "start":
                streamSid = msg.start.streamSid;
                console.log("▶️ Stream SID:", streamSid);
                break;

            case "media":
                if (openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(
                        JSON.stringify({
                            type: "input_audio_buffer.append",
                            audio: msg.media.payload,
                        })
                    );
                }
                break;
        }
    });

    conn.on("close", () => {
        console.log("❌ Twilio WS closed");
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    // ------------------------------------------------------------
    // 🔥 RAG SUPER VELOCE — NON BLOCCA MAI LA RISPOSTA
    // ------------------------------------------------------------
    async function triggerRAG(userText) {
        try {
            console.log("🎯 RAG ricerca per:", userText);

            // 1) embedding super veloce
            const emb = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: userText,
            });

            const vector = emb.data[0].embedding;

            // 2) top3 immediatamente
            const results = await searchMemory(vector, 3);

            if (!results.length) return;

            const context =
                results
                    .map(
                        (r, i) =>
                            `Esempio ${i + 1}:\n${r.text.substring(0, 400)}`
                    )
                    .join("\n\n") + "\n\n";

            console.log("📚 Context RAG pronto (no delay).");

            // 3) aggiornamento leggero (NO session.update pesante!)
            openAiWs.send(
                JSON.stringify({
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "system",
                        content: [
                            {
                                type: "input_text",
                                text: `Tieni conto di questo stile:\n${context}`,
                            },
                        ],
                    },
                })
            );
        } catch (err) {
            console.error("Errore RAG:", err);
        }
    }
});


// ------------------------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
    console.log("🚀 Server realtime attivo su porta", PORT);
});
