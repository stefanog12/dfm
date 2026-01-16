import express from 'express';
import * as googleClient from './googleClient.js';

const router = express.Router();

/**
 * Route per iniziare il flusso OAuth
 */
router.get('/oauth/authorize', (req, res) => {
    try {
        const authUrl = googleClient.generateAuthUrl();
        console.log('🔐 Redirect a Google OAuth');
        res.redirect(authUrl);
    } catch (error) {
        console.error('❌ Errore generazione auth URL:', error);
        res.status(500).send('Errore durante l\'autenticazione: ' + error.message);
    }
});

/**
 * Callback OAuth - Google reindirizza qui dopo il consenso
 */
router.get('/oauth/callback', async (req, res) => {
    const { code, error } = req.query;
    
    if (error) {
        console.error('❌ Errore OAuth:', error);
        return res.status(400).send('Autenticazione fallita: ' + error);
    }
    
    if (!code) {
        return res.status(400).send('Codice di autorizzazione mancante');
    }
    
    try {
        console.log('🔄 Scambio codice con token...');
        await googleClient.getTokenFromCode(code);
        
        res.send(`
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
                        height: 100vh;
                        margin: 0;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    }
                    .container {
                        background: white;
                        padding: 40px;
                        border-radius: 10px;
                        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                        text-align: center;
                    }
                    h1 { color: #4CAF50; margin-bottom: 20px; }
                    p { color: #666; font-size: 18px; }
                    .icon { font-size: 60px; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">✅</div>
                    <h1>Autenticazione Riuscita!</h1>
                    <p>Google Calendar è stato connesso con successo.</p>
                    <p><strong>Puoi chiudere questa finestra.</strong></p>
                </div>
            </body>
            </html>
        `);
        
        console.log('✅ Autenticazione completata!');
    } catch (error) {
        console.error('❌ Errore durante lo scambio token:', error);
        res.status(500).send('Errore durante l\'autenticazione: ' + error.message);
    }
});

/**
 * Route per controllare lo stato dell'autenticazione
 */
router.get('/oauth/status', async (req, res) => {
    const isAuth = await googleClient.isAuthenticated();
    res.json({
        authenticated: isAuth,
        message: isAuth 
            ? 'Google Calendar connesso' 
            : 'Autenticazione necessaria - visita /oauth/authorize'
    });
});

export default router;
