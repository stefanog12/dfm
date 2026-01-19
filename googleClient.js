import { google } from 'googleapis';
import fs from 'fs/promises';

const REDIRECT_URI = process.env.REDIRECT_URI || 'https://dfm-production-36a5.up.railway.app/oauth/callback';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let oauth2Client = null;
let tokenData = null; // In-memory token storage per Railway

/**
 * Carica credenziali da variabile d'ambiente (Railway) o file (locale)
 */
async function loadCredentials() {
    try {
        let credentials;
        
        if (IS_PRODUCTION && process.env.GOOGLE_CREDENTIALS) {
            // Railway: usa variabile d'ambiente
            console.log('📦 Caricando credenziali da variabile d\'ambiente');
            credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        } else {
            // Locale: usa file
            console.log('📁 Caricando credenziali da file');
            const content = await fs.readFile('./credentials.json', 'utf-8');
            credentials = JSON.parse(content);
        }
        
        const { client_id, client_secret } = credentials.web || credentials.installed;
        
        oauth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            REDIRECT_URI
        );
        
        console.log('✅ Credenziali Google caricate');
        console.log('🔗 Redirect URI:', REDIRECT_URI);
        return oauth2Client;
    } catch (error) {
        console.error('❌ Errore caricamento credenziali:', error.message);
        throw new Error('Credenziali Google non trovate. Imposta GOOGLE_CREDENTIALS su Railway.');
    }
}

/**
 * Carica token da variabile d'ambiente (Railway) o file (locale)
 */
async function loadToken() {
    try {
        let token;
        
        if (IS_PRODUCTION && process.env.GOOGLE_TOKEN) {
            // Railway: usa variabile d'ambiente
            console.log('🔑 Caricando token da variabile d\'ambiente');
            token = process.env.GOOGLE_TOKEN;
        } else {
            // Locale: usa file
            console.log('🔑 Caricando token da file');
            token = await fs.readFile('./token.json', 'utf-8');
        }
        
        tokenData = JSON.parse(token);
        oauth2Client.setCredentials(tokenData);
        console.log('✅ Token Google caricato');
        return true;
    } catch (error) {
        console.log('⚠️ Token non trovato - necessaria autenticazione');
        console.log('👉 Visita: ' + REDIRECT_URI.replace('/oauth/callback', '/oauth/authorize'));
        return false;
    }
}

/**
 * Salva token
 * IMPORTANTE: Su Railway, dopo l'autenticazione, devi copiare il token
 * dalla console e aggiungerlo manualmente come variabile GOOGLE_TOKEN
 */
async function saveToken(tokens) {
    try {
        tokenData = tokens;
        const tokenString = JSON.stringify(tokens, null, 2);
        
        if (IS_PRODUCTION) {
            // Railway: stampa il token da copiare manualmente
            console.log('');
            console.log('='.repeat(80));
            console.log('🔐 TOKEN GENERATO - COPIA E SALVA SU RAILWAY');
            console.log('='.repeat(80));
            console.log('');
            console.log('1. Vai su Railway → Variabili');
            console.log('2. Aggiungi nuova variabile:');
            console.log('   Nome: GOOGLE_TOKEN');
            console.log('   Valore: (copia il JSON qui sotto)');
            console.log('');
            console.log(tokenString);
            console.log('');
            console.log('='.repeat(80));
            console.log('');
        } else {
            // Locale: salva su file
            await fs.writeFile('./token.json', tokenString);
            console.log('✅ Token salvato su file');
        }
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
        prompt: 'consent',
    });
    
    return authUrl;
}

/**
 * Scambia codice con token
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
 * Ottieni client autenticato
 */
async function getAuthenticatedClient() {
    if (!oauth2Client) {
        await loadCredentials();
    }
    
    const hasToken = await loadToken();
    
    if (!hasToken) {
        throw new Error('Autenticazione necessaria');
    }
    
    return oauth2Client;
}

/**
 * Verifica autenticazione
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
 * Inizializza
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
