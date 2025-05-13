// Paso 1: Añadir el require de Express al principio del archivo
const path = require('path');
const fs = require('fs');
const express = require('express'); // Añadir esta línea

// Paso 2: Añadir la configuración de logging (al principio del archivo)
const setupLogger = () => {
  const logDir = path.join(__dirname, 'logs');
  
  // Crear directorio de logs si no existe
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  // Función para escribir logs
  const writeLog = (level, message) => {
    const now = new Date();
    const timestamp = now.toISOString();
    const dateStr = now.toISOString().split('T')[0];
    const logFile = path.join(logDir, `${dateStr}.log`);
    
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;
    
    // Escribir en archivo
    fs.appendFileSync(logFile, logEntry);
  };
  
  // Sobreescribir métodos de console para registrar en archivo
  const originalLog = console.log;
  const originalError = console.error;
  
  console.log = function() {
    const message = Array.from(arguments).map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : arg
    ).join(' ');
    writeLog('INFO', message);
    originalLog.apply(console, arguments);
  };
  
  console.error = function() {
    const message = Array.from(arguments).map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : arg
    ).join(' ');
    writeLog('ERROR', message);
    originalError.apply(console, arguments);
  };
  
  // Capturar salidas no manejadas
  process.on('uncaughtException', (err) => {
    writeLog('ERROR', `Excepción no manejada: ${err.stack || err}`);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    writeLog('ERROR', `Promesa rechazada no manejada: ${reason}`);
  });
  
  console.log('✅ Sistema de logs configurado');
};

// Inicializar el sistema de logs
setupLogger();

// Configuración de rutas (agregar después de los requires)
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const AUTH_FILE = path.join(AUTH_DIR, 'auth_info_multi.json');

// Cargar variables de entorno
require('dotenv').config();

const { createBot, createProvider, createFlow, addKeyword } = require('@bot-whatsapp/bot');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const moment = require('moment');
const { Dropbox } = require('dropbox'); // SDK de Dropbox
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

// Flujo para agendar cita - VERSIÓN SIMPLIFICADA
const flowAgendarCita = addKeyword(['1'])
    .addAction(async (ctx, { flowDynamic }) => {
        // Inicializar datos de usuario
        userData[ctx.from] = {};
        await flowDynamic('Para agendar una cita, necesito algunos datos.');
        await flowDynamic('Por favor, escribe tu número de cédula:');
    })
    .addAction({ capture: true }, async (ctx, { flowDynamic, fallBack }) => {
        const cedula = ctx.body.trim();
        
        // Validar cédula
        if (!/^\d+$/.test(cedula)) {
            await flowDynamic('⚠️ La cédula debe contener solo números.');
            await flowDynamic('Por favor, escribe tu número de cédula nuevamente:');
            return fallBack(); // Importante: usar fallBack() para repetir este paso
        }
        
        // Guardar cédula y continuar
        userData[ctx.from].cedula = cedula;
        await flowDynamic('Por favor, escribe tu nombre completo:');
    })
    .addAction({ capture: true }, async (ctx, { flowDynamic, fallBack }) => {
        const nombre = ctx.body.trim();
        
        // Validar nombre
        if (!nombre) {
            await flowDynamic('⚠️ El nombre no puede estar vacío.');
            await flowDynamic('Por favor, escribe tu nombre completo nuevamente:');
            return fallBack(); // Importante: usar fallBack() para repetir este paso
        }
        
        // Guardar nombre y continuar
        userData[ctx.from].nombre = nombre;
        await flowDynamic('Por favor, escribe tu número de celular:');
    })
    .addAction({ capture: true }, async (ctx, { flowDynamic, fallBack }) => {
        const celular = ctx.body.trim();
        
        // Validar celular
        if (!/^\d+$/.test(celular)) {
            await flowDynamic('⚠️ El celular debe contener solo números.');
            await flowDynamic('Por favor, escribe tu número de celular nuevamente:');
            return fallBack(); // Importante: usar fallBack() para repetir este paso
        }
        
        // Guardar celular y mostrar fechas disponibles
        userData[ctx.from].celular = celular;
        
        // Generar fechas disponibles
        const fechasDisponibles = generarFechasDisponibles();
        userData[ctx.from].fechasDisponibles = fechasDisponibles;
        
        let mensajeFechas = 'Selecciona una fecha disponible respondiendo con el número:\n';
        fechasDisponibles.forEach((fecha, index) => {
            mensajeFechas += `${index + 1}. ${fecha}\n`;
        });
        mensajeFechas += '\nResponde con 0 para volver al menú principal.';
        
        await flowDynamic(mensajeFechas);
    })
    .addAction({ capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        const opcion = ctx.body.trim();
        
        // Opción para volver al menú
        if (opcion === '0') {
            await flowDynamic('Volviendo al menú principal...');
            return gotoFlow(flowMenu);
        }
        
        const indice = parseInt(opcion) - 1;
        const { fechasDisponibles } = userData[ctx.from];
        
        // Validar selección de fecha
        if (isNaN(indice) || indice < 0 || indice >= fechasDisponibles.length) {
            await flowDynamic('⚠️ Opción inválida.');
            
            // Mostrar fechas nuevamente
            let mensajeFechas = 'Por favor, selecciona una fecha disponible respondiendo con el número:\n';
            fechasDisponibles.forEach((fecha, index) => {
                mensajeFechas += `${index + 1}. ${fecha}\n`;
            });
            mensajeFechas += '\nResponde con 0 para volver al menú principal.';
            
            await flowDynamic(mensajeFechas);
            return fallBack(); // Importante: usar fallBack() para repetir este paso
        }
        
        // Guardar fecha seleccionada y mostrar horarios
        const fechaSeleccionada = fechasDisponibles[indice];
        userData[ctx.from].fecha = fechaSeleccionada;
        
        let mensajeHorarios = `Fecha seleccionada: ${fechaSeleccionada}\n`;
        mensajeHorarios += 'Selecciona un horario disponible respondiendo con el número:\n';
        horariosDisponibles.forEach((hora, index) => {
            mensajeHorarios += `${index + 1}. ${hora}\n`;
        });
        mensajeHorarios += '\nResponde con 0 para volver al menú principal.';
        
        await flowDynamic(mensajeHorarios);
    })
    .addAction({ capture: true }, async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
        const opcion = ctx.body.trim();
        
        // Opción para volver al menú
        if (opcion === '0') {
            await flowDynamic('Volviendo al menú principal...');
            return gotoFlow(flowMenu);
        }
        
        const indice = parseInt(opcion) - 1;
        
        // Validar selección de horario
        if (isNaN(indice) || indice < 0 || indice >= horariosDisponibles.length) {
            await flowDynamic('⚠️ Opción inválida.');
            
            // Mostrar horarios nuevamente
            let mensajeHorarios = 'Por favor, selecciona un horario disponible respondiendo con el número:\n';
            horariosDisponibles.forEach((hora, index) => {
                mensajeHorarios += `${index + 1}. ${hora}\n`;
            });
            mensajeHorarios += '\nResponde con 0 para volver al menú principal.';
            
            await flowDynamic(mensajeHorarios);
            return fallBack(); // Importante: usar fallBack() para repetir este paso
        }
        
        // Agendar la cita
        const horaSeleccionada = horariosDisponibles[indice];
        const { cedula, nombre, celular, fecha } = userData[ctx.from];
        
        const resultado = await agendarCita(cedula, nombre, celular, fecha, horaSeleccionada);
        await flowDynamic(resultado);

        // Mensaje final
        await flowDynamic('Si deseas realizar otra operación, presiona 0 para volver al menú principal.');
    })
    .addAction({ capture: true }, async (ctx, { gotoFlow }) => {
        if (ctx.body === '0') {
            userData[ctx.from] = {}; // Reiniciar datos del usuario
            return gotoFlow(flowMenu);
        }
    });


// Flujo para cancelar cita - VERSIÓN MODIFICADA
const flowCancelarCita = addKeyword(['4'])
    .addAnswer(
        'Por favor, escribe tu número de cédula para cancelar tu cita:',
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            const cedula = ctx.body.trim(); // Aceptamos cualquier texto sin validar formato
            
            // Buscar citas asociadas a la cédula (sin validar formato)
            const citas = await leerCitasDesdeSQLite();
            const citasUsuario = citas.filter((cita) => cita.cedula === cedula);

            if (citasUsuario.length === 0) {
                await flowDynamic([
                    '⚠️ No se encontraron citas registradas con esa cédula.',
                    '\nPresiona *0* para volver al menú principal.'
                ]);
                return;
            }

            // Guardar las citas del usuario en userData
            userData[ctx.from] = { ...userData[ctx.from], cedula, citas: citasUsuario };

            // Mostrar las citas al usuario
            let mensaje = '📅 Estas son tus citas agendadas:\n\n';
            citasUsuario.forEach((cita, index) => {
                mensaje += `${index + 1}. Fecha: ${cita.fecha}, Hora: ${cita.hora}\n`;
            });
            mensaje += '\nSelecciona la cita a cancelar (número) o presiona *0* para volver al menú.';
            
            await flowDynamic(mensaje);
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow, fallBack }) => {
            const opcion = ctx.body.trim();
            
            // Opción para volver al menú
            if (opcion === '0') {
                await flowDynamic('Volviendo al menú principal...');
                return gotoFlow(flowMenu);
            }

            const indice = parseInt(opcion) - 1;
            const { cedula, citas } = userData[ctx.from] || {};

            // Validar selección
            if (isNaN(indice) || indice < 0 || indice >= citas?.length) {
                await flowDynamic([
                    '⚠️ Opción inválida. Por favor selecciona un número de la lista:',
                    '\nPresiona *0* para volver al menú principal.'
                ]);
                return fallBack();
            }

            const citaSeleccionada = citas[indice];
            userData[ctx.from].citaSeleccionada = citaSeleccionada;

            await flowDynamic([
                `¿Confirmas que deseas cancelar la cita del ${citaSeleccionada.fecha} a las ${citaSeleccionada.hora}?`,
                '\nResponde *SI* para confirmar o *NO* para volver al menú.'
            ]);
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            const respuesta = ctx.body.trim().toLowerCase();
            const { cedula, citaSeleccionada } = userData[ctx.from] || {};

            if (respuesta === 'si') {
                if (!cedula || !citaSeleccionada) {
                    await flowDynamic('⚠️ Error al procesar la cancelación. Intenta nuevamente.');
                    return gotoFlow(flowMenu);
                }

                const resultado = await eliminarCitaEnSQLite(cedula, citaSeleccionada.fecha, citaSeleccionada.hora);

                if (resultado) {
                    await flowDynamic([
                        `✅ Cita del ${citaSeleccionada.fecha} a las ${citaSeleccionada.hora} cancelada.`,
                        '\nPresiona *0* para volver al menú principal.'
                    ]);
                    
                    await subirBaseDeDatosADropbox();
                } else {
                    await flowDynamic('⚠️ Error al cancelar la cita. Intenta nuevamente.');
                }
            } else if (respuesta === 'no') {
                await flowDynamic('Operación cancelada. Volviendo al menú principal...');
            } else {
                await flowDynamic([
                    '⚠️ Respuesta no reconocida.',
                    '\nPresiona *0* para volver al menú principal.'
                ]);
            }

            userData[ctx.from] = {}; // Limpiar datos temporales
            return gotoFlow(flowMenu);
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
const flowMenu = addKeyword(['hola', 'menu', 'inicio', 'buenas', 'buenos', 'doctor','cita','consultar','necesito','programar','quiero','solicitar','solicito','consulta','hello','good','morning','evenging','nigth','afternoon','medico','señor','medicina','iniciar', 'buen dia','ayuda','informacion'])
    .addAnswer(
        [
            'Consultorio doctor *Juan Carlos Rosas*',
            '🙌 ¡Bienvenido al sistema de citas! Estas son las opciones disponibles:',
            '(Seleccione el numero correspondientes de la opción a elegir)',
            '*1* - Agendar una cita.',
            '*2* - Consultar mis citas.',
            '*3* - Información del consultorio.',
            '*4* - Cancelar una cita.',
        ],
        null,
        null,
        [flowAgendarCita , flowConsultarCitas, flowInfoConsultorio, flowCancelarCita]
    );

    const cleanAuthSession = () => {
        try {
          if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          }
      
          if (fs.existsSync(AUTH_FILE)) {
            fs.unlinkSync(AUTH_FILE);
            console.log('🔑 Sesión anterior eliminada para forzar nueva autenticación');
            return true;
          }
          return false;
        } catch (error) {
          console.error('⚠️ Error al limpiar sesión:', error);
          return false;
        }
      };    

// Configuración del bot - Versión optimizada
const main = async () => {
    // Crear y configurar la aplicación Express
    const app = express();
    
    // Ruta de health check para Render
    app.get('/health', (req, res) => {
        res.status(200).send({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    });
    
    // Ruta principal (opcional, para verificar que el bot está vivo)
    app.get('/', (req, res) => res.redirect('/qr'));
    await QRPortalWeb({ server, basePath: '/qr' });
    
    // Iniciar servidor Express
    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
        console.log(`🚀 Servidor Express iniciado en puerto ${PORT}`);
    });
    
    // Configuración de la sesión de WhatsApp
    const authDir = path.join(__dirname, '.wwebjs_auth');
    const authFile = path.join(authDir, 'auth_info_multi.json');
    
    try {
        // Limpieza y preparación de la sesión
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
        }
        
        // Configuración del provider de Baileys
        const adapterProvider = createProvider(BaileysProvider, {
            authPath: authDir,
            restartOnAuthFail: true,
            connectTimeoutMs: 120_000,
            qrMaxRetries: 5,
            browser: ['WhatsApp Bot', 'Chrome', '10.0'],
            logger: { level: 'warn' },
            printQRInTerminal: true, // QR en la terminal por si acaso
            getMessage: async () => ({ conversation: '🤖 Bot de WhatsApp activo' })
        });

        // Variables para controlar la conexión
        let isConnected = false;
        let reconnectAttempts = 0;
        const MAX_RECONNECT_ATTEMPTS = 10;

        // Manejo de eventos de conexión
        adapterProvider.on('connection.update', (update) => {
            const status = update.connection;
            console.log(`📶 Estado de conexión: ${status || 'actualizado'}`);
            
            if (status === 'close') {
                const errorCode = update.lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Desconexión detectada. Código: ${errorCode}`);
                
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    const delay = Math.min(5000 * reconnectAttempts, 30000); // Backoff progresivo
                    console.log(`⏳ Reconectando en ${delay / 1000} segundos...`);
                    setTimeout(() => main(), delay);
                } else {
                    console.log('🔴 Máximo de intentos alcanzado. Reiniciando...');
                    setTimeout(() => {
                        reconnectAttempts = 0;
                        main();
                    }, 60000);
                }
            }

            if (status === 'open') {
                isConnected = true;
                reconnectAttempts = 0;
                console.log('✅ Conexión establecida con WhatsApp');
            }
        });

        // Keep-Alive para Render (cada 5 minutos)
        const keepAlive = setInterval(() => {
            axios.get(`http://localhost:${PORT}/health`)
                .catch(e => console.log('⚠️ Keep-alive fallido:', e.message));
        }, 300_000); // 5 minutos

        // Reconexión preventiva cada 5 días (evita el cierre de WhatsApp)
        setInterval(() => {
            if (isConnected) {
                console.log('🔄 Reconexión preventiva (evitar cierre automático)');
                adapterProvider.restart();
            }
        }, 5 * 24 * 60 * 60 * 1000); // 5 días

        // Crear el bot
        await createBot({
            flow: createFlow([flowMenu]), // Reemplaza `flowMenu` con tus flujos
            provider: adapterProvider,
            database: new MockAdapter()
        });

        // Iniciar el portal QR en el MISMO puerto que Express
        await QRPortalWeb({ server, verbose: false }); // ¡Clave para Render!

    } catch (error) {
        console.error('💥 Error crítico:', error);
        setTimeout(() => main(), 10000); // Reinicio automático
    }
};

// Manejo de cierre limpio
const shutdownHandler = async (signal) => {
    console.log(`\n🔧 Cerrando (señal: ${signal})...`);
    process.exit(0);
};

['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, shutdownHandler);
});

// Iniciar el bot
main().catch(err => {
    console.error('🔥 Error al iniciar:', err);
    setTimeout(() => main(), 15000);
});