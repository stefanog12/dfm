require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get('/', (req, res) => {
  res.send('✅ Server WebSocket + OpenAI attivo!');
});

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/audio' });

wss.on('connection', (ws) => {
  console.log('🟢 Connessione WebSocket da Twilio');

  let chunks = [];

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.event === 'media') {
        const audioBase64 = data.media.payload;
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        chunks.push(audioBuffer);
      }

      if (data.event === 'stop') {
        console.log('⛔ Fine chiamata. Invio audio a OpenAI...');

        // Salva l'audio in file temporaneo
        const fullAudio = Buffer.concat(chunks);
        const tempPath = path.join(__dirname, 'temp.wav');
        fs.writeFileSync(tempPath, fullAudio);

        // 1. Whisper STT
        const transcriptionRes = await axios.post(
          'https://api.openai.com/v1/audio/transcriptions',
          fs.createReadStream(tempPath),
          {
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'multipart/form-data'
            }
          }
        );
        const userText = transcriptionRes.data.text;
        console.log('🗣️ Trascrizione:', userText);

        // 2. GPT
        const chatRes = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: 'Rispondi in italiano come se fossi in una conversazione telefonica naturale.'
              },
              { role: 'user', content: userText }
            ]
          },
          {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const replyText = chatRes.data.choices[0].message.content.trim();
        console.log('💬 Risposta GPT:', replyText);

        // 3. Speech (TTS)
        const speechRes = await axios.post(
          'https://api.openai.com/v1/audio/speech',
          {
            model: 'tts-1',
            input: replyText,
            voice: 'nova' // Altre opzioni: alloy, echo, fable, onyx
          },
          {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer'
          }
        );

        // 4. Invia audio a Twilio
        ws.send(speechRes.data);
        console.log('🔊 Audio inviato a Twilio');

        // Pulizia
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      console.error('❌ Errore:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('🔴 Connessione chiusa');
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server WebSocket in ascolto su http://localhost:${PORT}`);
});
