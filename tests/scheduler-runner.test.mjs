import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLocalOrigin, portFromArgs, startLocalScheduler } from '../scripts/scheduler-runner.mjs';

test('the local scheduler accepts loopback HTTP origins and rejects remote or decorated targets', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8787', 'http://[::1]:5198']) {
    assert.equal(normalizeLocalOrigin(`${origin}/`), origin);
  }
  for (const origin of [
    'https://localhost:5173', 'http://runner.example.com', 'http://192.168.0.1',
    'http://localhost.example.com', 'http://user:secret@localhost:5173',
    'http://localhost:5173/path', 'http://localhost:5173/?token=secret',
    'http://localhost:5173/#fragment', 'not a URL',
  ]) assert.throws(() => normalizeLocalOrigin(origin));
});

test('the local scheduler follows explicit service ports and rejects invalid ports', () => {
  assert.equal(portFromArgs([], 5173), 5173);
  assert.equal(portFromArgs(['--host', '127.0.0.1', '--port', '5198'], 5173), 5198);
  assert.equal(portFromArgs(['-p', '5199'], 5173), 5199);
  assert.equal(portFromArgs(['--port=5200'], 5173), 5200);
  for (const args of [['--port'], ['--port', '0'], ['--port=65536'], ['-p', '1.5'], ['--port=abc']]) {
    assert.throws(() => portFromArgs(args, 5173));
  }
});

test('stopping the local scheduler aborts its active request without reporting an expected shutdown as an error', async () => {
  let request;
  let requests = 0;
  let aborted;
  const abortObserved = new Promise(resolve => { aborted = resolve; });
  const warnings = [];
  const stop = startLocalScheduler({
    origin: 'http://127.0.0.1:5198',
    pollIntervalMs: 10,
    logger: { info() {}, warn(message) { warnings.push(message); } },
    fetchImpl: async (url, init) => {
      requests++;
      request = { url, ...init };
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); }, { once: true });
      });
    },
  });
  assert.equal(request.url, 'http://127.0.0.1:5198/api/scheduler/tick');
  assert.equal(request.method, 'POST');
  assert.equal(request.body, '{}');
  assert.equal(request.redirect, 'error');
  assert.equal(request.signal.aborted, false);
  stop();
  stop();
  await abortObserved;
  await Promise.resolve();
  assert.equal(request.signal.aborted, true);
  assert.equal(requests, 1);
  assert.deepEqual(warnings, []);
});
