require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.text({ type: 'text/xml' }));

// 🌐 Keep-alive route
app.get("/", (req, res) => {
  res.send("✅ Server attivo e in ascolto");
});

// 🎯 Route /twiml: restituisce il TwiML per iniziare lo streaming
app.post("/twiml", (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.DOMAIN}/audio" />
      </Connect>
    </Response>
  `);
});

// 🔌 Avvia il server HTTP e WebSocket
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server attivo su http://0.0.0.0:${PORT}`);
});

const wss = new WebSocket.Server({ server, path: "/audio" });

wss.on("connection", (ws) => {
  console.log("🟢 Connessione WebSocket da Twilio ricevuta");

  ws.on("message", async (audioData) => {
    try {
      console.log("🎤 Audio ricevuto, invio a OpenAI...");

      const response = await axios.post(
        "https://api.openai.com/v1/audio/speech-to-speech",
        {
          audio: audioData,
          voice: "onyx", // puoi usare anche nova, shimmer, ecc.
          model: "gpt-3.5-turbo"
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
          },
          responseType: "arraybuffer"
        }
      );

      console.log("🔊 Risposta OpenAI ricevuta, inoltro a Twilio...");
      ws.send(response.data);
    } catch (error) {
      console.error("❌ Errore OpenAI:", error.response?.data || error.message);
    }
  });

  ws.on("close", () => {
    console.log("🔴 Connessione WebSocket chiusa");
  });
});

