/**
 * Behavior tests against the real engine/store SQL, using an in-memory SQLite
 * adapter for D1. Run with Node >= 22.13: node --test tests/engine.test.mjs
 */
import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { createHarness, functionSpec } from './harness.mjs';

const harness = await createHarness();
const { sqlite, engine } = harness;
const { startRun, executeRun, functionExecutors, executeFunction, cancelRun, parseTask, publicEndpoint } = engine;

beforeEach(() => harness.reset());
after(() => harness.close());

function task(functions, extra = {}) {
  return parseTask({ name: '引擎行为验证', description: '', status: 'active', functions, initialContext: {}, loop: { maxIterations: 1 }, ...extra });
}

test('loop stops on Context condition and records disabled Functions without executing them', async () => {
  const definition = task([functionSpec(), functionSpec({ enabled: false, handler: 'resource.add', config: { name: '不应生成', value: 1 } })], { loop: { maxIterations: 5, stopPath: 'count', stopValue: 2 } });
  const run = await startRun(definition);
  assert.equal(run.status, 'success');
  assert.equal(run.iteration, 2);
  assert.equal(run.context.count, 2);
  assert.equal(run.steps.filter(step => step.status === 'skipped').length, 2);
  assert.deepEqual(run.resources, []);
  assert.deepEqual(definition.initialContext, {});
});

test('ordered Functions share nested Context and resources while separate Runs keep their initial state', async () => {
  const initialContext = {
    nested: { foo: 'initial', removedBySet: true },
    user: { id: 'initial-user', removedBySet: true },
    tokens: ['initial-token'],
    request: 'default',
    initialOnly: { preserved: true },
  };
  const definition = task([
    functionSpec({ name: '写入数据', handler: 'context.set', config: { values: {
      nested: { foo: 'from-function-one' },
      user: { id: 'user-one' },
      tokens: ['token-a', 'token-b'],
    } } }),
    functionSpec({ name: '派生数据', handler: 'context.merge', config: { values: {
      nested: { derived: '{{context.nested.foo}}' },
      user: { display: 'Hello {{context.user.id}}' },
      tokenSnapshot: '{{context.tokens}}',
      requestSeen: '{{context.request}}',
      runSeen: '{{runId}}',
    } } }),
    functionSpec({ name: '记录最终上下文', handler: 'resource.add', config: {
      name: 'Context {{context.request}}', type: 'application/json', value: '{{context}}',
    } }),
  ], { initialContext });
  const first = await startRun(definition, { request: 'first' });
  const second = await startRun(definition, { request: 'second' });

  for (const [run, request] of [[first, 'first'], [second, 'second']]) {
    assert.equal(run.status, 'success');
    assert.deepEqual(run.steps.map(step => step.status), ['success', 'success', 'success']);
    assert.deepEqual(run.context.nested, { foo: 'from-function-one', derived: 'from-function-one' });
    assert.deepEqual(run.context.user, { id: 'user-one', display: 'Hello user-one' });
    assert.deepEqual(run.context.tokens, ['token-a', 'token-b']);
    assert.deepEqual(run.context.tokenSnapshot, ['token-a', 'token-b']);
    assert.equal(run.context.requestSeen, request);
    assert.equal(run.context.runSeen, run.id);
    assert.deepEqual(run.context.initialOnly, { preserved: true });
    assert.equal(run.resources.length, 1);
    assert.equal(run.resources[0].name, `Context ${request}`);
    assert.equal(run.resources[0].functionId, definition.functions[2].id);
    assert.equal(run.resources[0].iteration, 1);
    assert.deepEqual(run.resources[0].value, run.context);
  }
  assert.notEqual(first.id, second.id);
  first.context.nested.foo = 'local result mutation';
  first.resources[0].value.tokens.push('local-token');
  assert.equal(second.context.nested.foo, 'from-function-one');
  assert.deepEqual(second.resources[0].value.tokens, ['token-a', 'token-b']);
  assert.deepEqual(definition.initialContext, initialContext);
  assert.deepEqual((await engine.getRun(first.id)).context.nested, { foo: 'from-function-one', derived: 'from-function-one' });
});

test('failed attempts receive isolated Context and resource inputs', async () => {
  const original = functionExecutors['counter.increment'];
  let calls = 0;
  functionExecutors['counter.increment'] = { async execute(_fn, input) {
    calls++;
    input.context.nested.count++;
    input.resources.push({ id: 'temporary' });
    if (calls === 1) throw new Error('first attempt fails after mutation');
    return { context: { nested: input.context.nested } };
  } };
  try {
    const definition = task([functionSpec({ retries: 1 })], { initialContext: { nested: { count: 0 } } });
    const run = await startRun(definition);
    assert.equal(run.status, 'success');
    assert.equal(calls, 2);
    assert.equal(run.context.nested.count, 1);
    assert.equal(run.steps[0].attempt, 2);
    assert.deepEqual(run.resources, []);
    assert.equal(definition.initialContext.nested.count, 0);
  } finally { functionExecutors['counter.increment'] = original; }
});

test('an explicit null Loop stop value remains distinct from the default true', async () => {
  const run = await startRun(task([functionSpec({ handler: 'context.set', config: { values: { completed: null } } })], { loop: { maxIterations: 3, stopPath: 'completed', stopValue: null } }));
  assert.equal(run.status, 'success');
  assert.equal(run.iteration, 1);
  assert.equal(run.steps.length, 1);
});

test('onError continue records a failed step and executes the next Function', async () => {
  const run = await startRun(task([functionSpec({ config: { key: 'count', amount: 'invalid' }, onError: 'continue' }), functionSpec()]));
  assert.equal(run.status, 'success');
  assert.equal(run.steps[0].status, 'failed');
  assert.equal(run.steps[1].status, 'success');
  assert.equal(run.context.count, 1);
});

test('untrusted counter paths cannot alter prototypes', async () => {
  const input = { runId: 'r', iteration: 1, context: {}, resources: [], secrets: () => undefined };
  for (const key of ['__proto__', '__proto__.polluted', 'constructor', 'prototype']) {
    await assert.rejects(executeFunction(functionSpec({ config: { key, amount: 1 } }), input), /顶层字段名/);
  }
  assert.equal({}.polluted, undefined);
});

test('remote failure is sent once even when retries is configured', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('connection lost'); };
  try {
    const run = await startRun(task([functionSpec({ handler: 'code.remote', config: { endpoint: 'https://runner.example.com/functions/code', code: 'return {}' }, retries: 3 })]));
    assert.equal(run.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(run.steps[0].attempt, 1);
    assert.match(run.error, /不会自动重试/);
  } finally { globalThis.fetch = originalFetch; }
});

test('cancellation during a remote Function cannot be overwritten and concurrent resume is rejected', async () => {
  const originalFetch = globalThis.fetch;
  let releaseResponse;
  let announce;
  const entered = new Promise(resolve => { announce = resolve; });
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    announce(payload.runId);
    return new Promise(resolve => { releaseResponse = () => resolve(Response.json({ context: { lateResult: true } })); });
  };
  try {
    const pending = startRun(task([functionSpec({ handler: 'code.remote', config: { endpoint: 'https://runner.example.com/functions/code' } })]));
    const id = await entered;
    await assert.rejects(executeRun(id), /锁定/);
    assert.equal((await cancelRun(id)).status, 'cancelled');
    releaseResponse();
    const run = await pending;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.context.lateResult, undefined);
    await assert.rejects(executeRun(id), /已经结束/);
  } finally { globalThis.fetch = originalFetch; }
});

test('a persisted in-flight external operation blocks replay after a lost executor', async () => {
  const definition = task([functionSpec()]);
  const created = await startRun(definition);
  // Simulate a checkpoint from a killed worker with an unknown remote result.
  sqlite.prepare("UPDATE runs SET status='paused', inflight_function='1:remote', locked_until=NULL, lock_token=NULL WHERE id=?").run(created.id);
  const run = await executeRun(created.id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /结果未知/);
  assert.equal(run.context.count, 1);
});

test('time budget checkpoints resume at the next Function without replaying completed work', async () => {
  const originalExecutor = functionExecutors['counter.increment'];
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  functionExecutors['counter.increment'] = { async execute(h, input) {
    const result = await originalExecutor.execute(h, input);
    clock += 19_000;
    return result;
  } };
  try {
    const paused = await startRun(task([functionSpec(), functionSpec()]));
    assert.equal(paused.status, 'paused');
    assert.equal(paused.context.count, 1);
    assert.equal(paused.functionIndex, 1);
    functionExecutors['counter.increment'] = originalExecutor;
    Date.now = originalNow;
    const resumed = await executeRun(paused.id);
    assert.equal(resumed.status, 'success');
    assert.equal(resumed.context.count, 2);
    assert.equal(resumed.steps.length, 2);
  } finally { Date.now = originalNow; functionExecutors['counter.increment'] = originalExecutor; }
});

test('public endpoints reject private/IP/credential URLs', () => {
  for (const endpoint of ['http://runner.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://runner.local', 'https://user:password@runner.example.com', 'https://runner.example.com:9443']) {
    assert.throws(() => publicEndpoint(endpoint));
  }
  assert.equal(publicEndpoint('https://runner.example.com/functions').hostname, 'runner.example.com');
});
