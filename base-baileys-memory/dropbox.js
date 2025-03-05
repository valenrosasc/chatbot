const Dropbox = require('dropbox').Dropbox;
const fetch = require('node-fetch'); // Necesario para usar Dropbox en Node.js
const fs = require('fs');
require('dotenv').config(); // Para cargar variables de entorno

// Configurar Dropbox con tu Access Token
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN, fetch });

// Ruta de la base de datos SQLite
const DB_PATH = 'C:/Users/valen/Downloads/chatmollg/base-baileys-memory/citas.db';

// Función para subir la base de datos a Dropbox
async function uploadDatabase() {
    try {
        const fileContents = fs.readFileSync(DB_PATH);
        await dbx.filesUpload({
            path: '/citas.db', // Ruta en Dropbox
            contents: fileContents,
            mode: { ".tag": "overwrite" } // Sobrescribir si ya existe
        });
        console.log("📤 Base de datos subida a Dropbox correctamente.");
    } catch (error) {
        console.error("❌ Error al subir la base de datos:", error);
    }
}

// Función para descargar la base de datos desde Dropbox
async function downloadDatabase() {
    try {
        const response = await dbx.filesDownload({ path: '/citas.db' });
        fs.writeFileSync(DB_PATH, response.result.fileBinary);
        console.log("📥 Base de datos descargada desde Dropbox.");
    } catch (error) {
        console.error("❌ Error al descargar la base de datos:", error);
    }
}

// Exportar funciones para usarlas en otros archivos
module.exports = { uploadDatabase, downloadDatabase };
