'use strict';

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const os = require('os');

const isSnap = !!process.env.SNAP_DATA;
const logDir = isSnap 
    ? path.join(process.env.SNAP_DATA, 'logs')
    : path.join(os.homedir(), 'logs');

// Ensure log directory exists
try {
    fs.mkdirSync(logDir, { recursive: true });
    console.log(`✓ Log directory ready: ${logDir}`);
} catch (err) {
    console.error(`✗ Failed to create log directory ${logDir}:`, err.message);
}

const logFile = path.join(logDir, 'logfile.log');
console.log(`✓ Log file will be: ${logFile}`);

// Simple format for testing
const simpleFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message} ${metaStr}`.trim();
});

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        simpleFormat
    )
});

// File transport with error handling
const fileTransport = new winston.transports.File({
    filename: logFile,
    maxsize: 10485760,
    maxFiles: 5,
    handleExceptions: true
});

fileTransport.on('error', (err) => {
    console.error('✗ File transport error:', err.message, err.code);
});

logger.add(fileTransport);

// Console transport for development
if (process.env.NODE_ENV !== 'production') {
    const consoleTransport = new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    });
    consoleTransport.on('error', (err) => {
        console.error('✗ Console transport error:', err.message);
    });
    logger.add(consoleTransport);
}

console.log('✓ Logger initialized');

logger.logFile = logFile;

module.exports = logger;
