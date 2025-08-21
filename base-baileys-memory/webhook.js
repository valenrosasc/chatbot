const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const moment = require('moment');
const { Dropbox } = require('dropbox');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Configuración de rutas
const DB_PATH = path.join(__dirname, 'citas.db');

// Configura el cliente de Dropbox
let dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });

// Objeto global para almacenar datos temporales del usuario
const userData = {};

// Función para obtener un nuevo access token usando el refresh token
const obtenerNuevoAccessToken = async () => {
    try {
        const response = await axios.post(
            'https://api.dropbox.com/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
                client_id: process.env.DROPBOX_CLIENT_ID,
                client_secret: process.env.DROPBOX_CLIENT_SECRET,
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );

        const accessToken = response.data.access_token;
        console.log('Nuevo access token generado:', accessToken);
        return accessToken;
    } catch (error) {
        console.error('Error al obtener nuevo access token:', error.response ? error.response.data : error.message);
        return null;
    }
};

// Función para renovar el access token si es necesario
const renovarAccessTokenSiEsNecesario = async () => {
    try {
        // Intenta una operación simple para verificar si el token es válido
        await dbx.usersGetCurrentAccount();
    } catch (error) {
        if (error.status === 401) { // Token expirado o inválido
            const nuevoAccessToken = await obtenerNuevoAccessToken();
            if (nuevoAccessToken) {
                dbx = new Dropbox({ accessToken: nuevoAccessToken });
                console.log('Access token renovado correctamente.');
            } else {
                throw new Error('No se pudo renovar el access token.');
            }
        } else {
            throw error;
        }
    }
};

// Función para subir la base de datos a Dropbox
const subirBaseDeDatosADropbox = async () => {
    await renovarAccessTokenSiEsNecesario();
    try {
        const dbFile = fs.readFileSync(DB_PATH);

        const response = await dbx.filesUpload({
            path: '/citas.db',
            contents: dbFile,
            mode: 'overwrite',
        });

        console.log('Base de datos subida a Dropbox:', response.result);
        return true;
    } catch (error) {
        console.error('Error al subir la base de datos a Dropbox:', error);
        return false;
    }
};

// Función para descargar la base de datos desde Dropbox
const descargarBaseDeDatosDesdeDropbox = async () => {
    await renovarAccessTokenSiEsNecesario();
    try {
        const response = await dbx.filesDownload({ path: '/citas.db' });
        fs.writeFileSync(DB_PATH, response.result.fileBinary);

        console.log('Base de datos descargada desde Dropbox.');
        return true;
    } catch (error) {
        console.error('Error al descargar la base de datos desde Dropbox:', error);
        return false;
    }
};

// Configuración de la base de datos SQLite
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error al abrir la base de datos:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
        db.run(`CREATE TABLE IF NOT EXISTS citas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cedula TEXT NOT NULL,
            nombre TEXT NOT NULL,
            celular TEXT NOT NULL,
            fecha TEXT NOT NULL,
            hora TEXT NOT NULL,
            UNIQUE(fecha, hora)
        )`);
    }
});

// Función para leer citas desde SQLite
const leerCitasDesdeSQLite = () => {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM citas ORDER BY fecha, hora', [], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
};

// Función para guardar en SQLite
const guardarEnSQLite = (cedula, nombre, celular, fecha, hora) => {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO citas (cedula, nombre, celular, fecha, hora) VALUES (?, ?, ?, ?, ?)',
            [cedula, nombre, celular, fecha, hora],
            function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(true);
                }
            }
        );
    });
};

// Función para eliminar cita en SQLite
const eliminarCitaEnSQLite = (cedula, fecha, hora) => {
    return new Promise((resolve, reject) => {
        db.run(
            'DELETE FROM citas WHERE cedula = ? AND fecha = ? AND hora = ?',
            [cedula, fecha, hora],
            function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes > 0);
                }
            }
        );
    });
};

// Configuración del transporter para nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
    },
});

// Función para enviar correo
const enviarCorreo = (to, subject, data) => {
    const mailOptions = {
        from: process.env.GMAIL_USER,
        to,
        subject,
        text: `Nueva cita agendada:\n\nCédula: ${data.cedula}\nNombre: ${data.nombre}\nCelular: ${data.celular}\nFecha: ${data.fecha}\nHora: ${data.hora}`,
    };

    return transporter.sendMail(mailOptions);
};

// Función para agendar una cita
const agendarCita = async (cedula, nombre, celular, fecha, hora) => {
    try {
        // Leer citas existentes desde SQLite
        const citas = await leerCitasDesdeSQLite();

        // Verificar si la fecha y hora ya están ocupadas
        const citaExistente = citas.find((cita) => cita.fecha === fecha && cita.hora === hora);
        if (citaExistente) {
            return `⚠️ La hora ${hora} del ${fecha} ya está ocupada.`;
        }

        // Verificar si el usuario ya tiene dos citas agendadas en la misma fecha
        const citasUsuario = citas.filter((cita) => cita.cedula === cedula && cita.fecha === fecha);
        if (citasUsuario.length >= 2) {
            return `⚠️ Ya tienes dos citas agendadas para la fecha ${fecha}.`;
        }

        // Guardar en SQLite
        const resultado = await guardarEnSQLite(cedula, nombre, celular, fecha, hora);

        if (resultado) {
            // Enviar correo
            const mensajeCorreo = { cedula, nombre, celular, fecha, hora };
            await enviarCorreo(process.env.GMAIL_USER, 'Nueva cita agendada', mensajeCorreo);

            // Subir la base de datos a Dropbox después de agendar la cita
            await subirBaseDeDatosADropbox();

            return `✅ Cita agendada para la fecha ${fecha} a las ${hora}.`;
        } else {
            return `⚠️ Hubo un error al agendar la cita. Intenta nuevamente.`;
        }
    } catch (error) {
        console.error('Error en agendarCita:', error.message);
        return `⚠️ Hubo un error al procesar la solicitud. Intenta nuevamente.`;
    }
};

// Función para generar las próximas 7 fechas hábiles (excluyendo sábados y domingos)
const generarFechasDisponibles = () => {
    const fechaActual = moment().add(1, 'day'); // Comienza desde mañana
    const fechasDisponibles = [];
    let contador = 0;

    while (fechasDisponibles.length < 7) {
        const fecha = fechaActual.clone().add(contador, 'days');
        if (fecha.day() !== 6 && fecha.day() !== 0) { // Excluye sábados (6) y domingos (0)
            fechasDisponibles.push(fecha.format('DD-MM-YYYY'));
        }
        contador++;
    }

    return fechasDisponibles;
};

// Horarios disponibles para agendar citas
const horariosDisponibles = ['15:00', '15:30', '16:00', '16:30', '17:00', '17:30'];

// Función para enviar mensajes a través de WhatsApp API
const enviarMensajeWhatsApp = async (numero, mensaje) => {
    try {
        const response = await axios.post(
            `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: numero,
                type: "text",
                text: { body: mensaje }
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error al enviar mensaje por WhatsApp:', error.response?.data || error.message);
        throw error;
    }
};

// Función para manejar el flujo de agendar cita
// ... código anterior sin cambios ...

// Función para manejar el flujo de agendar cita
const manejarAgendarCita = async (numero, mensaje) => {
    if (!userData[numero]) {
        userData[numero] = { paso: 'solicitar_cedula' };
        await enviarMensajeWhatsApp(numero, 'Para agendar una cita, por favor escribe tu número de cédula:');
        return;
    }

    const datosUsuario = userData[numero];

    switch (datosUsuario.paso) {
        case 'solicitar_cedula':
            if (!/^\d+$/.test(mensaje)) {
                await enviarMensajeWhatsApp(numero, '⚠️ La cédula debe contener solo números. Por favor, escribe tu número de cédula nuevamente:');
                return;
            }
            datosUsuario.cedula = mensaje;
            datosUsuario.paso = 'solicitar_nombre';
            await enviarMensajeWhatsApp(numero, 'Por favor, escribe tu nombre completo:');
            break;

        case 'solicitar_nombre':
            if (!mensaje.trim()) {
                await enviarMensajeWhatsApp(numero, '⚠️ El nombre no puede estar vacío. Por favor, escribe tu nombre completo nuevamente:');
                return;
            }
            datosUsuario.nombre = mensaje.trim();
            datosUsuario.paso = 'solicitar_celular';
            await enviarMensajeWhatsApp(numero, 'Por favor, escribe tu número de celular:');
            break;

        case 'solicitar_celular':
            if (!/^\d+$/.test(mensaje)) {
                await enviarMensajeWhatsApp(numero, '⚠️ El celular debe contener solo números. Por favor, escribe tu número de celular nuevamente:');
                return;
            }
            datosUsuario.celular = mensaje;
            datosUsuario.paso = 'seleccionar_fecha';
            
            // Generar fechas disponibles
            const fechasDisponibles = generarFechasDisponibles();
            datosUsuario.fechasDisponibles = fechasDisponibles;
            
            let mensajeFechas = 'Selecciona una fecha disponible respondiendo con el número:\n';
            fechasDisponibles.forEach((fecha, index) => {
                mensajeFechas += `${index + 1}. ${fecha}\n`;
            });
            mensajeFechas += '\nResponde con 0 para volver al menú principal.';
            
            await enviarMensajeWhatsApp(numero, mensajeFechas);
            break;

        case 'seleccionar_fecha':
            if (mensaje === '0') {
                delete userData[numero];
                await mostrarMenuPrincipal(numero);
                return;
            }
            
            const indiceFecha = parseInt(mensaje) - 1;
            const fechasDisponiblesArray = datosUsuario.fechasDisponibles; // Cambiado el nombre aquí
            
            if (isNaN(indiceFecha) || indiceFecha < 0 || indiceFecha >= fechasDisponiblesArray.length) {
                let mensajeError = '⚠️ Opción inválida. Por favor, selecciona una fecha disponible respondiendo con el número:\n';
                fechasDisponiblesArray.forEach((fecha, index) => {
                    mensajeError += `${index + 1}. ${fecha}\n`;
                });
                mensajeError += '\nResponde con 0 para volver al menú principal.';
                
                await enviarMensajeWhatsApp(numero, mensajeError);
                return;
            }
            
            datosUsuario.fecha = fechasDisponiblesArray[indiceFecha];
            datosUsuario.paso = 'seleccionar_hora';
            
            let mensajeHorarios = `Fecha seleccionada: ${datosUsuario.fecha}\n`;
            mensajeHorarios += 'Selecciona un horario disponible respondiendo con el número:\n';
            horariosDisponibles.forEach((hora, index) => {
                mensajeHorarios += `${index + 1}. ${hora}\n`;
            });
            mensajeHorarios += '\nResponde con 0 para volver al menú principal.';
            
            await enviarMensajeWhatsApp(numero, mensajeHorarios);
            break;

        case 'seleccionar_hora':
            if (mensaje === '0') {
                delete userData[numero];
                await mostrarMenuPrincipal(numero);
                return;
            }
            
            const indiceHora = parseInt(mensaje) - 1;
            
            if (isNaN(indiceHora) || indiceHora < 0 || indiceHora >= horariosDisponibles.length) {
                let mensajeError = '⚠️ Opción inválida. Por favor, selecciona un horario disponible respondiendo con el número:\n';
                horariosDisponibles.forEach((hora, index) => {
                    mensajeError += `${index + 1}. ${hora}\n`;
                });
                mensajeError += '\nResponde con 0 para volver al menú principal.';
                
                await enviarMensajeWhatsApp(numero, mensajeError);
                return;
            }
            
            const horaSeleccionada = horariosDisponibles[indiceHora];
            const { cedula, nombre, celular, fecha } = datosUsuario;
            
            const resultado = await agendarCita(cedula, nombre, celular, fecha, horaSeleccionada);
            await enviarMensajeWhatsApp(numero, resultado);
            await enviarMensajeWhatsApp(numero, 'Si deseas realizar otra operación, escribe "menu" para volver al menú principal.');
            
            delete userData[numero];
            break;
    }
};

// ... el resto del código permanece igual ...

// Función para manejar el flujo de cancelar cita
const manejarCancelarCita = async (numero, mensaje) => {
    if (!userData[numero] || !userData[numero].cancelarPaso) {
        userData[numero] = { cancelarPaso: 'solicitar_cedula' };
        await enviarMensajeWhatsApp(numero, 'Por favor, escribe tu número de cédula para cancelar tu cita:');
        return;
    }

    const datosUsuario = userData[numero];

    switch (datosUsuario.cancelarPaso) {
        case 'solicitar_cedula':
            const cedulaIngresada = mensaje.trim(); // Cambiado el nombre
            const todasLasCitas = await leerCitasDesdeSQLite(); // Cambiado el nombre
            const citasUsuario = todasLasCitas.filter((cita) => cita.cedula === cedulaIngresada);

            if (citasUsuario.length === 0) {
                await enviarMensajeWhatsApp(numero, '⚠️ No se encontraron citas registradas con esa cédula.');
                await mostrarMenuPrincipal(numero);
                delete userData[numero];
                return;
            }

            datosUsuario.cedula = cedulaIngresada;
            datosUsuario.citas = citasUsuario;
            datosUsuario.cancelarPaso = 'seleccionar_cita';

            let mensajeCitas = '📅 Estas son tus citas agendadas:\n\n';
            citasUsuario.forEach((cita, index) => {
                mensajeCitas += `${index + 1}. Fecha: ${cita.fecha}, Hora: ${cita.hora}\n`;
            });
            mensajeCitas += '\nSelecciona la cita a cancelar (número) o escribe "menu" para volver al menú.';
            
            await enviarMensajeWhatsApp(numero, mensajeCitas);
            break;

        case 'seleccionar_cita':
            if (mensaje.toLowerCase() === 'menu') {
                delete userData[numero];
                await mostrarMenuPrincipal(numero);
                return;
            }

            const indice = parseInt(mensaje) - 1;
            const { citas } = datosUsuario; // Esta variable está bien porque está dentro de su propio case

            if (isNaN(indice) || indice < 0 || indice >= citas.length) {
                await enviarMensajeWhatsApp(numero, '⚠️ Opción inválida. Por favor selecciona un número de la lista:');
                return;
            }

            datosUsuario.citaSeleccionada = citas[indice];
            datosUsuario.cancelarPaso = 'confirmar_cancelacion';

            await enviarMensajeWhatsApp(
                numero,
                `¿Confirmas que deseas cancelar la cita del ${datosUsuario.citaSeleccionada.fecha} a las ${datosUsuario.citaSeleccionada.hora}?\n\nResponde *SI* para confirmar o *NO* para volver al menú.`
            );
            break;

        case 'confirmar_cancelacion':
            const respuesta = mensaje.trim().toLowerCase();
            // Aquí usamos datosUsuario.cedula en lugar de redeclarar cedula
            const { citaSeleccionada } = datosUsuario;

            if (respuesta === 'si') {
                const resultado = await eliminarCitaEnSQLite(datosUsuario.cedula, citaSeleccionada.fecha, citaSeleccionada.hora);

                if (resultado) {
                    await enviarMensajeWhatsApp(
                        numero,
                        `✅ Cita del ${citaSeleccionada.fecha} a las ${citaSeleccionada.hora} cancelada.`
                    );
                    await subirBaseDeDatosADropbox();
                } else {
                    await enviarMensajeWhatsApp(numero, '⚠️ Error al cancelar la cita. Intenta nuevamente.');
                }
            } else if (respuesta === 'no') {
                await enviarMensajeWhatsApp(numero, 'Operación cancelada.');
            } else {
                await enviarMensajeWhatsApp(numero, '⚠️ Respuesta no reconocida.');
            }

            delete userData[numero];
            await mostrarMenuPrincipal(numero);
            break;
    }
};

// Función para manejar el flujo de consultar citas
const manejarConsultarCitas = async (numero, mensaje) => {
    if (!userData[numero] || !userData[numero].consultarPaso) {
        userData[numero] = { consultarPaso: 'solicitar_cedula' };
        await enviarMensajeWhatsApp(numero, 'Por favor, escribe tu número de cédula para consultar tus citas:');
        return;
    }

    const datosUsuario = userData[numero];

    if (datosUsuario.consultarPaso === 'solicitar_cedula') {
        const cedula = mensaje.trim();
        const citas = await leerCitasDesdeSQLite();
        const citasUsuario = citas.filter((cita) => cita.cedula === cedula);

        if (citasUsuario.length === 0) {
            await enviarMensajeWhatsApp(numero, 'No tienes citas agendadas.');
        } else {
            let mensaje = `Citas agendadas para la cédula ${cedula}:\n`;
            citasUsuario.forEach((cita) => {
                mensaje += `- ${cita.fecha}: ${cita.hora}\n`;
            });
            await enviarMensajeWhatsApp(numero, mensaje);
        }

        delete userData[numero];
        await mostrarMenuPrincipal(numero);
    }
};

// Función para mostrar información del consultorio
const mostrarInfoConsultorio = async (numero) => {
    await enviarMensajeWhatsApp(numero, 
        '📍 Dirección: Calle 21 #26-08 Esquina clínica Fatima, San juan de Pasto.\n' +
        '🕒 Horarios: Lunes a viernes, 15:00 PM – 18:00 PM.\n' +
        '📞 Teléfono: 3161044386- 602 7212171'
    );
    await mostrarMenuPrincipal(numero);
};

// Función para mostrar el menú principal
const mostrarMenuPrincipal = async (numero) => {
    await enviarMensajeWhatsApp(numero,
        'Consultorio doctor *Juan Carlos Rosas*\n' +
        '🙌 ¡Bienvenido al sistema de citas! Estas son las opciones disponibles:\n' +
        '(Seleccione el numero correspondientes de la opción a elegir)\n' +
        '*1* - Agendar una cita.\n' +
        '*2* - Consultar mis citas.\n' +
        '*3* - Información del consultorio.\n' +
        '*4* - Cancelar una cita.'
    );
};

// Endpoint para verificar el webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Endpoint para recibir mensajes
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (!message) {
            return res.sendStatus(200);
        }

        const numero = message.from;
        const mensajeTexto = message.text?.body || '';

        // Palabras clave para iniciar el menú
        const palabrasClaveMenu = ['hola', 'menu', 'inicio', 'buenas', 'buenos', 'doctor', 'cita', 'consultar', 
                                 'necesito', 'programar', 'quiero', 'solicitar', 'solicito', 'consulta', 
                                 'hello', 'good', 'morning', 'evening', 'night', 'afternoon', 'medico', 
                                 'señor', 'medicina', 'iniciar', 'buen dia', 'ayuda', 'informacion'];

        if (palabrasClaveMenu.some(palabra => mensajeTexto.toLowerCase().includes(palabra))) {
            await mostrarMenuPrincipal(numero);
            return res.sendStatus(200);
        }

        // Procesar opciones del menú
        if (userData[numero] && (userData[numero].paso || userData[numero].cancelarPaso || userData[numero].consultarPaso)) {
            if (userData[numero].paso) {
                await manejarAgendarCita(numero, mensajeTexto);
            } else if (userData[numero].cancelarPaso) {
                await manejarCancelarCita(numero, mensajeTexto);
            } else if (userData[numero].consultarPaso) {
                await manejarConsultarCitas(numero, mensajeTexto);
            }
            return res.sendStatus(200);
        }

        switch (mensajeTexto) {
            case '1':
                await manejarAgendarCita(numero, '');
                break;
            case '2':
                await manejarConsultarCitas(numero, '');
                break;
            case '3':
                await mostrarInfoConsultorio(numero);
                break;
            case '4':
                await manejarCancelarCita(numero, '');
                break;
            default:
                await enviarMensajeWhatsApp(numero, 'No entendí tu mensaje. Por favor, selecciona una opción del menú:\n1. Agendar cita\n2. Consultar citas\n3. Información\n4. Cancelar cita');
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Error en el webhook:', error);
        res.sendStatus(500);
    }
});

// Manejo de cierre mejorado
const shutdownHandler = async () => {
    console.log('\n🔧 Cerrando limpiamente...');
    try {
        await subirBaseDeDatosADropbox();
        console.log('💾 Datos guardados correctamente');
    } catch (error) {
        console.error('⚠️ Error al guardar datos:', error);
    } finally {
        process.exit(0);
    }
};

// Captura de señales
['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, shutdownHandler);
});

// Manejo global de errores
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Rechazo no manejado:', err);
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ Excepción no manejada:', err);
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
    try {
        await descargarBaseDeDatosDesdeDropbox();
        console.log('✅ Base de datos sincronizada');
    } catch (error) {
        console.error('⚠️ Error inicial al sincronizar DB:', error.message);
    }
});