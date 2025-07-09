const express = require('express');
const app = express();
app.use(express.json());

// Tu token de verificación (el mismo que pusiste en Meta)
const VERIFY_TOKEN = 'citasconsultorio';

// Endpoint para verificación de webhook (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verificado correctamente');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Endpoint para recibir mensajes (POST)
app.post('/webhook', (req, res) => {
    const body = req.body;
    console.log('📩 Webhook recibido:', JSON.stringify(body, null, 2));
    // Aquí puedes procesar los mensajes entrantes
    res.sendStatus(200);
});

// Inicia el servidor en el puerto 3000 o el que uses en Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook escuchando en puerto ${PORT}`);
});