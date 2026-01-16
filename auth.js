import { createOAuthClient } from "./googleClient.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

let savedTokens = null;

export default async function authRoutes(fastify, opts) {
  fastify.get("/auth/google", async (req, reply) => {
    const oauth2Client = createOAuthClient();

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
    });

    reply.redirect(url);
  });

  fastify.get("/oauth2/callback", async (req, reply) => {
    const oauth2Client = createOAuthClient();
    const code = req.query.code;

    try {
      const { tokens } = await oauth2Client.getToken(code);
      savedTokens = tokens;
      console.log("✅ Google OAuth tokens salvati");
      reply.send("Google Calendar collegato correttamente! Puoi chiudere questa pagina.");
    } catch (err) {
      console.error("Errore OAuth:", err);
      reply.status(500).send("Errore durante l'autenticazione con Google");
    }
  });

  fastify.decorate("getAuthorizedClient", () => {
    if (!savedTokens) return null;
    const client = createOAuthClient();
    client.setCredentials(savedTokens);
    return client;
  });
}
