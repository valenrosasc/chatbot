
// monitor.js - Script independiente para monitorear y reiniciar el servicio

const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuración
const SERVICE_URL = process.env.SERVICE_URL || 'http://localhost:3000/health';
const MONITOR_INTERVAL = process.env.MONITOR_INTERVAL || 1800000; // 30 minutos por defecto
const LOG_DIR = path.join(__dirname, 'logs');

// Asegurar que existe el directorio de logs
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Función para logging
function log(message, level = 'INFO') {
  const now = new Date();
  const timestamp = now.toISOString();
  const dateStr = now.toISOString().split('T')[0];
  const logFile = path.join(LOG_DIR, `monitor-${dateStr}.log`);
  
  const logEntry = `[${timestamp}] [${level}] ${message}\n`;
  
  // Mostrar en consola
  console[level === 'ERROR' ? 'error' : 'log'](logEntry.trim());
  
  // Escribir en archivo
  fs.appendFileSync(logFile, logEntry);
}

// Función para verificar el estado del servicio
async function checkServiceStatus() {
  try {
    log(`📡 Verificando estado del servicio: ${SERVICE_URL}`);
    const response = await axios.get(SERVICE_URL, { timeout: 10000 });
    
    if (response.status === 200 && response.data.status === 'ok') {
      log('✅ Servicio funcionando correctamente');
      return true;
    } else {
      log(`⚠️ Servicio respondió con estado inesperado: ${response.status}`, 'WARN');
      return false;
    }
  } catch (error) {
    log(`❌ Error al verificar el servicio: ${error.message}`, 'ERROR');
    return false;
  }
}

// Función para reiniciar el servicio
function restartService() {
  log('🔄 Reiniciando el servicio...', 'WARN');
  
  // En Render, esto reiniciará el proceso principal
  exec('kill -USR2 1', (error, stdout, stderr) => {
    if (error) {
      log(`❌ Error al reiniciar: ${error.message}`, 'ERROR');
      return;
    }
    if (stderr) {
      log(`⚠️ Error estándar: ${stderr}`, 'WARN');
      return;
    }
    log(`🚀 Servicio reiniciado: ${stdout}`);
  });
}

// Función principal de monitoreo
async function monitorService() {
  log(`⏰ Ejecutando monitoreo ${new Date().toISOString()}`);
  
  const isServiceRunning = await checkServiceStatus();
  
  if (!isServiceRunning) {
    log('🔴 Servicio caído, intentando reiniciar...', 'WARN');
    restartService();
  }
}

// Ejecutar monitoreo cada cierto tiempo
setInterval(monitorService, MONITOR_INTERVAL);

// También ejecutar inmediatamente al iniciar
monitorService();

log(`✅ Monitor iniciado - Intervalo: ${MONITOR_INTERVAL/60000} minutos`);

// Mantener el proceso activo
process.on('SIGTERM', () => {
  log('📴 Señal SIGTERM recibida. Cerrando monitor...', 'WARN');
  process.exit(0);
});

// Evitar que el proceso termine por errores no manejados
process.on('uncaughtException', (err) => {
  log(`⚠️ Error no manejado en monitor: ${err}`, 'ERROR');
});

process.on('unhandledRejection', (err) => {
  log(`⚠️ Promesa rechazada no manejada en monitor: ${err}`, 'ERROR');
});