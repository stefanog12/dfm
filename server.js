import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import fetch from 'node-fetch';

dotenv.config();

const { OPENAI_API_KEY, RAG_ENDPOINT, PORT } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key.');
  process.exit(1);
}
if (!RAG_ENDPOINT) {
  console.error('Missing RAG_ENDPOINT in .env');
  process.exit(1);
}

// === RAG esterna ===
async function ragRetrieve(query) {
  try {
    const res = await fetch(RAG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topK: 3 })
    });
    const data = await res.json();
    console.log('📝 RAG: conversazioni recuperate:', data.map(d => `${d.id} (score: ${d.score.toFixed(2)})`));
    return data;
  } catch (err) {
    console.error('❌ Errore RAG:', err);
    return [];
  }
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'You are a friendly and concise AI voice assistant. Keep your answers short and conversational, like a real phone call. Your voice and personality should be warm and engaging, with a lively and playful tone. If the user wants more, ask "Do you want me to continue?"';
const VOICE = 'alloy';
const LOG_EVENT_TYPES = [ 'error', 'response.content.done', 'rate_limits.updated', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created' ];

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
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
    });

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

    conn.on('message', async (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.event === 'media' && data.media.text) {
          const userText = data.media.text;

          // Recupero RAG esterna
          const matches = await ragRetrieve(userText);
          const contextText = matches.map(m => m.text).join('\n\n---\n\n');

          // Invio istruzioni con contesto a OpenAI
          sendToOpenAI({
            type: 'session.update',
            session: {
              instructions: `Sei un assistente telefonico professionale.\nPrendi come riferimento lo stile delle seguenti conversazioni:\n\n${contextText}\n\nOra rispondi allo stesso modo.`
            }
          });
        }
      } catch (err) {
        console.error('Errore parsing da Twilio o invio a OpenAI:', err);
      }
    });

    conn.on('close', () => {
      console.log('❌ Twilio WebSocket connection closed');
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    openAiWs.on('error', (err) => console.error('Errore OpenAI WS:', err));
  });
});

fastify.listen({ port: PORT || 3000, host: '0.0.0.0' }, (err) => {
  if (err) { console.error('Errore di avvio:', err); process.exit(1); }
  console.log(`🚀 Server avviato su http://0.0.0.0:${PORT || 3000}`);
});
