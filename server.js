const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware per gestire il JSON
app.use(express.json());

// Endpoint per ricevere richieste e interagire con OpenAI
app.post("/ask", async (req, res) => {
    const userMessage = req.body.message || "Ciao, dimmi una curiosità!";
    
    try {
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: "gpt-4-turbo",
                messages: [{ role: "user", content: userMessage }],
                max_tokens: 50
            },
            {
                headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
            }
        );

        res.json({ reply: response.data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: error.response?.data || error.message });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
});


