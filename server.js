require('dotenv').config();
const express = require('express');
const { Readable } = require('stream');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server attivo su http://0.0.0.0:${PORT}`);
});

app.get("/", (req, res) => {
  res.send("✅ Server WebSocket attivo");
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log("🔗 Connessione WebSocket ricevuta da Twilio");

  let audioChunks = [];

  wss.on('message', async (msg) => {
    // Twilio invia un JSON con base64 audio
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        console.log("▶️ Stream iniziato");
      } else if (data.event === "media") {
        // Ricevi audio in base64 e salvalo
        const audioBuf = Buffer.from(data.media.payload, 'base64');
        audioChunks.push(audioBuf);
      } else if (data.event === "stop") {
        console.log("⏹️ Stream terminato. Invio audio a OpenAI...");

        const audioBuffer = Buffer.concat(audioChunks);

        // 1️⃣ Speech-to-Text: audio ➜ testo
        const transcription = await transcribeAudio(audioBuffer);

        console.log("🗣️ Utente ha detto:", transcription);

        // 2️⃣ Chat completation: testo ➜ risposta
        const reply = await getChatReply(transcription);

        console.log("🤖 Risposta GPT:", reply);

        // 3️⃣ Text-to-Speech: risposta ➜ audio
        const speechBuffer = await textToSpeech(reply);

        // 4️⃣ Invia audio a Twilio
        wss.send(speechBuffer);

        audioChunks = [];
      }

    } catch (err) {
      console.error("❌ Errore:", err.message);
    }
  });

  wss.on('close', () => {
    console.log("🔴 Connessione WebSocket chiusa.");
  });
});


// 🔤 Funzione: Speech-to-Text
async function transcribeAudio(audioBuffer) {
  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    audioBuffer,
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'audio/wav'
      }
    }
  );
  return response.data.text;
}

// 💬 Funzione: GPT risposta
async function getChatReply(prompt) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: process.env.MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: "system", content: "Rispondi in modo naturale e amichevole come un assistente vocale." },
        { role: "user", content: prompt }
      ]
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

// 🔊 Funzione: Text-to-Speech
async function textToSpeech(text) {
  const response = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    {
      model: 'tts-1',
      voice: process.env.VOICE_ID || 'nova',
      input: text
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );
  return response.data;
}
