import { createOAuthClient } from "./googleClient.js";

let savedTokens = null;

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

export default async function authRoutes(fastify, opts) {

  // STEP 1 — Redirect a Google
  fastify.get("/auth/google", async (req, reply) => {
    const oauth2Client = createOAuthClient();

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
    });

    reply.redirect(url);
  });

  // STEP 2 — Callback da Google
  fastify.get("/oauth2/callback", async (req, reply) => {
    const oauth2Client = createOAuthClient();
    const code = req.query.code;

    try {
      const { tokens } = await oauth2Client.getToken(code);
      savedTokens = tokens;

      reply.send("Google Calendar collegato correttamente!");
    } catch (err) {
      console.error("Errore OAuth:", err);
      reply.status(500).send("Errore durante l'autenticazione");
    }
  });

  // Funzione per calendar.js
  fastify.decorate("getAuthorizedClient", () => {
    if (!savedTokens) return null;
    const client = createOAuthClient();
    client.setCredentials(savedTokens);
    return client;
  });
}
