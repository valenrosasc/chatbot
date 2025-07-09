const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'citasconsultorio';

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

app.post('/webhook', async (req, res) => {
    const body = req.body;
    console.log('📩 Webhook recibido:', JSON.stringify(body, null, 2));

    // Procesa solo mensajes entrantes
    if (
        body.object &&
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages
    ) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from; // número del usuario
        const text = message.text?.body || '';

        // Ejemplo: responde "Hola" automáticamente
        if (text.toLowerCase().includes('hola')) {
            try {
                await axios.post(
                    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
                    {
                        messaging_product: 'whatsapp',
                        to: from,
                        text: { body: '¡Hola! Soy tu bot automático.' }
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                console.log('✅ Respuesta enviada a WhatsApp');
            } catch (err) {
                console.error('❌ Error al responder:', err.response?.data || err.message);
            }
        }
    }

    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook escuchando en puerto ${PORT}`);
});