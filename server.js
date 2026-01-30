import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import OpenAI from 'openai';
import { searchMemory } from './rag.js';
import fs from 'fs';
import * as calendar from './calendar.js';
import * as googleClient from './googleClient.js';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });


// Inizializza Google Client
await googleClient.initialize();


const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;


// Crea un buffer di silenzio (500ms a 24kHz mono, 16-bit PCM)
const samples = 8000 * 0.5; // 4000 campioni
const silenceBuffer = Buffer.alloc(samples, 0xFF); // 0xFF = silenzio PCMU
const silenceBase64 = silenceBuffer.toString("base64");

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
Sei un assistente vocale AI amichevole e conciso. 
Mantieni le risposte brevi e conversazionali, come una vera telefonata.
La tua voce e personalità devono essere calde e coinvolgenti, con un tono vivace e giocoso.
Preferisci frasi sotto i 10 secondi. Mantieni le risposte BREVI (2-3 frasi max).
Obbiettivo è gestire la telefonata come dagli esempi che arrivano dal RAG. 
Dopo la seconda domanda del cliente proponi la prenotazione di appuntamenti di interventi tecnici a meno che non sia il cliente che alla prima domanda richieda di prendere un appuntamento.

ORARI DI LAVORO:
- Lunedì-Venerdì: 8:00-17:00 (pausa pranzo 12:00-13:00)
- Weekend: CHIUSO - i tecnici non lavorano sabato e domenica
- Slot disponibili: 8:00, 10:00, 13:00, 15:00 (durata 2 ore)

FLUSSO PRENOTAZIONE - SEGUI RIGOROSAMENTE QUESTI STEP:

STEP 1 - RICERCA DISPONIBILITÀ:
- Cliente chiede disponibilità ? usa SOLO find_available_slots
- Esempi: "oggi pomeriggio", "domani mattina", "prossima settimana"
- Se chiede weekend ? rispondi "Mi dispiace, i nostri tecnici non lavorano nel weekend. Posso proporle un appuntamento per lunedì?"

STEP 2 - CLIENTE SCEGLIE SLOT:
- Proponi gli slot trovati: "Ho disponibilità alle 13:00 e alle 15:00"
- Aspetta che il cliente scelga uno slot specifico

STEP 3 - RACCOLTA DATI (UNO ALLA VOLTA):
NON chiedere tutti i dati insieme. Procedi così:
a) "Perfetto! Come si chiama?" ? aspetta risposta
b) "Qual è il suo numero di telefono?" ? aspetta risposta  
c) "Qual è l'indirizzo dove dobbiamo intervenire?" ? aspetta risposta

STEP 4 - CONFERMA PRIMA DI SALVARE:
- Riassumi TUTTO: "Ricapitoliamo: appuntamento per [NOME] il [DATA] alle [ORA] in [INDIRIZZO], telefono [TELEFONO]. È corretto?"
- Aspetta conferma esplicita: "sì", "confermo", "va bene"
- Se il cliente corregge qualcosa, aggiorna i dati

STEP 5 - CREAZIONE APPUNTAMENTO:
- SOLO dopo conferma ? chiama create_appointment
- Conferma finale: "Perfetto! Ho prenotato il suo appuntamento per [DATA] alle [ORA]. A presto!"

REGOLE IMPORTANTI:
- Comunica SOLO gli slot presenti nel risultato della funzione find_available_slots
- NON inventare slot aggiuntivi
- Se il risultato dice "13:00", rispondi SOLO "13:00"
- ESEMPIO CORRETTO: "Ho disponibilità alle 13"
- ESEMPIO SBAGLIATO: "Ho disponibilità alle 13 e alle 15" (se la funzione restituisce solo 13)
- NON chiamare create_appointment senza conferma del cliente
- NON chiedere tutti i dati in una sola frase
- Se mancano dati, chiedi UNO alla volta
- Sii paziente e cordiale durante la raccolta dati
- Se il cliente dice "no" alla conferma, chiedi cosa vuole modificare

ESEMPI DI CONVERSAZIONE:

Cliente: "Vorrei un appuntamento oggi pomeriggio"
Tu: [usa find_available_slots con "oggi pomeriggio"]
Tu: "Ho disponibilità alle [risultato funzione]. (se ce ne sono più di uno) Quale preferisce?"

Cliente: "[orario scelto]"
Tu: "Perfetto! Come si chiama?"

Cliente: "[nome e cognome]"
Tu: "Qual è il suo numero di telefono?"

Cliente: "[numero di telefono]"
Tu: "Qual è l'indirizzo dove dobbiamo intervenire?"

Cliente: "[via e città]"
Tu: "Ricapitoliamo: appuntamento per Mario Rossi oggi alle 15:00 in Via Roma 10, Milano, telefono 3331234567. È corretto?"

Cliente: "Sì"
Tu: [usa create_appointment]
Tu: "Perfetto! Ho prenotato il suo appuntamento per oggi alle 15:00. A presto!"
`;

const LOG_EVENT_TYPES = [ 'error', 'response.content.done', 'rate_limits.updated', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created', 'session.updated' ];
const SHOW_TIMING_MATH = false;

fastify.get('/', async (req, reply) => {
    const isAuth = await googleClient.isAuthenticated();
    const isProduction = process.env.NODE_ENV === 'production';
    const baseUrl = isProduction 
        ? 'https://dfm-production-36a5.up.railway.app'
        : 'http://localhost:3000';
    
    reply.send({ 
        message: '?? Server attivo',
        calendar: isAuth ? 'Connesso ?' : 'Non autenticato ??',
        authUrl: isAuth ? null : `${baseUrl}/oauth/authorize`
    });
});

fastify.get('/oauth/authorize', async (req, reply) => {
    try {
        const authUrl = googleClient.generateAuthUrl();
        console.log('?? Redirect a Google OAuth');
        reply.redirect(authUrl);
    } catch (error) {
        console.error('? Errore:', error);
        reply.status(500).send('Errore: ' + error.message);
    }
});

fastify.get('/oauth/callback', async (req, reply) => {
    const { code, error } = req.query;
    
    if (error) {
        console.error('? OAuth error:', error);
        return reply.status(400).send('Autenticazione fallita: ' + error);
    }
    
    if (!code) {
        return reply.status(400).send('Codice mancante');
    }
    
    try {
        console.log('?? Scambio codice...');
        await googleClient.getTokenFromCode(code);
        
        const isProduction = process.env.NODE_ENV === 'production';
        
        reply.type('text/html').send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Autenticazione Riuscita</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        padding: 20px;
                    }
                    .container {
                        background: white;
                        padding: 40px;
                        border-radius: 10px;
                        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                        max-width: 600px;
                    }
                    h1 { color: #4CAF50; margin-bottom: 20px; }
                    p { color: #666; font-size: 16px; line-height: 1.6; }
                    .icon { font-size: 60px; margin-bottom: 20px; text-align: center; }
                    .code-box {
                        background: #f5f5f5;
                        padding: 15px;
                        border-radius: 5px;
                        margin: 20px 0;
                        overflow-x: auto;
                        display: ${isProduction ? 'block' : 'none'};
                    }
                    pre { margin: 0; font-size: 12px; }
                    .warning {
                        background: #fff3cd;
                        border-left: 4px solid #ffc107;
                        padding: 15px;
                        margin: 20px 0;
                        display: ${isProduction ? 'block' : 'none'};
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">?</div>
                    <h1>Autenticazione Riuscita!</h1>
                    <p><strong>Google Calendar connesso con successo.</strong></p>
                    
                    ${isProduction ? `
                    <div class="warning">
                        <strong>?? IMPORTANTE PER RAILWAY:</strong>
                        <p>Controlla i log del server. Troverai il token da copiare e aggiungere come variabile <code>GOOGLE_TOKEN</code> su Railway.</p>
                    </div>
                    ` : '<p>Puoi chiudere questa finestra.</p>'}
                </div>
            </body>
            </html>
        `);
        
        console.log('? Autenticazione completata!');
    } catch (error) {
        console.error('? Errore:', error);
        reply.status(500).send('Errore: ' + error.message);
    }
});

fastify.get('/oauth/status', async (req, reply) => {
    const isAuth = await googleClient.isAuthenticated();
    reply.send({
        authenticated: isAuth,
        message: isAuth ? 'Connesso' : 'Non autenticato'
    });
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
        console.log('ðŸŽ§ Client Twilio connesso');
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
		let NotYetCommitted = false;  // True se è già stato committato 
		let GoAppend = true;  // False se è in corso la risposta  
		let SilenceToApply = true;
				
		// ðŸ†• RAG state
        let ragContext = "";
        let hasCalledRag = false;
        let pendingRagUpdate = false;
                	
		let speechTimeout = null;
        const MAX_SPEECH_DURATION = 6000; // 8 secondi
		

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

       // Initialize session with correct audio format for Twilio (PCMU)
        const initializeSession = () => {
		    const instructions = BASE_SYSTEM_MESSAGE + (ragContext ? `\n\nðŸŽ¯ Adatta il tuo stile seguendo questi esempi di conversazioni passate:\n${ragContext}` : "");
  
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { 
                        type: 'server_vad',
                        threshold: 0.55,
                        prefix_padding_ms: 200,
                        silence_duration_ms: 400,
						interrupt_response: false 
                    },
                    input_audio_format: 'g711_ulaw',    // IMPORTANT: Twilio sends PCMU
                    output_audio_format: 'g711_ulaw',   // Match PCMU output
                    voice: VOICE,
                    instructions: instructions,
                    modalities: ["text", "audio"],
					temperature: 0.8,
					tools: CALENDAR_TOOLS,
					tool_choice: "auto",
					input_audio_transcription: {
                        model: "whisper-1"
                    }
                }
            };
			
            // console.log('ðŸ‘‰ [SESSION INIT] Sending session update:', JSON.stringify(sessionUpdate, null, 2));
			console.log('ðŸ‘‰ [SESSION INIT] Sending session update:');

			if (ragContext) {
                console.log('ðŸ“š [RAG CONTEXT] Instructions include RAG context');
            }
            			
            try {
                openAiWs.send(JSON.stringify(sessionUpdate));
            } catch (err) {
                console.error('ðŸš¨ [SESSION INIT] Failed to send session update:', err);
            }
        };
		
	async function handleFunctionCall(functionName, args) {
      console.log("?? [FUNCTION CALL]", functionName, args);
      try {
        if (functionName === "find_available_slots") {
          const result = await calendar.parseSchedulingRequest(args.request);
          return JSON.stringify(result);
        }
			
		if (functionName === "create_appointment") {
			const [day, month, year] = args.date.split("/");
			const [hour, minute] = args.time.split(":");
  
			 // Crea Date locale (verrà interpretata correttamente da calendar.js)
			const appointmentDate = new Date(year, month - 1, day, hour, minute, 0);
  
			const result = await calendar.createAppointment(
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

		 // ðŸ†• Generate embedding and search similar conversations
        async function callRagOnFirstQuery(userText) {
            try {
                console.log('ðŸ” [RAG] Generating embedding for user query:', userText);
                
                const embeddingResponse = await openaiClient.embeddings.create({
                    model: "text-embedding-3-small",
                    input: userText
                });

                const queryEmbedding = embeddingResponse.data[0].embedding;
                console.log('âœ… [RAG] Embedding generated');

                // Search similar conversations
                const results = await searchMemory(queryEmbedding, 3);
                
                console.log('ðŸ“Š [RAG] Top 3 similar conversations:');
                results.forEach((r, idx) => {
                    console.log(`   ${idx + 1}. ${r.id} (score: ${r.score.toFixed(4)})`);
                    console.log(`      Preview: ${r.text.substring(0, 100)}...`);
                });

                // Format context from top results
                ragContext = results.map((r, idx) => 
                    `Esempio ${idx + 1} (${r.id}):\n${r.text}`
                ).join('\n\n');

                console.log('âœ¨ [RAG] Context updated, triggering session update');
                
                // Update session with new context
                initializeSession();
                
                hasCalledRag = true;
                
            } catch (err) {
                console.error('âŒ [RAG] Error:', err);
            }
        }
		
        const handleSpeechStartedEvent = () => {
            console.log('ðŸ”Š Speech started detected from OpenAI');
			NotYetCommitted = true;
			
			if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                console.log(`â±ï¸ Truncating last assistant item at ${elapsedTime} ms`);
                if (lastAssistantItem) {
					console.log('ðŸ”Š Speech truncated!!');
                    openAiWs.send(JSON.stringify({
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    }));
                }
                conn.send(JSON.stringify({ event: 'clear', streamSid }));
                markQueue = [];
				NotYetCommitted = true;
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = () => {
            if (streamSid) {
                // console.log('âœ… Sending mark to Twilio');
                conn.send(JSON.stringify({
                    event: 'mark',
                    streamSid,
                    mark: { name: 'responsePart' }
                }));
                markQueue.push('responsePart');
            }
        };

        openAiWs.on('open', () => {
			console.log('ðŸ§  Connessione OpenAI attiva');
            // console.log('ðŸ§  OpenAI WebSocket connection opened (readyState:', openAiWs.readyState, ')');
            initializeSession();
        });

        openAiWs.on("message", async (data) => {
            
            try {
                const msg = JSON.parse(data);
                
				// if (LOG_EVENT_TYPES.includes(msg.type)) {
                   // console.log(`[OpenAI] ${msg.type}`, msg);
                    // console.log(`[OpenAI EVENT] ${msg.type}`, JSON.stringify(msg, null, 2));
                // }
				
				
				// Reinvia session.update dopo session.created
				if (msg.type === "session.created") {
					console.log("SESSION CREATED RECEIVED");	
				}

				if (msg.type === "session.updated") {
					console.log("SESSION UPDATED RECEIVED:");
					// console.log(JSON.stringify(msg.session, null, 2));
				}
				
				// VAD ha ricevuto commit
				if (msg.type === "input_audio_buffer.committed") {
					console.log("?INPUT COMMITTED - START RESPONSE");
					console.log('?? Requesting response with RAG context');
					GoAppend = false;
			
					if (SilenceToApply) {
					// Invia al VAD 500 msec di silenzio per forzare anche lo speech.stopped 
					console.log("?? 500 silence");
					openAiWs.send(JSON.stringify({
						type: 'input_audio_buffer.append',
						audio: silenceBase64
						}));
					}	
					
					openAiWs.send(JSON.stringify({
						type: "response.create",
						response: {
							modalities: ["audio", "text"],
							voice: VOICE,
							temperature: 0.8
						}
					}));					
				}
				
				if (msg.type === "response.created") {
					console.log("RESPONSE CREATED");
					//console.log(JSON.stringify(msg.session, null, 2));
				}
				
                if (msg.type === 'response.audio.delta' && msg.delta) {
                    // console.log('ðŸ”Š [AUDIO DELTA] Sending audio chunk to Twilio');
                    conn.send(JSON.stringify({
                        event: 'media',
                        streamSid,
                        media: { payload: msg.delta }
                    }));

                    if (!responseStartTimestampTwilio) {
                        // console.log('â³ First audio chunk, marking timestamp');
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }

                    if (msg.item_id) lastAssistantItem = msg.item_id;

                    sendMark();
                }
				
				// ðŸ†• Capture user speech for RAG (first time only)
                if (msg.type === 'conversation.item.input_audio_transcription.completed' && !hasCalledRag) {
                    const userText = msg.transcript;
                    if (userText && userText.trim().length > 0) {
                        console.log('ðŸ’¬ [FIRST USER MESSAGE]:', userText);
                        callRagOnFirstQuery(userText);
                    }
                }

                if (msg.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
					
					if (speechTimeout) clearTimeout(speechTimeout);
						speechTimeout = setTimeout(() => {
							console.warn('? [TIMEOUT] Forcing speech_stopped after 8s');
							NotYetCommitted = false;
							
							if (openAiWs.readyState === WebSocket.OPEN) {
								openAiWs.send(JSON.stringify({
									type: 'input_audio_buffer.commit'
								}));				
							} 
						}, MAX_SPEECH_DURATION);
                }
				
				if (msg.type === 'input_audio_buffer.speech_stopped') {
					console.log("?? SPEECH STOPPED");
					SilenceToApply = false;
					
					if (speechTimeout) {
					clearTimeout(speechTimeout);
					speechTimeout = null;
					}

					// Se c'è audio utente nel buffer, committiamo subito (turno naturale)
					if (openAiWs.readyState === WebSocket.OPEN && NotYetCommitted) {
						openAiWs.send(JSON.stringify({
							type: 'input_audio_buffer.commit'
						}));
						NotYetCommitted = false;
						console.log('!! speech_stopped naturale, ---> commit');
					} else {
						console.log('?? speech_stopped ma già committato, non faccio commit');
					}
				}
				
				       // ? GESTIONE FUNCTION CALLS
				if (msg.type === 'response.function_call_arguments.done') {
					console.log('?? Function call:', msg.name);
					const functionName = msg.name;
					const args = JSON.parse(msg.arguments);
                    
					const result = await handleFunctionCall(functionName, args);
                    
					console.log("?? Risultato funzione:", JSON.parse(result));
				
					// Invia il risultato della funzione
					openAiWs.send(JSON.stringify({
						type: 'conversation.item.create',
							item: {
								type: 'function_call_output',
								call_id: msg.call_id,
								output: result
							}	
					}));
      
					// Forza la nuova risposta
					openAiWs.send(JSON.stringify({
						type: 'response.create'
					}));
				}
				
				// Reinvia session.update dopo session.created
				if (msg.type === "response.done") {
					console.log("RESPONSE DONE");
					GoAppend = true;
					SilenceToApply = true;
				}
				
            } catch (err) {
                console.error('Errore parsing da OpenAI:', err);
            }
        });

        conn.on('message', (msg) => {
            // console.log('ðŸ“¨ [FROM TWILIO] Message received');
            try {
                const data = JSON.parse(msg);
               // console.log('[FROM TWILIO] Event:', data.event);
                switch (data.event) {
                    case 'media':
					
		               // latestMediaTimestamp = data.media.timestamp;
                       // console.log(`ðŸŽ™ï¸ [MEDIA] Timestamp: ${latestMediaTimestamp}`);
					
					    if (openAiWs.readyState === WebSocket.OPEN && GoAppend) {
                            // console.log('âž¡ï¸ Sending audio to OpenAI (buffer.append)');
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('ðŸš€ Stream started. SID:', streamSid);
                        break;
                    case 'mark':
                        // console.log('âœ… [MARK] Acknowledged by Twilio');
                        if (markQueue.length > 0) markQueue.shift();
                        break;
                    default:
                        console.log('â„¹ï¸ [OTHER EVENT] Full data:', JSON.stringify(data));
                }
            } catch (err) {
                console.error('Errore parsing da Twilio:', err);
            }
        });

        conn.on('close', () => {
            console.log('âŒ Twilio WebSocket connection closed');
            if (openAiWs.readyState === WebSocket.OPEN) {
                console.log('ðŸ”’ Closing OpenAI WebSocket as well');
                openAiWs.close();
            } else {
                console.log('âœ… OpenAI WebSocket already closed');
            }
        });

        openAiWs.on('error', (err) => {
            console.error('Errore OpenAI WS:', err);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error('Errore di avvio:', err);
        process.exit(1);
    }
    console.log(`ðŸš€ Server avviato su http://0.0.0.0:${PORT}`);
});
