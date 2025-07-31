const express = require('express');
const axios = require('axios');
const { handleIncomingMessage } = require('./app'); // Importa tu bot actual
require('dotenv').config();

const app = express();
app.use(express.json());

// Configuración del webhook (igual que antes)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'citasconsultorio';

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verificado');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Middleware de traducción
app.post('/webhook', async (req, res) => {
    const body = req.body;
    console.log('📩 Mensaje entrante (Meta):', JSON.stringify(body, null, 2));

    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from; // Ej: "51987654321"
        const text = message.text?.body || '';

        // Emula el formato que espera tu bot de Baileys
        const baileysFormat = {
            from: from,
            body: text,
            // Añade otros campos si tu bot los usa (ej: nombre, timestamp)
        };

        // Llama a TU lógica existente (app.js)
        await handleIncomingMessage(baileysFormat); // ¡Esta función debe existir en tu app.js!
    }

    res.sendStatus(200);
});

// Función para enviar mensajes (adaptada a Meta)
async function sendMessage(to, text) {
    await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to: to,
            text: { body: text }
        },
        {
            headers: {
                'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }
    );
}

// Exporta para usarlo en app.js
module.exports = { sendMessage };

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook escuchando en puerto ${PORT}`));