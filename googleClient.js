import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';

const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://dfm-production-36a5.up.railway.app/oauth2/callback';

let oauth2Client = null;

/**
 * Carica le credenziali e crea il client OAuth2
 */
async function loadCredentials() {
    try {
        const content = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(content);
        const { client_id, client_secret } = credentials.web || credentials.installed;
        
        oauth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            REDIRECT_URI
        );
        
        console.log('✅ Credenziali Google caricate');
        return oauth2Client;
    } catch (error) {
        console.error('❌ Errore caricamento credenziali:', error.message);
        throw new Error('File credentials.json non trovato o non valido');
    }
}

/**
 * Carica il token salvato se esiste
 */
async function loadToken() {
    try {
        const token = await fs.readFile(TOKEN_PATH, 'utf-8');
        const tokenData = JSON.parse(token);
        oauth2Client.setCredentials(tokenData);
        console.log('✅ Token Google caricato');
        return true;
    } catch (error) {
        console.log('⚠️ Token non trovato - necessaria autenticazione');
        return false;
    }
}

/**
 * Salva il token su file
 */
async function saveToken(tokens) {
    try {
        await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('✅ Token salvato');
    } catch (error) {
        console.error('❌ Errore salvataggio token:', error);
    }
}

/**
 * Genera URL di autorizzazione
 */
function generateAuthUrl() {
    if (!oauth2Client) {
        throw new Error('OAuth2 client non inizializzato');
    }
    
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
        prompt: 'consent', // Forza il consenso per ottenere refresh token
    });
    
    return authUrl;
}

/**
 * Scambia il codice di autorizzazione con i token
 */
async function getTokenFromCode(code) {
    if (!oauth2Client) {
        throw new Error('OAuth2 client non inizializzato');
    }
    
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        await saveToken(tokens);
        return tokens;
    } catch (error) {
        console.error('❌ Errore ottenimento token:', error);
        throw error;
    }
}

/**
 * Ottieni il client autenticato
 */
async function getAuthenticatedClient() {
    if (!oauth2Client) {
        await loadCredentials();
    }
    
    const hasToken = await loadToken();
    
    if (!hasToken) {
        throw new Error('Autenticazione necessaria - visita /oauth/authorize');
    }
    
    return oauth2Client;
}

/**
 * Verifica se il client è autenticato
 */
async function isAuthenticated() {
    try {
        if (!oauth2Client) {
            await loadCredentials();
        }
        return await loadToken();
    } catch (error) {
        return false;
    }
}

/**
 * Inizializza il client OAuth2
 */
async function initialize() {
    await loadCredentials();
    await loadToken();
}

export {
    initialize,
    getAuthenticatedClient,
    generateAuthUrl,
    getTokenFromCode,
    isAuthenticated,
};
