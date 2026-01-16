import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import express from 'express';
import * as calendar from './calendar.js';
import authRoutes from './auth.js';
import * as googleClient from './googleClient.js';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// Express app per OAuth routes
const expressApp = express();
expressApp.use('/', authRoutes);

// Start Express server per OAuth
const EXPRESS_PORT = 3001;
expressApp.listen(EXPRESS_PORT, () => {
    console.log(`?? OAuth server su http://localhost:${EXPRESS_PORT}`);
});

// Inizializza Google Client
await googleClient.initialize();

const VOICE = "alloy";
const PORT = process.env.PORT || 3000;

const CALENDAR_TOOLS = [
  {
    type: "function",
    name: "find_available_slots",
    description:
      "Trova slot disponibili per appuntamenti. Usala quando il cliente chiede disponibilità o vuole prenotare l'intervento di un tecnico.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "La richiesta del cliente in linguaggio naturale, es: 'primo slot disponibile', 'settimana prossima pomeriggio'",
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
        date: { type: "string", description: "Data in formato DD/MM/YYYY" },
        time: { type: "string", description: "Ora in formato HH:MM" },
        customer_name: { type: "string", description: "Nome del cliente" },
        customer_phone: { type: "string", description: "Numero di telefono del cliente" },
        address: { type: "string", description: "Indirizzo del cliente" },
      },
      required: ["date", "time", "customer_name", "customer_phone", "address"],
    },
  },
];

const BASE_SYSTEM_MESSAGE = `
You are a friendly and concise AI voice assistant. Keep your answers short and conversational, like a real phone call.
Your voice and personality should be warm and engaging, with a lively and playful tone.
If interacting in a non-English language, start by using the standard accent or dialect familiar to the user.
Prefer sentences under 10 seconds. Keep responses SHORT (2-3 sentences max). If the user wants more, ask "Do you want me to continue?".

IMPORTANT FUNCTION USAGE:
- When customer asks about availability or scheduling, use find_available_slots function
- When customer confirms appointment details, use create_appointment function
- Always collect: name, phone, and address before creating appointment
`;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(authRoutes);

fastify.get('/', async (req, reply) => {
    const isAuth = await googleClient.isAuthenticated();
    reply.send({ 
        message: '?? Server attivo',
        calendar: isAuth ? 'Connesso' : 'Non autenticato - visita http://localhost:3001/oauth/authorize'
    });
});

fastify.all("/incoming-call", async (req, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connettendo con l'assistente A.I.</Say>
  <Pause length="1"/>
  <Say>Puoi iniziare a parlare!</Say>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`;
  reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (conn, req) => {
    console.log("?? Client Twilio connesso");
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    let NotYetCommitted = false;
    let GoAppend = true;
    let speechTimeout = null;
    const MAX_SPEECH_DURATION = 8000;

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.55,
            prefix_padding_ms: 200,
            silence_duration_ms: 400,
            interrupt_response: false,
          },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: BASE_SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
          tools: CALENDAR_TOOLS,
          tool_choice: "auto",
        },
      };

      console.log("?? [SESSION INIT] Sending session update");
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    async function handleFunctionCall(functionName, args) {
      console.log("?? [FUNCTION CALL]", functionName, args);
      try {
        if (functionName === "find_available_slots") {
          const result = await calendar.parseSchedulingRequest(fastify, args.request);
          return JSON.stringify(result);
        }

        if (functionName === "create_appointment") {
          const [day, month, year] = args.date.split("/");
          const [hour, minute] = args.time.split(":");
          const appointmentDate = new Date(year, month - 1, day, hour, minute);

          const result = await calendar.createAppointment(
            fastify,
            appointmentDate,
            args.customer_name,
            args.customer_phone,
            args.address
          );

          return JSON.stringify(result);
        }

        return JSON.stringify({ error: "Unknown function" });
      } catch (error) {
        console.error("? [FUNCTION ERROR]:", error);
        return JSON.stringify({ error: error.message });
      }
    }

    const handleSpeechStartedEvent = () => {
      console.log("?? Speech started detected from OpenAI");

      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        console.log(`?? Truncating last assistant item at ${elapsedTime} ms`);
        if (lastAssistantItem) {
          console.log("?? Speech truncated!!");
          openAiWs.send(
            JSON.stringify({
              type: "conversation.item.truncate",
              item_id: lastAssistantItem,
              content_index: 0,
              audio_end_ms: elapsedTime,
            })
          );
        }
        conn.send(JSON.stringify({ event: "clear", streamSid }));
        markQueue = [];
        NotYetCommitted = true;
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = () => {
      if (streamSid) {
        conn.send(
          JSON.stringify({
            event: "mark",
            streamSid,
            mark: { name: "responsePart" },
          })
        );
        markQueue.push("responsePart");
      }
    };

    openAiWs.on("open", () => {
      console.log("?? Connessione OpenAI attiva");
      initializeSession();
    });

    openAiWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type === "input_audio_buffer.committed") {
          console.log("?? INPUT COMMITTED - START RESPONSE");
          openAiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                voice: VOICE,
                temperature: 0.8,
              },
            })
          );
        }

        if (msg.type === "response.audio.delta" && msg.delta) {
          conn.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta },
            })
          );

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }

          if (msg.item_id) lastAssistantItem = msg.item_id;

          sendMark();
        }

        if (msg.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();

          if (speechTimeout) clearTimeout(speechTimeout);
          speechTimeout = setTimeout(() => {
            console.warn("? [TIMEOUT] Forcing speech_stopped after 8s");
            NotYetCommitted = false;
            GoAppend = true;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            }
          }, MAX_SPEECH_DURATION);
        }

        if (msg.type === "input_audio_buffer.speech_stopped") {
          console.log("?? SPEECH STOPPED");

          if (speechTimeout) {
            clearTimeout(speechTimeout);
            speechTimeout = null;
          }

          if (openAiWs.readyState === WebSocket.OPEN && NotYetCommitted) {
            openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            NotYetCommitted = false;
            GoAppend = false;
            console.log("? speech_stopped naturale, commit inviato");
          } else {
            console.log("?? speech_stopped ma già committato, nessuna azione");
          }
        }

        // ? GESTIONE FUNCTION CALLS
                if (msg.type === 'response.function_call_arguments.done') {
                    console.log('?? Function call:', msg.name);
                    const functionName = msg.name;
                    const args = JSON.parse(msg.arguments);
                    
                    const result = await handleFunctionCall(functionName, args);
                    
                    openAiWs.send(JSON.stringify({
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: msg.call_id,
                            output: result,
                        }
                    }));
                    
                    openAiWs.send(JSON.stringify({
                        type: 'response.create'
                    }));
                }

        if (msg.type === "response.done") {
          console.log("? RESPONSE DONE");
          GoAppend = true;
        }
      } catch (err) {
        console.error("Errore parsing da OpenAI:", err);
      }
    });

    conn.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);

        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN && GoAppend) {
              openAiWs.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: data.media.payload,
                })
              );
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("?? Stream started. SID:", streamSid);
            break;
          case "mark":
            if (markQueue.length > 0) markQueue.shift();
            break;
          default:
            console.log("?? [OTHER EVENT]", data.event);
        }
      } catch (err) {
        console.error("Errore parsing da Twilio:", err);
      }
    });

    conn.on("close", () => {
      console.log("? Twilio WebSocket connection closed");
      if (openAiWs.readyState === WebSocket.OPEN) {
        console.log("?? Closing OpenAI WebSocket as well");
        openAiWs.close();
      }
    });

    openAiWs.on("error", (err) => {
      console.error("Errore OpenAI WS:", err);
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Errore di avvio:", err);
    process.exit(1);
  }
  console.log(`?? Server avviato su http://0.0.0.0:${PORT}`);
});
