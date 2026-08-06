'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { CommandRunner, getSupportedCommands } = require('./commandRunner');
const logger = require('./logger');

const port = Number(process.env.PORT || 3300);
const host = process.env.HOST || '0.0.0.0';
const defaultCliPath = process.env.M1TFC_CMD || 'm1tfc';
const defaultCliArgs = process.env.M1TFC_BASE_ARGS
    ? process.env.M1TFC_BASE_ARGS.split(' ').filter(Boolean)
    : [];
const cliCwd = process.env.M1TFC_CWD || process.cwd();
const snapData = process.env.SNAP_DATA || path.join(os.homedir(), 'snap_data');
const m1PlatformConfigFile = '/etc/m1platform/config.json';
const fallbackConfigFile = path.join(snapData, 'config.json');
const defaultSnapcraftFile = process.env.SNAPCRAFT_YAML
    || path.join(process.cwd(), 'snap', 'snapcraft.yaml');
const defaultTfcroncliSnapcraftFile = process.env.TFCRONCLI_SNAPCRAFT_YAML
    || path.resolve(process.cwd(), '../tfcroncli/snap/snapcraft.yaml');
const testHookReportOnly = process.env.REST_TEST_HOOK === '1';
const testHookHistory = [];

const VALID_PIN_MODES = new Set(['production', 'debug']);

function resolveRuntimeConfigFile() {
    if (process.env.CONFIG_JSON) return process.env.CONFIG_JSON;
    if (fs.existsSync(m1PlatformConfigFile)) return m1PlatformConfigFile;
    return fallbackConfigFile;
}

function loadRuntimeConfig() {
    try {
        return JSON.parse(fs.readFileSync(resolveRuntimeConfigFile(), 'utf8'));
    } catch {
        return {};
    }
}

function saveRuntimeConfig(cfg) {
    const configFile = resolveRuntimeConfigFile();
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function resolveLogFile() {
    const cfg = loadRuntimeConfig();
    const configured = process.env.LOG_FILE
        || cfg.teensyLogFilename
        || cfg.logFile
        || cfg.logFilename
        || logger.logFile;
    if (!configured || typeof configured !== 'string' || !configured.trim()) return null;
    return path.resolve(configured.trim());
}

function readInstalledSnapVersion(snapName) {
    try {
        const output = execSync(`snap list ${snapName}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length >= 2) {
            const cols = lines[1].split(/\s+/);
            const snapVersion = cols[1];
            if (snapVersion) return snapVersion;
        }
    } catch {
        // Fall through to unknown.
    }

    return null;
}

function readUiSnapVersion() {
    const installedVersion = readInstalledSnapVersion('gui-react');
    if (installedVersion) return installedVersion;

    try {
        const yaml = fs.readFileSync(defaultSnapcraftFile, 'utf8');
        const match = yaml.match(/^version:\s*['\"]?([^'\"\n]+)['\"]?\s*$/m);
        return match ? match[1] : 'unknown';
    } catch {
        return 'unknown';
    }
}

function readRestServerSnapVersion(cfg) {
    const configuredVersion = process.env.SNAP_VERSION
        || cfg.restServerSnapVersion
        || cfg.snapVersion;
    if (configuredVersion) return String(configuredVersion);

    const installedVersion = readInstalledSnapVersion('m1tfc-rest-server');
    return installedVersion || 'unknown';
}

function readFixtureAgentSnapVersion(cfg) {
    const configuredVersion = process.env.M1_FIXTURE_AGENT_VERSION
        || cfg.m1FixtureAgentSnapVersion
        || cfg.fixtureAgentSnapVersion;
    if (configuredVersion) return String(configuredVersion);

    const installedVersion = readInstalledSnapVersion('m1-fixture-agent');
    return installedVersion || 'unknown';
}

function readM1tfcSnapVersion() {
    const installedVersion = readInstalledSnapVersion('m1tfc');
    if (installedVersion) return installedVersion;

    return 'unknown';
}

function readTfcroncliVersion(cfg) {
    const configuredVersion = process.env.TFCRONCLI_VERSION
        || cfg.tfcroncliVersion
        || cfg.tfcronVersion;
    if (configuredVersion) return String(configuredVersion);

    // Production path: derive version from installed m1client snap metadata.
    try {
        const output = execSync('snap list m1client', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length >= 2) {
            const cols = lines[1].split(/\s+/);
            const snapVersion = cols[1];
            const snapRevision = cols[2];
            if (snapVersion && snapRevision) return `${snapVersion} (${snapRevision})`;
            if (snapVersion) return snapVersion;
        }
    } catch {
        // Fall through to source/dev fallback.
    }

    try {
        // Dev/source fallback: read from tfcroncli snapcraft.yaml in workspace.
        const yaml = fs.readFileSync(defaultTfcroncliSnapcraftFile, 'utf8');
        const match = yaml.match(/^version:\s*['\"]?([^'\"\n]+)['\"]?\s*$/m);
        if (match && match[1]) return match[1];
    } catch {
        // Fall through to unknown.
    }

    return 'unknown';
}

function readFwVersion(cfg) {
    const configuredVersion = process.env.FW_VERSION
        || cfg.firmwareVersion
        || cfg.fwVersion
        || cfg.flashVersion;
    if (configuredVersion) return String(configuredVersion);

    if (!cfg.fwDir || typeof cfg.fwDir !== 'string') return 'unknown';

    const mtfDir = cfg.mtfDir || path.join(os.homedir(), 'm1mtf');
    const versionFile = path.join(mtfDir, cfg.fwDir, 'VERSION');
    try {
        const version = fs.readFileSync(versionFile, 'utf8').trim();
        return version || 'unknown';
    } catch {
        return 'unknown';
    }
}

function readStm32mp1FwVersion(cfg) {
    const configuredVersion = process.env.STM32MP1_FW_VERSION
        || cfg.stm32mp1FW
        || cfg.stm32mp1Fw
        || cfg.stm32FwVersion;
    if (configuredVersion) return String(configuredVersion);

    const mtfDir = cfg.mtfDir || path.join(os.homedir(), 'm1mtf');
    const revisionFile = path.join(mtfDir, 'stm32mp1_rev');
    try {
        const version = fs.readFileSync(revisionFile, 'utf8').trim();
        return version || 'unknown';
    } catch {
        return 'unknown';
    }
}

async function readBoardIdFromFirmware() {
    try {
        const result = await commandRunner.run('m1tbcmd', { command: 'getfwrev' });
        const output = result && result.commandOutput && typeof result.commandOutput === 'object'
            ? result.commandOutput
            : null;
        if (!output || output.boardId === undefined || output.boardId === null) {
            return 'unknown';
        }
        return String(output.boardId);
    } catch {
        return 'unknown';
    }
}

async function readFirmwareRevisions() {
    try {
        const result = await commandRunner.run('fwrevision', '-d 2');
        if (result && result.status === 'OK' && result.commandOutput) {
            const output = result.commandOutput;
            return {
                m1tb: output.m1tb || null,
                acm: output.acm || null,
                m1: output.m1 || null
            };
        }
    } catch {
        // Fall through to return nulls
    }
    return {
        m1tb: null,
        acm: null,
        m1: null
    };
}

function ensureLogFile(logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '', 'utf8');
}

function tailLogLines(logFile, numLines) {
    const content = fs.readFileSync(logFile, 'utf8');
    return content.split('\n').filter(line => line.trim()).slice(-numLines);
}

function passwordKeyForMode(mode) {
    return `${mode}Password`;
}

function verifyPassword(mode, password) {
    const cfg = loadRuntimeConfig();
    const configured = cfg[passwordKeyForMode(mode)];
    if (configured === undefined || configured === null) return false;
    return password === String(configured);
}

function savePassword(mode, password) {
    const cfg = loadRuntimeConfig();
    cfg[passwordKeyForMode(mode)] = password;
    saveRuntimeConfig(cfg);
}

const commandRunner = new CommandRunner({
    baseCommand: defaultCliPath,
    baseArgs: defaultCliArgs,
    cwd: cliCwd,
    env: process.env
});

const app = express();
app.use(express.json({ limit: '1mb' }));

// Enable CORS for all origins
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

function normalizeIncomingCommandRequest(body = {}) {
    return {
        command: body.command || body.cmd,
        argument: body.argument || body.arg || body.args
    };
}

function createTestHookReport(command, argument) {
    return {
        command,
        args: typeof argument === 'string' ? argument.split(/\s+/).filter(Boolean) : argument,
        rawArgument: argument
    };
}

function writeRdtfResponse(res, command, ok, error, details) {
    const response = {
        cmd: command,
        status: ok,
        ...(ok ? {} : { error: error || 'Command execution failed' })
    };
    if (details && !ok) {
        response.details = details;
    }
    res.status(ok ? 200 : 500).json(response);
}

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        errorCode: 0,
        ErrorDescription: 'Server is running'
    });
});

app.get('/config', async (req, res) => {
    const cfg = loadRuntimeConfig();
    const fwRevisions = await readFirmwareRevisions();
    const m1FwRev = fwRevisions.m1 && fwRevisions.m1.status ? fwRevisions.m1.fw : null;
    const uiSnapVersion = readUiSnapVersion();
    const restServerSnapVersion = readRestServerSnapVersion(cfg);
    res.json({
        status: 'OK',
        machineName: process.env.MACHINE_NAME || cfg.machineName || 'FC?',
        vendorSite: process.env.VENDOR_SITE || cfg.vendorSite || '',
        configFile: resolveRuntimeConfigFile(),
        logFile: resolveLogFile(),
        snapVersion: restServerSnapVersion,
        uiSnapVersion,
        restServerSnapVersion,
        m1tfcSnapVersion: readM1tfcSnapVersion(),
        m1FixtureAgentSnapVersion: readFixtureAgentSnapVersion(cfg),
        fwVersion: readFwVersion(cfg),
        stm32mp1FW: m1FwRev || readStm32mp1FwVersion(cfg),
        tfcroncliVersion: readTfcroncliVersion(cfg),
        m1tb: fwRevisions.m1tb,
        acm: fwRevisions.acm
    });
});

app.get('/logs/stream', (req, res) => {
    res.status(410).json({
        status: 'FAILED',
        errorCode: 14,
        ErrorDescription: 'Log SSE stream is disabled. Use /command/stream for command output.'
    });
});

app.get('/logs/tail', (req, res) => {
    const logFile = resolveLogFile();
    if (!logFile) {
        return res.status(400).json({
            status: 'FAILED',
            errorCode: 14,
            ErrorDescription: 'Log file not configured'
        });
    }

    ensureLogFile(logFile);
    const maxLines = 2000;
    const linesReq = Number(req.query.lines || 100);
    const numLines = Math.min(Math.max(linesReq, 1), maxLines);
    res.json({
        status: 'OK',
        lines: tailLogLines(logFile, numLines)
    });
});

app.get('/logs/download', (req, res) => {
    if (commandRunner.currentChild) {
        return res.status(409).json({
            status: 'FAILED',
            errorCode: 15,
            ErrorDescription: 'Log download is only available while idle (no command running)'
        });
    }

    const logFile = resolveLogFile();
    if (!logFile) {
        return res.status(400).json({
            status: 'FAILED',
            errorCode: 14,
            ErrorDescription: 'Log file not configured'
        });
    }

    ensureLogFile(logFile);
    const rawSerial = String(req.query.serial || '').trim();
    const safeSerial = rawSerial.replace(/[^A-Za-z0-9_-]/g, '');
    const downloadName = safeSerial
        ? `${safeSerial}${path.extname(logFile)}`
        : path.basename(logFile);
    return res.download(logFile, downloadName);
});

app.post('/logs/clear', (req, res) => {
    const logFile = resolveLogFile();
    if (!logFile) {
        return res.status(400).json({
            status: 'FAILED',
            errorCode: 14,
            ErrorDescription: 'Log file not configured'
        });
    }

    ensureLogFile(logFile);
    fs.writeFileSync(logFile, `${new Date().toISOString()}\n`, 'utf8');
    res.json({
        status: 'OK',
        errorCode: 0,
        ErrorDescription: 'Log file cleared'
    });
});

app.get('/commands', (req, res) => {
    res.json({
        status: 'OK',
        errorCode: 0,
        ErrorDescription: 'Supported command list',
        commands: getSupportedCommands()
    });
});

app.get('/test-hook/status', (req, res) => {
    res.json({
        enabled: testHookReportOnly,
        totalReported: testHookHistory.length
    });
});

app.get('/test-hook/last-command', (req, res) => {
    res.json({
        report: testHookHistory[testHookHistory.length - 1] || null
    });
});

app.post('/auth', (req, res) => {
    const { pin, mode } = req.body || {};
    if (!mode || typeof mode !== 'string' || !VALID_PIN_MODES.has(mode)) {
        return res.status(400).json({ status: 'FAILED', ErrorDescription: 'Invalid PIN mode' });
    }
    if (!pin || typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
        return res.status(400).json({ status: 'FAILED', ErrorDescription: 'Invalid PIN format' });
    }
    if (verifyPassword(mode, pin)) return res.json({ status: 'OK' });
    res.status(401).json({ status: 'FAILED', ErrorDescription: 'Wrong password' });
});

app.post('/changepin', (req, res) => {
    const { pin, mode } = req.body || {};
    if (!mode || typeof mode !== 'string' || !VALID_PIN_MODES.has(mode)) {
        return res.status(400).json({ status: 'FAILED', ErrorDescription: 'Invalid PIN mode' });
    }
    if (!pin || typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
        return res.status(400).json({ status: 'FAILED', ErrorDescription: 'Invalid PIN format' });
    }
    try {
        savePassword(mode, pin);
        res.json({ status: 'OK' });
    } catch (err) {
        logger.error('Failed to save password', { mode, error: err.message });
        res.status(500).json({ status: 'FAILED', ErrorDescription: 'Failed to save password' });
    }
});

async function handleCommandExecution(req, res, source) {
    const { command, argument } = normalizeIncomingCommandRequest(req.body || {});

    if (!command || typeof command !== 'string') {
        if (source === 'rdtf') {
            res.status(400).json({ status: false, error: 'Field "cmd" must be a non-empty string' });
            return;
        }

        res.status(400).json({
            status: 'FAILED',
            errorCode: 14,
            ErrorDescription: 'Field "command" must be a non-empty string'
        });
        return;
    }

    if (command === 'help') {
        const cmds = getSupportedCommands();
        const helpData = {
            commands: cmds.join('  '),
            argument: 'string "--flag val"  |  array ["--flag","val"]  |  object {positional:["val"], flag:"val", boolFlag:true}'
        };
        if (source === 'rdtf') {
            res.status(200).json({ cmd: 'help', status: true, ...helpData });
            return;
        }
        res.status(200).json({ status: 'OK', errorCode: 0, ErrorDescription: 'Help', commands: cmds, ...helpData });
        return;
    }

    if (testHookReportOnly) {
        const report = createTestHookReport(command, argument);
        testHookHistory.push(report);
        if (source === 'rdtf') {
            res.status(200).json({ cmd: command, status: true, report });
            return;
        }

        res.status(200).json({
            status: 'OK',
            errorCode: 0,
            ErrorDescription: 'Success',
            report
        });
        return;
    }

    const result = await commandRunner.run(command, argument);
    if (source === 'rdtf') {
        writeRdtfResponse(res, command, result.status === 'OK', result.ErrorDescription, {
            errorCode: result.errorCode,
            commandOutput: result.commandOutput
        });
        return;
    }

    res.status(result.status === 'OK' ? 200 : 500).json(result);
}

async function handleCommandStreamingExecution(req, res) {
    const { command, argument } = normalizeIncomingCommandRequest(req.body || {});

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    if (!command || typeof command !== 'string') {
        res.write(`data: ${JSON.stringify({ error: 'Field "command" must be a non-empty string' })}\n\n`);
        res.end();
        return;
    }

    if (command === 'help') {
        const cmds = getSupportedCommands();
        res.write(`data: ${JSON.stringify({ commands: cmds.join('  ') })}\n\n`);
        res.end();
        return;
    }

    await commandRunner.runStream(command, argument, res);
}

app.get('/help', (req, res) => {
    res.json({
        status: 'OK',
        routes: [
            { method: 'GET',  path: '/health',              description: 'Server liveness check' },
            { method: 'GET',  path: '/config',              description: 'Runtime config: machineName, logFile, uiSnapVersion, restServerSnapVersion, m1FixtureAgentSnapVersion, fwVersion' },
            { method: 'GET',  path: '/help',                description: 'This help document' },
            { method: 'GET',  path: '/commands',            description: 'List supported command names' },
            { method: 'POST', path: '/command',             description: 'Run one command, returns full JSON result' },
            { method: 'POST', path: '/command/stream',      description: 'Run one command, streams output as SSE' },
            { method: 'POST', path: '/command/stop',        description: 'Stop the currently running command' },
            { method: 'POST', path: '/commands/',           description: 'Run one command, returns RDTF-style {cmd, status} response' },
            { method: 'POST', path: '/auth',                description: 'Verify PIN — body: { pin, mode: "production"|"debug" }' },
            { method: 'POST', path: '/changepin',           description: 'Change PIN — body: { currentPin, newPin, mode: "production"|"debug" }' },
            { method: 'GET',  path: '/logs/stream',         description: 'Disabled; use /command/stream for command output streaming' },
            { method: 'GET',  path: '/logs/tail',           description: 'Last N log lines — query: ?lines=<N> (default 100, max 2000)' },
            { method: 'GET',  path: '/logs/download',       description: 'Download full log file' },
            { method: 'POST', path: '/logs/clear',          description: 'Truncate the log file' }
        ],
        commandEndpoint: {
            path: '/command',
            method: 'POST',
            body: {
                command: `One of: ${getSupportedCommands().join(', ')}`,
                argument: {
                    description: 'Optional. Accepted formats:',
                    string:  '"--flag value --other"',
                    array:   '["--flag", "value"]',
                    object:  '{ "positional": ["val"], "flagName": "value", "boolFlag": true }'
                }
            }
        }
    });
});

app.post('/command', async (req, res) => {
    await handleCommandExecution(req, res, 'json');
});

app.post('/command/stream', async (req, res) => {
    await handleCommandStreamingExecution(req, res);
});

app.post('/command/stop', (req, res) => {
    res.json(commandRunner.cancelCurrent());
});

app.post('/commands/', async (req, res) => {
    await handleCommandExecution(req, res, 'rdtf');
});

app.use((err, req, res, next) => {
    res.status(500).json({
        status: 'FAILED',
        errorCode: 3,
        ErrorDescription: err && err.message ? err.message : 'Internal server error'
    });
});

function startServer() {
    const server = app.listen(port, host, () => {
        logger.info(`m1tfc REST server listening on http://${host}:${port}`);
        logger.info(`CLI command: ${defaultCliPath} ${defaultCliArgs.join(' ')}`.trim());
        logger.info(`CLI cwd: ${cliCwd}`);
    });

    server.on('error', (err) => {
        console.error('Server error:', err.message);
        logger.error(`Server error: ${err.message}`);
        process.exit(1);
    });

    return server;
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    startServer
};
