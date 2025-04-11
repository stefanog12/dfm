require('dotenv').config();
const express = require("express");
const twilio = require("twilio");
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Avvia un server HTTP (necessario per WebSocket)
const server = app.listen(PORT, () => {
    console.log(`Server in ascolto su http://localhost:${PORT}`);
});

// Crea il server WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("🟢 Connessione WebSocket ricevuta!");

    ws.on('message', async (audioData) => {
        try {
            console.log("🎤 Audio ricevuto, invio a OpenAI...");

            // Invia l'audio a OpenAI Speech-to-Speech
            const response = await axios.post(
                "https://api.openai.com/v1/audio/speech-to-speech",
                {
                    audio: audioData, // Audio grezzo ricevuto da Twilio
                    voice: "onyx", // OpenAI supporta varie voci: onyx, echo, nova...
                    model: "gpt-3.5-turbo"
                },
                {
                    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                    responseType: 'arraybuffer' // Riceviamo l’audio in output
                }
            );

            console.log("🔊 Risposta OpenAI ricevuta, inoltro a Twilio...");
            ws.send(response.data); // Inoltra l’audio generato a Twilio
        } catch (error) {
            console.error("❌ Errore OpenAI:", error.response?.data || error.message);
        }
    });

    ws.on('close', () => {
        console.log("🔴 Connessione WebSocket chiusa.");
    });
});

