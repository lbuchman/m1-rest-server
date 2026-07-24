'use strict';

const { spawn } = require('child_process');
const { exitCodeDescriptions } = require('./errorMap');
const logger = require('./logger');

const supportedCommands = new Set([
    'm1dfu',
    'm1tbcmd',
    'm1cmd',
    'mnpcmd',
    'reboot',
    'ict',
    'eeprom',
    'progmac',
    'flash',
    'pingM1apps',
    'cleanup',
    'functest',
    'makelabel',
    'power',
    'poe'
]);

function getSupportedCommands() {
    return Array.from(supportedCommands);
}



function parseJsonStdout(stdout) {
    if (!stdout) return null;

    const trimmed = stdout.trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed);
    }
    catch (err) {
        // Fall through to scan the output line by line.
    }

    const lines = trimmed
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
        try {
            return JSON.parse(lines[idx]);
        }
        catch (err) {
            // ignore and keep scanning backward
        }
    }

    return null;
}

function flagFor(key) {
    return key.length === 1 ? `-${key}` : `--${key}`;
}

function toArgv(argument) {
    if (argument === undefined || argument === null || argument === '') return [];
    if (typeof argument === 'string') {
        return argument.split(/\s+/).filter(Boolean);
    }
    if (typeof argument === 'number') return [String(argument)];
    if (typeof argument !== 'object' || Array.isArray(argument)) return [String(argument)];

    const argv = [];

    if (Array.isArray(argument.positional)) {
        for (const item of argument.positional) {
            argv.push(String(item));
        }
    }

    for (const [key, value] of Object.entries(argument)) {
        if (key === 'positional') continue;
        if (value === undefined || value === null || value === false) continue;

        const flag = flagFor(key);
        if (value === true) {
            argv.push(flag);
            continue;
        }

        argv.push(flag, String(value));
    }

    return argv;
}

function withSudo(baseCommand, args) {
    return {
        command: 'sudo',
        args: ['-n', baseCommand, ...args]
    };
}

function buildResult(exitCode, stdout, stderr) {
    const parsedOutput = parseJsonStdout(stdout);
    const fallbackStatus = exitCode === 0 ? 'OK' : 'FAILED';
    const status = parsedOutput && typeof parsedOutput.status === 'string'
        ? parsedOutput.status
        : fallbackStatus;
    const errorCode = parsedOutput && Number.isInteger(parsedOutput.errorCode)
        ? parsedOutput.errorCode
        : exitCode;
    const description = parsedOutput && typeof parsedOutput.ErrorDescription === 'string'
        ? parsedOutput.ErrorDescription
        : parsedOutput && typeof parsedOutput.errorDescription === 'string'
            ? parsedOutput.errorDescription
            : descriptionFor(exitCode, stderr);

    if (parsedOutput && typeof parsedOutput === 'object' && !Array.isArray(parsedOutput)) {
        return {
            ...parsedOutput,
            status,
            errorCode,
            ErrorDescription: description,
            commandOutput: parsedOutput
        };
    }

    return {
        status,
        errorCode,
        ErrorDescription: description,
        commandOutput: parsedOutput
    };
}

function descriptionFor(exitCode, stderr) {
    if (exitCodeDescriptions[exitCode]) return exitCodeDescriptions[exitCode];
    const fallback = stderr
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .pop();
    return fallback || 'Unknown error';
}

function stoppedResult() {
    return {
        status: 'FAILED',
        errorCode: 130,
        ErrorDescription: 'Stopped by operator',
        commandOutput: null
    };
}

function normalizeCommand(command, argument) {
    if (command === 'reboot') {
        return {
            command: 'm1cmd',
            argument: { command: 'reboot' }
        };
    }

    return {
        command,
        argument
    };
}

class CommandRunner {
    constructor(options = {}) {
        this.baseCommand = options.baseCommand || 'm1tfc';
        this.baseArgs = Array.isArray(options.baseArgs) ? options.baseArgs : [];
        this.cwd = options.cwd || process.cwd();
        this.env = options.env || process.env;
        this.spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
        this.queue = Promise.resolve();
        this.currentChild = null;
        this.currentCommand = null;
        this.cancelRequested = false;
    }

    enqueue(operation) {
        const queued = this.queue.catch(() => undefined).then(operation);
        this.queue = queued.catch(() => undefined);
        return queued;
    }

    run(command, argument) {
        if (!supportedCommands.has(command)) {
            return Promise.resolve({
                status: 'FAILED',
                errorCode: 14,
                ErrorDescription: `Unsupported command "${command}"`,
                commandOutput: null
            });
        }

        const normalized = normalizeCommand(command, argument || '');
        return this.enqueue(() => this.execute(normalized.command, normalized.argument || ''));
    }

    cancelCurrent() {
        if (!this.currentChild || this.currentChild.killed || typeof this.currentChild.kill !== 'function') {
            return {
                status: 'OK',
                stopped: false,
                ErrorDescription: 'No command is running'
            };
        }

        this.cancelRequested = true;
        logger.warn('Stopping current command', this.currentCommand || {});
        this.currentChild.kill('SIGTERM');
        return {
            status: 'OK',
            stopped: true,
            ErrorDescription: 'Stop requested',
            command: this.currentCommand
        };
    }

    execute(command, argument) {
        return new Promise((resolve) => {
            const cmdArgs = [...this.baseArgs, command, ...toArgv(argument)];
            const sudoCommand = withSudo(this.baseCommand, cmdArgs);
            
            // Log environment context for debugging
            logger.info('Executing command with environment', {
                command: sudoCommand.command,
                args: sudoCommand.args,
                cwd: this.cwd,
                PATH: this.env.PATH,
                SNAP_DATA: this.env.SNAP_DATA,
                SNAP_COMMON: this.env.SNAP_COMMON,
                USER: this.env.USER,
                HOME: this.env.HOME,
                NODE_ENV: this.env.NODE_ENV
            });

            const child = this.spawnImpl(sudoCommand.command, sudoCommand.args, {
                cwd: this.cwd,
                env: this.env,
                shell: false
            });

            this.currentChild = child;
            this.currentCommand = { command, args: cmdArgs, stream: false };
            this.cancelRequested = false;

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', chunk => {
                const data = chunk.toString();
                stdout += data;
                logger.info(`[STDOUT] ${data.trim()}`);
            });

            child.stderr.on('data', chunk => {
                const data = chunk.toString();
                stderr += data;
                logger.warn(`[STDERR] ${data.trim()}`);
            });

            child.on('error', err => {
                const errorMsg = `Failed to start command process: ${err.message}`;
                logger.error(errorMsg, {
                    command: this.baseCommand,
                    args: cmdArgs,
                    cwd: this.cwd,
                    envPath: this.env.PATH
                });
                if (this.currentChild === child) {
                    this.currentChild = null;
                    this.currentCommand = null;
                    this.cancelRequested = false;
                }
                resolve({
                    status: 'FAILED',
                    errorCode: 3,
                    ErrorDescription: errorMsg,
                    commandOutput: null
                });
            });

            child.on('close', code => {
                const exitCode = Number.isInteger(code) ? code : 3;
                const wasStopped = this.cancelRequested && this.currentChild === child;
                const result = wasStopped ? stoppedResult() : buildResult(exitCode, stdout, stderr);
                if (exitCode !== 0 && !wasStopped) {
                    logger.error(`Command exited with code ${exitCode}`, {
                        command: sudoCommand.command,
                        args: sudoCommand.args,
                        cwd: this.cwd,
                        stderr: stderr.substring(0, 200)
                    });
                }
                if (this.currentChild === child) {
                    this.currentChild = null;
                    this.currentCommand = null;
                    this.cancelRequested = false;
                }
                resolve(result);
            });
        });
    }

    runStream(command, argument, res) {
        if (!supportedCommands.has(command)) {
            res.write(`data: ${JSON.stringify({
                stream: 'done',
                result: {
                    status: 'FAILED',
                    errorCode: 14,
                    ErrorDescription: `Unsupported command "${command}"`,
                    commandOutput: null
                }
            })}\n\n`);
            res.end();
            return Promise.resolve({
                status: 'FAILED',
                errorCode: 14,
                ErrorDescription: `Unsupported command "${command}"`,
                commandOutput: null
            });
        }
        const normalized = normalizeCommand(command, argument || '');
        return this.enqueue(() => this.executeStream(normalized.command, normalized.argument || '', res));
    }

    executeStream(command, argument, res) {
        return new Promise((resolve) => {
            const cmdArgs = [...this.baseArgs, command, ...toArgv(argument)];
            const sudoCommand = withSudo(this.baseCommand, cmdArgs);

            logger.info('Executing command (stream)', {
                command: sudoCommand.command,
                args: sudoCommand.args
            });

            const child = this.spawnImpl(sudoCommand.command, sudoCommand.args, {
                cwd: this.cwd,
                env: this.env,
                shell: false
            });

            this.currentChild = child;
            this.currentCommand = { command, args: cmdArgs, stream: true };
            this.cancelRequested = false;

            let stdout = '';
            let stderr = '';
            let finished = false;
            let responseClosed = false;

            const streamLines = (stream) => {
                let pending = '';

                const writeLine = (line) => {
                    if (line.trim()) {
                        res.write(`data: ${JSON.stringify({ stream, line })}\n\n`);
                    }
                };

                return {
                    write(data) {
                        pending += data;
                        const lines = pending.split(/\r?\n/);
                        pending = lines.pop();
                        lines.forEach(writeLine);
                    },
                    flush() {
                        if (pending) writeLine(pending);
                        pending = '';
                    }
                };
            };

            const stdoutLines = streamLines('stdout');
            const stderrLines = streamLines('stderr');

            const finish = (result) => {
                if (finished) return;
                finished = true;
                res.off?.('close', abortChild);
                if (!responseClosed) {
                    res.write(`data: ${JSON.stringify({ stream: 'done', result })}\n\n`);
                    res.end();
                }
                resolve(result);
            };

            const abortChild = () => {
                responseClosed = true;
                this.cancelRequested = true;
                if (finished || child.killed || typeof child.kill !== 'function') return;
                child.kill('SIGTERM');
            };

            res.on?.('close', abortChild);

            child.stdout.on('data', chunk => {
                const data = chunk.toString();
                stdout += data;
                stdoutLines.write(data);
            });

            child.stderr.on('data', chunk => {
                const data = chunk.toString();
                stderr += data;
                stderrLines.write(data);
            });

            child.on('error', err => {
                const errorMsg = `Failed to start: ${err.message}`;
                stderr += errorMsg;
                stderrLines.write(`${errorMsg}\n`);
                if (this.currentChild === child) {
                    this.currentChild = null;
                    this.currentCommand = null;
                    this.cancelRequested = false;
                }
                finish(buildResult(3, stdout, stderr));
            });

            child.on('close', code => {
                const exitCode = Number.isInteger(code) ? code : 3;
                const wasStopped = this.cancelRequested && this.currentChild === child;
                const result = wasStopped ? stoppedResult() : buildResult(exitCode, stdout, stderr);
                stdoutLines.flush();
                stderrLines.flush();
                if (this.currentChild === child) {
                    this.currentChild = null;
                    this.currentCommand = null;
                    this.cancelRequested = false;
                }
                finish(result);
            });
        });
    }
}

module.exports = {
    CommandRunner,
    supportedCommands,
    getSupportedCommands
};
