import express from "express";
import { createOAuthClient } from "./googleClient.js";

const router = express.Router();

// In produzione: salva in DB
let savedTokens = null;

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// STEP 1: L’utente viene mandato a Google
router.get("/auth/google", (req, res) => {
  const oauth2Client = createOAuthClient();

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  res.redirect(url);
});

// STEP 2: Google rimanda qui con ?code=
router.get("/oauth2/callback", async (req, res) => {
  const oauth2Client = createOAuthClient();
  const code = req.query.code;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    savedTokens = tokens;

    res.send("Google Calendar collegato correttamente!");
  } catch (err) {
    console.error("Errore OAuth:", err);
    res.status(500).send("Errore durante l'autenticazione");
  }
});

// Funzione per ottenere un client autenticato
export function getAuthorizedClient() {
  if (!savedTokens) return null;

  const client = createOAuthClient();
  client.setCredentials(savedTokens);
  return client;
}

export default router;
