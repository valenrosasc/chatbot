const db = require('./database');
const nodemailer = require('nodemailer');

// Configuración de Nodemailer (para correos)
const transporter = nodemailer.createTransport({
    service: 'Gmail', // Usar Gmail como servicio
    auth: {
        user: process.env.GMAIL_USER, // Tu correo
        pass: process.env.GMAIL_PASSWORD, // Contraseña de aplicación
    },
});

// Función para leer citas desde SQLite
const leerCitasDesdeSQLite = async () => {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM citas', (err, rows) => {
            if (err) {
                console.error('Error leyendo citas desde SQLite:', err.message);
                reject(err);
            } else {
                console.log('Citas leídas correctamente:', rows);
                resolve(rows);
            }
        });
    });
};

// Función para guardar en SQLite
const guardarEnSQLite = async (cedula, nombre, celular, fecha, hora) => {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO citas (cedula, nombre, celular, fecha, hora) VALUES (?, ?, ?, ?, ?)',
            [cedula, nombre, celular, fecha, hora],
            function (err) { // Usamos "function" para acceder a "this.lastID"
                if (err) {
                    console.error('Error guardando en SQLite:', err.message);
                    reject(false);
                } else {
                    console.log('Cita guardada en SQLite. ID:', this.lastID); // Muestra el ID de la cita guardada
                    resolve(true);
                }
            }
        );
    });
};

// Función para eliminar una cita en SQLite
const eliminarCitaEnSQLite = async (cedula, fecha, hora) => {
    return new Promise((resolve, reject) => {
        const query = `DELETE FROM citas WHERE cedula = ? AND fecha = ? AND hora = ?`;
        db.run(query, [cedula, fecha, hora], function (err) {
            if (err) {
                console.error('Error al eliminar la cita:', err.message);
                reject(false);
            } else {
                console.log('Cita eliminada correctamente:', { cedula, fecha, hora }); // Depuración
                resolve(true);
            }
        });
    });
};

// Función para enviar correo
const enviarCorreo = (destinatario, asunto, mensaje) => {
    const mailOptions = {
        from: process.env.GMAIL_USER,
        to: destinatario,
        subject: asunto,
        html: `<h1>Nueva cita agendada</h1>
               <p><strong>Cédula:</strong> ${mensaje.cedula}</p>
               <p><strong>Nombre:</strong> ${mensaje.nombre}</p>
               <p><strong>Celular:</strong> ${mensaje.celular}</p>
               <p><strong>Fecha:</strong> ${mensaje.fecha}</p>
               <p><strong>Hora:</strong> ${mensaje.hora}</p>`,
    };

    console.log('Enviando correo...', mailOptions); // Muestra los detalles del correo

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Error enviando el correo:', error); // Muestra el error
        } else {
            console.log('Correo enviado:', info.response); // Muestra la respuesta del servidor
        }
    });
};

// Exportar las funciones
module.exports = {
    leerCitasDesdeSQLite,
    guardarEnSQLite,
    eliminarCitaEnSQLite,
    enviarCorreo,
};