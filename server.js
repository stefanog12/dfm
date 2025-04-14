const express = require("express");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// Route principale per gestire le chiamate in arrivo
app.post("/twilio", (req, res) => {
    console.log("📞 Chiamata ricevuta da:", req.body.From);

    // Creiamo la risposta vocale per Twilio
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Ciao! Questa è una risposta automatica dal server.", { voice: "alice", language: "it-IT" });

    res.type("text/xml");
    res.send(twiml.toString());
});

// Avvia il server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server in ascolto su http://localhost:${PORT}`);
});

