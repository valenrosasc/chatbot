// Cargar variables de entorno
require('dotenv').config();

const { createBot, createProvider, createFlow, addKeyword } = require('@bot-whatsapp/bot');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const moment = require('moment');
const { Dropbox } = require('dropbox'); // SDK de Dropbox
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Importa las funciones para interactuar con SQLite
const { leerCitasDesdeSQLite, guardarEnSQLite, eliminarCitaEnSQLite, enviarCorreo } = require('./guardarCita');

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

// Configura el cliente de Dropbox
let dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN });

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
    await renovarAccessTokenSiEsNecesario(); // Renueva el token si es necesario
    try {
        const dbPath = path.join(__dirname, 'citas.db');
        const dbFile = fs.readFileSync(dbPath);

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
    await renovarAccessTokenSiEsNecesario(); // Renueva el token si es necesario
    try {
        const dbPath = path.join(__dirname, 'citas.db');

        const response = await dbx.filesDownload({ path: '/citas.db' });
        fs.writeFileSync(dbPath, response.result.fileBinary);

        console.log('Base de datos descargada desde Dropbox.');
        return true;
    } catch (error) {
        console.error('Error al descargar la base de datos desde Dropbox:', error);
        return false;
    }
};

// Objeto global para almacenar datos temporales del usuario
const userData = {};

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
        const fecha = fechaActual.clone().add(contador, 'days'); // Suma días a la fecha actual
        if (fecha.day() !== 6 && fecha.day() !== 0) { // Excluye sábados (6) y domingos (0)
            fechasDisponibles.push(fecha.format('DD-MM-YYYY')); // Guarda la fecha en formato DD-MM-YYYY
        }
        contador++;
    }

    return fechasDisponibles;
};

// Horarios disponibles para agendar citas
const horariosDisponibles = ['15:00', '15:30', '16:00', '16:30', '17:00', '17:30'];

// Flujo para volver al menú principal
const flowVolverMenu = addKeyword(['0'])
    .addAnswer('Volviendo al menú principal...', null, async (ctx, { gotoFlow }) => {
        userData[ctx.from] = {}; // Reiniciar los datos del usuario
        return gotoFlow(flowMenu);
    });

// Flujo para agendar cita
const flowAgendarCita = addKeyword(['1'])
    .addAnswer(
        'Por favor, escribe tu número de cédula (solo números):',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow, endFlow }) => {
            const cedula = ctx.body.trim();

            // Validar que la cédula solo contenga números
            if (!/^\d+$/.test(cedula)) {
                await flowDynamic('⚠️ La cédula debe contener solo números. Intenta nuevamente.');
                return gotoFlow(flowAgendarCita); // Reiniciar el flujo desde el principio
            }

            // Guardar la cédula en los datos temporales del usuario
            userData[ctx.from] = { cedula };
            await flowDynamic('✅ Cédula registrada correctamente.');

            // Ir al siguiente paso (nombre)
            return gotoFlow(flowNombre);
        }
    );

const flowNombre = addKeyword([]) // No necesita una palabra clave, se llama desde el flujo anterior
    .addAnswer(
        'Por favor, escribe tu nombre completo:',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow, endFlow }) => {
            const nombre = ctx.body.trim();

            // Validar que el nombre no esté vacío
            if (!nombre) {
                await flowDynamic('⚠️ El nombre no puede estar vacío. Intenta nuevamente.');
                return gotoFlow(flowNombre); // Repetir este paso
            }

            // Guardar el nombre en los datos temporales del usuario
            userData[ctx.from].nombre = nombre;
            await flowDynamic('✅ Nombre registrado correctamente.');

            // Ir al siguiente paso (celular)
            return gotoFlow(flowCelular);
        }
    );

const flowCelular = addKeyword([])
    .addAnswer(
        'Por favor, escribe tu número de celular (solo números):',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow, endFlow }) => {
            const celular = ctx.body.trim();

            // Validar que el celular solo contenga números
            if (!/^\d+$/.test(celular)) {
                await flowDynamic('⚠️ El celular debe contener solo números. Intenta nuevamente.');
                return gotoFlow(flowCelular); // Repetir este paso
            }

            // Guardar el celular en los datos temporales del usuario
            userData[ctx.from].celular = celular;
            await flowDynamic('✅ Celular registrado correctamente.');

            // Ir al siguiente paso (fecha)
            return gotoFlow(flowFecha);
        }
    );

const flowFecha = addKeyword([])
    .addAnswer('Recuerda que la atención está disponible únicamente de lunes a viernes.')
    .addAnswer(
        '¿En qué fecha deseas agendar tu cita? (Selecciona una de las siguientes opciones):',
        null,
        async (ctx, { flowDynamic, gotoFlow, endFlow }) => {
            const fechasDisponibles = generarFechasDisponibles();
            const mensajeFechas = fechasDisponibles
                .map((fecha, index) => `${index + 1}. ${fecha}`)
                .join('\n');
            await flowDynamic(mensajeFechas);
        }
    )
    .addAnswer(
        'Por favor, selecciona una fecha respondiendo con el número correspondiente:',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow, endFlow }) => {
            const opcion = ctx.body.trim();
            const indice = parseInt(opcion) - 1;
            const fechasDisponibles = generarFechasDisponibles();

            // Validar que la opción sea un número válido
            if (isNaN(indice) || indice < 0 || indice >= fechasDisponibles.length) {
                await flowDynamic('⚠️ Opción inválida. Por favor, selecciona un número válido.');
                return gotoFlow(flowFecha); // Repetir este paso
            }

            // Guardar la fecha seleccionada en los datos temporales del usuario
            const fechaSeleccionada = fechasDisponibles[indice];
            userData[ctx.from].fecha = fechaSeleccionada;
            await flowDynamic(`✅ Fecha seleccionada: ${fechaSeleccionada}`);

            // Ir al siguiente paso (hora)
            return gotoFlow(flowHora);
        }
    );

const flowHora = addKeyword([])
    .addAnswer(
        `Elige un horario para tu cita respondiendo con el número correspondiente:\n` +
            horariosDisponibles
                .map((hora, index) => `${index + 1}. ${hora}`)
                .join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow, endFlow }) => {
            const opcion = ctx.body.trim();
            const indice = parseInt(opcion) - 1;

            // Validar que la opción sea un número válido
            if (isNaN(indice) || indice < 0 || indice >= horariosDisponibles.length) {
                await flowDynamic('⚠️ Opción inválida. Por favor, selecciona un número válido.');
                return gotoFlow(flowHora); // Repetir este paso
            }

            // Obtener los datos del usuario
            const { cedula, nombre, celular, fecha } = userData[ctx.from] || {};

            // Validar que todos los datos estén completos
            if (!cedula || !nombre || !celular || !fecha) {
                await flowDynamic('⚠️ Algo salió mal. Por favor, vuelve a intentarlo desde el principio.');
                return gotoFlow(flowAgendarCita); // Reiniciar el flujo
            }

            // Obtener el horario seleccionado
            const horaSeleccionada = horariosDisponibles[indice];

            // Intentar agendar la cita
            const resultado = await agendarCita(cedula, nombre, celular, fecha, horaSeleccionada);
            await flowDynamic(resultado);

            // Reiniciar los datos del usuario
            userData[ctx.from] = {};

            // Volver al menú principal
            return gotoFlow(flowMenu);
        }
    );
// Flujo para cancelar cita
const flowCancelarCita = addKeyword(['4'])
    .addAnswer('Por favor, escribe tu número de cédula para cancelar tu cita:', { capture: true }, async (ctx, { flowDynamic, gotoFlow }) => {
        try {
            const cedula = ctx.body.trim(); // Obtener la cédula ingresada (puede contener letras o números)

            // Buscar citas del usuario en la base de datos
            const citas = await leerCitasDesdeSQLite();
            const citasUsuario = citas.filter((cita) => cita.cedula === cedula);

            if (citasUsuario.length === 0) {
                await flowDynamic('⚠️ No tienes citas agendadas con esa cédula.');
                return gotoFlow(flowMenu); // Volver al menú principal si no hay citas
            }

            // Guardar las citas del usuario en los datos temporales
            userData[ctx.from] = { cedula, citas: citasUsuario };
            await flowDynamic('✅ Cédula verificada correctamente. Estas son tus citas agendadas:');

            // Mostrar las citas agendadas
            let mensaje = citasUsuario
                .map((cita, index) => `${index + 1}. Fecha: ${cita.fecha}, Hora: ${cita.hora}`)
                .join('\n');
            await flowDynamic(mensaje);

            // Preguntar cuál cita desea cancelar
            await flowDynamic('Por favor, selecciona la cita que deseas cancelar respondiendo con el número correspondiente:');
        } catch (error) {
            console.error('Error en el flujo de cancelar cita:', error);
            await flowDynamic('⚠️ Hubo un error al procesar tu solicitud. Intenta nuevamente.');
            return gotoFlow(flowCancelarCita); // Reiniciar el flujo en caso de error
        }
    })
    .addAnswer(
        'Por favor, selecciona la cita que deseas cancelar respondiendo con el número correspondiente:',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            try {
                const opcion = ctx.body.trim();
                const indice = parseInt(opcion) - 1;
                const { cedula, citas } = userData[ctx.from] || {};

                // Validar que la opción sea un número válido
                if (isNaN(indice) || indice < 0 || indice >= citas.length) {
                    await flowDynamic('⚠️ Opción inválida. Por favor, selecciona un número válido.');
                    return gotoFlow(flowCancelarCita); // Reiniciar el flujo
                }

                // Guardar la cita seleccionada
                const citaSeleccionada = citas[indice];
                userData[ctx.from].citaSeleccionada = citaSeleccionada;

                // Pedir confirmación para cancelar la cita
                await flowDynamic(`¿Estás seguro de que deseas cancelar la cita del ${citaSeleccionada.fecha} a las ${citaSeleccionada.hora}? Responde *SI* para confirmar o *NO* para volver al menú.`);
            } catch (error) {
                console.error('Error en el flujo de cancelar cita:', error);
                await flowDynamic('⚠️ Hubo un error al procesar tu solicitud. Intenta nuevamente.');
                return gotoFlow(flowCancelarCita); // Reiniciar el flujo en caso de error
            }
        }
    )
    .addAnswer(
        'Por favor, responde *SI* para confirmar o *NO* para volver al menú.',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            try {
                const respuesta = ctx.body ? ctx.body.trim().toLowerCase() : '';

                if (respuesta === 'si') {
                    const { cedula, citaSeleccionada } = userData[ctx.from] || {};

                    // Validar que la cita seleccionada exista
                    if (!cedula || !citaSeleccionada) {
                        await flowDynamic('⚠️ No se encontró la cita a cancelar. Inténtalo de nuevo.');
                        return gotoFlow(flowCancelarCita); // Reiniciar el flujo
                    }

                    // Eliminar la cita de la base de datos
                    const resultado = await eliminarCitaEnSQLite(cedula, citaSeleccionada.fecha, citaSeleccionada.hora);

                    if (resultado) {
                        await subirBaseDeDatosADropbox(); // Subir la base de datos actualizada a Dropbox
                        await flowDynamic(`✅ La cita del ${citaSeleccionada.fecha} a las ${citaSeleccionada.hora} ha sido cancelada.`);
                    } else {
                        await flowDynamic('⚠️ Hubo un error al cancelar la cita. Intenta nuevamente.');
                    }
                } else if (respuesta === 'no') {
                    await flowDynamic('Volviendo al menú principal...');
                    return gotoFlow(flowMenu); // Volver al menú principal
                } else {
                    await flowDynamic('⚠️ Respuesta inválida. Por favor, responde *SI* o *NO*.');
                    return gotoFlow(flowCancelarCita); // Reiniciar el flujo
                }

                userData[ctx.from] = {}; // Reiniciar los datos del usuario
            } catch (error) {
                console.error('Error en el flujo de cancelar cita:', error);
                await flowDynamic('⚠️ Hubo un error al procesar tu solicitud. Intenta nuevamente.');
                return gotoFlow(flowCancelarCita); // Reiniciar el flujo en caso de error
            }
        }
    );
// Flujo para consultar citas
const flowConsultarCitas = addKeyword(['2'])
    .addAnswer('Por favor, escribe tu número de cédula para consultar tus citas:', { capture: true }, async (ctx, { flowDynamic }) => {
        try {
            const cedula = ctx.body.trim();
            if (!/^\d+$/.test(cedula)) {
                await flowDynamic('⚠️ La cédula debe contener solo números. Intenta nuevamente.');
                return gotoFlow(flowConsultarCitas);
            }
            const citas = await leerCitasDesdeSQLite();
            const citasUsuario = citas.filter((cita) => cita.cedula === cedula);

            if (citasUsuario.length === 0) {
                await flowDynamic('No tienes citas agendadas.');
            } else {
                let mensaje = `Citas agendadas para la cédula ${cedula}:\n`;
                citasUsuario.forEach((cita) => {
                    mensaje += `- ${cita.fecha}: ${cita.hora}\n`;
                });
                await flowDynamic(mensaje);
            }
        } catch (error) {
            console.error('Error en el flujo de consultar citas:', error);
            await flowDynamic('⚠️ Hubo un error al procesar tu solicitud. Intenta nuevamente.');
        }
    })
    .addAnswer('Si quiere volver al menú principal digite 0', null, null, [flowVolverMenu]);

// Flujo para información del consultorio
const flowInfoConsultorio = addKeyword(['3'])
    .addAnswer([
        '📍 Dirección: Calle 21 #26-08 Esquina clínica Fatima, San juan de Pasto.',
        '🕒 Horarios: Lunes a viernes, 15:00 PM – 18:00 PM.',
        '📞 Teléfono: 3161044386- 602 7212171',
    ])
    .addAnswer('Si quiere volver al menú principal digite 0', null, null, [flowVolverMenu]);

// Menú principal
const flowMenu = addKeyword(['hola', 'menu', 'inicio', 'buenas', 'buen', 'buenos', 'doctor','ola','cita','consultar','necesito','programar','quiero','solicitar','solicito','para','consulta','una','hello','hi','good','morning','evenging','nigth','afternoon','medico','doc','dr','señor','medicina'])
    .addAnswer(
        [
            'Consultorio doctor Juan Carlos Rosas',
            '🙌 ¡Bienvenido al sistema de citas! Estas son las opciones disponibles:',
            '(Seleccione el numero correspondientes de la opción a elegir)',
            '*1* - Agendar una cita.',
            '*2* - Consultar mis citas.',
            '*3* - Información del consultorio.',
            '*4* - Cancelar una cita.',
        ],
        null,
        null,
        [flowAgendarCita, flowConsultarCitas, flowInfoConsultorio, flowCancelarCita]
    );

// Configuración del bot
const main = async () => {
    try {
        // Descargar la base de datos desde Dropbox al iniciar
        await descargarBaseDeDatosDesdeDropbox();

        const adapterDB = new MockAdapter();
        const adapterFlow = createFlow([flowMenu]);
        const adapterProvider = createProvider(BaileysProvider);

        // Escuchar eventos de conexión
        adapterProvider.on('connection.update', (update) => {
            console.log('Actualización de conexión:', update);
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                console.log('Conexión cerrada. Última desconexión:', lastDisconnect);
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== 401;
                if (shouldReconnect) {
                    console.log('Reconectando en 5 segundos...');
                    setTimeout(main, 5000);
                }
            } else if (connection === 'open') {
                console.log('Conexión abierta');
            }
        });

        // Filtrar mensajes no deseados
        adapterProvider.on('message', async (message) => {
            if (message.fromMe || message.isGroupMsg) {
                return; // Ignorar mensajes enviados por el propio bot o mensajes de grupos
            }

            // Procesar solo mensajes de usuarios
            const userMessage = message.body.toLowerCase();
            if (userMessage) {
                console.log('Mensaje recibido:', userMessage);
            }
        });

        // Mantener la conexión activa
        setInterval(async () => {
            try {
                if (adapterProvider && adapterProvider.client) {
                    await adapterProvider.sendPresenceUpdate('available'); // Enviar presencia cada 30 segundos
                    console.log('Presencia enviada correctamente.');
                }
            } catch (error) {
                console.error('Error al enviar presencia:', error);
            }
        }, 30000); // 30 segundos

        // Verificar el estado de la conexión periódicamente
        const checkConnection = async () => {
            try {
                if (adapterProvider && adapterProvider.client) {
                    const state = adapterProvider.client.state;
                    if (state !== 'open') {
                        console.log('Conexión no activa. Reconectando...');
                        await main(); // Reiniciar la conexión
                    }
                }
            } catch (error) {
                console.error('Error al verificar la conexión:', error);
            }
        };

        setInterval(checkConnection, 60000); // Verificar cada 60 segundos

        // Crear el bot
        await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        // Iniciar el portal web en el puerto 10000
        await QRPortalWeb({ port: 10000 });
    } catch (error) {
        console.error('Error en la función main:', error);
    }
};

main();