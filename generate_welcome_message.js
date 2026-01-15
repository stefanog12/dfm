import fs from 'fs';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateWelcomeMessage() {
  console.log('🎙️ Generating welcome message...');
  
  try {
    const mp3 = await openai.audio.speech.create({
      model: "tts-1-hd",  // HD quality for better voice
      voice: "coral",     // Same voice as your realtime
      input: "DFM clima, buongiorno. Sono l'assistente virtuale. Come posso aiutarla?",
      response_format: "mp3",
	  speed: 0.85          // ?? Slower: 0.25-1.0 | Faster: 1.0-4.0
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    fs.writeFileSync("welcome_message.mp3", buffer);
    
    console.log("✅ Welcome message saved as 'welcome_message.mp3'");
    console.log("💡 Now convert it to μ-law format for Twilio:");
    console.log("   ffmpeg -i welcome_message.mp3 -ar 8000 -ac 1 -f mulaw welcome_message.ulaw");
    
  } catch (err) {
    console.error("❌ Error generating welcome message:", err);
  }
}

generateWelcomeMessage();