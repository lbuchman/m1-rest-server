'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { CommandRunner, getSupportedCommands } = require('../src/commandRunner');

function createMockChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = function kill(signal) {
        child.killed = true;
        child.signal = signal;
    };
    return child;
}

function nextTick() {
    return new Promise(resolve => setImmediate(resolve));
}

test('getSupportedCommands exposes the CLI surface', () => {
    const commands = getSupportedCommands();

    assert.ok(commands.includes('m1cmd'));
    assert.ok(commands.includes('m1tbcmd'));
    assert.ok(commands.includes('power'));
    assert.ok(commands.includes('poe'));
    assert.ok(!commands.includes('tbcmd'));
});

test('run rejects unsupported commands', async () => {
    const runner = new CommandRunner({
        spawnImpl: () => {
            throw new Error('spawn should not be called');
        }
    });

    const result = await runner.run('does-not-exist');

    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 14);
    assert.equal(result.ErrorDescription, 'Unsupported command "does-not-exist"');
    assert.equal(result.commandOutput, null);
});

test('run forwards arguments and merges JSON stdout into the response', async () => {
    const captured = {};
    const child = createMockChild();

    const runner = new CommandRunner({
        baseCommand: 'node',
        baseArgs: ['-e', 'mock'],
        cwd: 'C:/temp',
        env: { TEST_ENV: '1' },
        spawnImpl: (command, args, options) => {
            captured.command = command;
            captured.args = args;
            captured.options = options;
            return child;
        }
    });

    const resultPromise = runner.run('m1cmd', { c: 'hello world', positional: ['alpha', 'beta'], v: true });
    await nextTick();
    child.stdout.emit('data', Buffer.from('noise line\n'));
    child.stdout.emit('data', Buffer.from(JSON.stringify({ status: 'OK', errorCode: 0, ErrorDescription: 'Success', echoedArgs: ['m1cmd', 'alpha', 'beta', '-c', 'hello world', '-v'] })));
    child.emit('close', 0);

    const result = await resultPromise;

    assert.equal(captured.command, 'sudo');
    assert.deepEqual(captured.args, ['-n', 'node', '-e', 'mock', 'm1cmd', 'alpha', 'beta', '-c', 'hello world', '-v']);
    assert.deepEqual(captured.options, {
        cwd: 'C:/temp',
        env: { TEST_ENV: '1' },
        shell: false
    });
    assert.equal(result.status, 'OK');
    assert.equal(result.errorCode, 0);
    assert.equal(result.ErrorDescription, 'Success');
    assert.deepEqual(result.echoedArgs, ['m1cmd', 'alpha', 'beta', '-c', 'hello world', '-v']);
    assert.deepEqual(result.commandOutput, {
        status: 'OK',
        errorCode: 0,
        ErrorDescription: 'Success',
        echoedArgs: ['m1cmd', 'alpha', 'beta', '-c', 'hello world', '-v']
    });
});

test('run defaults to the m1tfc executable', async () => {
    const child = createMockChild();
    const captured = {};
    const runner = new CommandRunner({
        spawnImpl: (command, args) => {
            captured.command = command;
            captured.args = args;
            return child;
        }
    });

    const resultPromise = runner.run('m1cmd');
    await nextTick();
    child.emit('close', 0);

    assert.equal(captured.command, 'sudo');
    assert.deepEqual(captured.args, ['-n', 'm1tfc', 'm1cmd']);
    assert.equal((await resultPromise).status, 'OK');
});

test('run falls back to stderr text when the exit code is unknown', async () => {
    const child = createMockChild();

    const runner = new CommandRunner({
        spawnImpl: () => child
    });

    const resultPromise = runner.run('m1cmd');
    await nextTick();
    child.stderr.emit('data', Buffer.from('something failed\n'));
    child.emit('close', 99);

    const result = await resultPromise;

    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 99);
    assert.equal(result.ErrorDescription, 'something failed');
    assert.equal(result.commandOutput, null);
});

test('run serializes command execution', async () => {
    const children = [createMockChild(), createMockChild()];
    const started = [];

    const runner = new CommandRunner({
        spawnImpl: (command, args) => {
            started.push(args[2]);
            return children[started.length - 1];
        }
    });

    const firstResult = runner.run('m1cmd');
    const secondResult = runner.run('ict');
    await nextTick();

    assert.deepEqual(started, ['m1cmd']);

    children[0].emit('close', 0);
    await nextTick();

    assert.deepEqual(started, ['m1cmd', 'ict']);

    children[1].emit('close', 0);

    assert.equal((await firstResult).status, 'OK');
    assert.equal((await secondResult).status, 'OK');
});

test('runStream waits for an active command before starting', async () => {
    const children = [createMockChild(), createMockChild()];
    const started = [];
    const response = {
        write() {},
        end() {}
    };

    const runner = new CommandRunner({
        spawnImpl: (command, args) => {
            started.push(args[2]);
            return children[started.length - 1];
        }
    });

    const firstResult = runner.run('m1cmd');
    const streamResult = runner.runStream('ict', '', response);
    await nextTick();

    assert.deepEqual(started, ['m1cmd']);

    children[0].emit('close', 0);
    await nextTick();

    assert.deepEqual(started, ['m1cmd', 'ict']);

    children[1].emit('close', 0);

    assert.equal((await firstResult).status, 'OK');
    assert.equal((await streamResult).status, 'OK');
});

test('runStream preserves lines split across process output chunks', async () => {
    const child = createMockChild();
    const events = [];
    const response = {
        write(event) {
            events.push(event);
        },
        end() {}
    };
    const runner = new CommandRunner({
        spawnImpl: () => child
    });

    const resultPromise = runner.runStream('m1cmd', '', response);
    await nextTick();
    child.stdout.emit('data', Buffer.from('first par'));
    child.stdout.emit('data', Buffer.from('tial\nsecond'));
    child.stdout.emit('data', Buffer.from(' line\n'));
    child.emit('close', 0);

    const result = await resultPromise;
    const payloads = events.map(event => JSON.parse(event.slice(6)));

    assert.deepEqual(payloads, [
        { stream: 'stdout', line: 'first partial' },
        { stream: 'stdout', line: 'second line' },
        { stream: 'done', result }
    ]);
});

test('runStream terminates the child process when the response closes', async () => {
    const child = createMockChild();
    const response = new EventEmitter();
    let writesAfterClose = 0;
    let closed = false;
    response.write = () => {
        if (closed) writesAfterClose += 1;
    };
    response.end = () => {
        if (closed) writesAfterClose += 1;
    };
    const runner = new CommandRunner({
        spawnImpl: () => child
    });

    const resultPromise = runner.runStream('m1cmd', '', response);
    await nextTick();
    closed = true;
    response.emit('close');
    child.emit('close', null);

    assert.equal(child.killed, true);
    assert.equal(child.signal, 'SIGTERM');
    assert.equal(writesAfterClose, 0);
    assert.equal((await resultPromise).status, 'FAILED');
});

test('cancelCurrent terminates an active streamed command', async () => {
    const child = createMockChild();
    const events = [];
    const response = new EventEmitter();
    response.write = event => events.push(event);
    response.end = () => {};
    const runner = new CommandRunner({
        spawnImpl: () => child
    });

    const resultPromise = runner.runStream('m1cmd', '', response);
    await nextTick();
    const stopResult = runner.cancelCurrent();
    child.emit('close', null);

    const result = await resultPromise;
    const payloads = events.map(event => JSON.parse(event.slice(6)));

    assert.equal(stopResult.status, 'OK');
    assert.equal(stopResult.stopped, true);
    assert.equal(child.killed, true);
    assert.equal(child.signal, 'SIGTERM');
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 130);
    assert.equal(result.ErrorDescription, 'Stopped by operator');
    assert.deepEqual(payloads, [{ stream: 'done', result }]);
});

test('cancelCurrent reports no-op when no command is active', () => {
    const runner = new CommandRunner();
    const result = runner.cancelCurrent();

    assert.equal(result.status, 'OK');
    assert.equal(result.stopped, false);
    assert.equal(result.ErrorDescription, 'No command is running');
});