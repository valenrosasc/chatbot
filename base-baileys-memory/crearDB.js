console.log('Ejecutando crearDB.js...');

const sqlite3 = require('sqlite3').verbose();

// Conectar a la base de datos (o crearla si no existe)
const db = new sqlite3.Database('./citas.db', (err) => {
    if (err) {
        console.error('Error conectando a la base de datos:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
    }
});

// Crear la tabla si no existe
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS citas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cedula TEXT NOT NULL,
            nombre TEXT NOT NULL,
            celular TEXT NOT NULL,
            fecha TEXT NOT NULL,
            hora TEXT NOT NULL
        )
    `, (err) => {
        if (err) {
            console.error('Error creando la tabla:', err.message);
        } else {
            console.log('Tabla "citas" creada o ya existente.');
        }
    });
});

// Cerrar la conexión
db.close();