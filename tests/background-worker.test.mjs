/** Agent submissions are owned by the platform until their final result exists. */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createHarness, functionSpec } from './harness.mjs';

const harness = await createHarness({ scheduler: true });
const { db, sqlite, engine } = harness;
const { parseTask, createTask, getTask, updateTask, deleteTask, getRun, listRuns, createRun, insertRun, enqueueRun, cancelRun, tickScheduler, getRunResult, listCompletions, functionExecutors } = engine;
beforeEach(() => harness.reset());
after(() => harness.close());
const task = (functions = [functionSpec()], extra = {}) => parseTask({ name: '后台托管任务', status: 'active', functions, initialContext: { count: 0 }, loop: { maxIterations: 1 }, ...extra });
const save = (previous, patch) => updateTask(parseTask({ ...patch, version: previous.version }, previous), previous.version);

test('submission only queues a snapshot and the next worker tick finishes it without Agent control', async () => {
  const definition = await createTask(task());
  const queued = await enqueueRun(definition, {}, { recipient: 'agent-one' });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.execution, 'background');
  assert.equal(queued.context.count, 0);
  assert.equal(queued.steps.length, 0);
  assert.equal(await getRunResult(queued.id), null);
  assert.deepEqual(await listCompletions('agent-one'), []);
  const tick = await tickScheduler(db);
  assert.deepEqual(tick.started, [queued.id]);
  assert.deepEqual(tick.resumed, []);
  const result = await getRunResult(queued.id);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.output, { count: 1 });
  assert.equal(result.recipient, 'agent-one');
  for (const internal of ['steps', 'logs', 'definition', 'functionIndex']) assert.equal(result[internal], undefined);
  assert.equal((await listCompletions('agent-one')).length, 1);
});

test('Functions and Loop rounds share Context; the Agent receives only the selected final output', async () => {
  const definition = await createTask(task([
    functionSpec(),
    functionSpec({ handler: 'context.merge', config: { values: { result: { count: '{{context.count}}', customer: '{{context.customer.name}}' } } } }),
    functionSpec({ handler: 'resource.add', config: { name: 'round.json', type: 'application/json', value: '{{context.result}}' } }),
  ], { initialContext: { count: 0, customer: { name: 'initial' }, internal: 'scratch' }, loop: { maxIterations: 5, stopPath: 'count', stopValue: 2 }, result: { path: 'result', recipient: 'review-agent' } }));
  for (const name of ['first', 'second']) {
    const run = await enqueueRun(definition, { customer: { name } });
    await tickScheduler(db);
    const final = await getRun(run.id);
    const result = await getRunResult(run.id);
    assert.equal(final.iteration, 2);
    assert.equal(final.steps.length, 6);
    assert.equal(final.resources.length, 2);
    assert.deepEqual(final.resources.map(resource => resource.value.count), [1, 2]);
    assert.deepEqual(result.output, { count: 2, customer: name });
    assert.equal(result.output.internal, undefined);
    assert.equal(result.recipient, 'review-agent');
  }
  assert.equal((await listCompletions('review-agent')).length, 2);
});

test('time-budget checkpoints continue on later ticks and never emit intermediate completion entries', async () => {
  const previousExecutor = functionExecutors['counter.increment'];
  const previousNow = Date.now;
  let clock = previousNow();
  Date.now = () => clock;
  let calls = 0;
  functionExecutors['counter.increment'] = { async execute(fn, input) {
    calls++;
    const output = await previousExecutor.execute(fn, input);
    clock += 19_000;
    return output;
  } };
  try {
    const definition = await createTask(task([functionSpec(), functionSpec(), functionSpec()]));
    const run = await enqueueRun(definition);
    const first = await tickScheduler(db);
    assert.deepEqual(first.started, [run.id]);
    assert.equal((await getRun(run.id)).status, 'paused');
    assert.equal((await getRun(run.id)).functionIndex, 1);
    assert.equal(await getRunResult(run.id), null);
    assert.deepEqual(await listCompletions(), []);
    const second = await tickScheduler(db);
    assert.deepEqual(second.resumed, [run.id]);
    assert.equal((await getRun(run.id)).functionIndex, 2);
    assert.deepEqual(await listCompletions(), []);
    const third = await tickScheduler(db);
    assert.deepEqual(third.resumed, [run.id]);
    assert.equal((await getRun(run.id)).status, 'success');
    assert.deepEqual((await getRunResult(run.id)).output, { count: 3 });
    assert.equal(calls, 3);
    assert.equal((await listCompletions()).length, 1);
    await tickScheduler(db);
    assert.equal(calls, 3);
    assert.equal((await listCompletions()).length, 1);
  } finally { Date.now = previousNow; functionExecutors['counter.increment'] = previousExecutor; }
});

test('failure and cancellation each produce one final result; cancelled queued work never executes', async () => {
  const cancelledTask = await createTask(task());
  const cancelled = await enqueueRun(cancelledTask);
  await cancelRun(cancelled.id);
  const failedTask = await createTask(task(undefined, { initialContext: { count: 'invalid' } }));
  const failed = await enqueueRun(failedTask);
  await tickScheduler(db);
  assert.equal((await getRun(cancelled.id)).steps.length, 0);
  assert.equal((await getRunResult(cancelled.id)).status, 'cancelled');
  assert.equal((await getRunResult(failed.id)).status, 'failed');
  assert.match((await getRunResult(failed.id)).error, /数字/);
  for (let index = 0; index < 3; index++) await tickScheduler(db);
  assert.equal((await listCompletions()).length, 2);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM run_completions').get().n, 2);
});

test('concurrent ticks dispatch a queued remote Function at most once', async () => {
  const previousFetch = globalThis.fetch;
  let release;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    enter();
    return new Promise(resolve => { release = () => resolve(Response.json({ context: { result: 'done' } })); });
  };
  try {
    const definition = await createTask(task([functionSpec({ handler: 'code.remote', config: { endpoint: 'https://runner.example.com/task' } })]));
    const run = await enqueueRun(definition);
    const pending = Array.from({ length: 8 }, () => tickScheduler(db));
    await entered;
    release();
    const ticks = await Promise.all(pending);
    assert.equal(requests, 1);
    assert.equal(ticks.flatMap(tick => tick.started).length, 1);
    assert.equal((await getRunResult(run.id)).status, 'success');
    assert.equal((await listCompletions()).length, 1);
  } finally { globalThis.fetch = previousFetch; release?.(); }
});

test('a persisted uncertain operation fails on automatic recovery instead of repeating its side effect', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ context: { unexpected: true } }); };
  try {
    const remote = functionSpec({ handler: 'code.remote', config: { endpoint: 'https://runner.example.com/task' } });
    const definition = await createTask(task([remote]));
    const run = await enqueueRun(definition);
    sqlite.prepare("UPDATE runs SET status='running',inflight_function=?,locked_until=?,lock_token='expired' WHERE id=?").run(`1:${remote.id}`, Date.now()-1, run.id);
    const tick = await tickScheduler(db);
    assert.deepEqual(tick.resumed, [run.id]);
    assert.equal(calls, 0);
    const result = await getRunResult(run.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /结果未知/);
  } finally { globalThis.fetch = previousFetch; }
});

test('manual background work uses its saved snapshot after Task edits, pause, or deletion', async () => {
  for (const action of ['edited', 'paused', 'deleted']) {
    const definition = await createTask(task());
    const run = await enqueueRun(definition);
    if (action === 'deleted') await deleteTask(definition.id);
    else await save(definition, action === 'paused' ? { status: 'paused' } : { functions: [functionSpec({ config: { key: 'count', amount: 100 } })] });
    const tick = await tickScheduler(db);
    assert.deepEqual(tick.started, [run.id]);
    assert.deepEqual((await getRunResult(run.id)).output, { count: 1 });
  }
});

test('scheduled work still obeys pause, once rules, Loop conditions, and final-result delivery', async () => {
  let definition = await createTask(task([functionSpec(), functionSpec()], { schedule: { type: 'once', at: new Date(Date.now()+60_000).toISOString() }, loop: { maxIterations: 10, stopPath: 'count', stopValue: 4 }, result: { path: 'count', recipient: 'schedule-agent' } }));
  const due = Date.parse(definition.scheduling.nextRunAt);
  const initial = await tickScheduler(db, { now: due, execute: async id => {
    sqlite.prepare("UPDATE runs SET status='paused',locked_until=NULL,lock_token=NULL WHERE id=?").run(id);
    return getRun(id);
  } });
  const id = initial.started[0];
  definition = await save(await getTask(definition.id), { status: 'paused' });
  assert.deepEqual((await tickScheduler(db, { now: due+5_000 })).resumed, []);
  assert.deepEqual(await listCompletions('schedule-agent'), []);
  definition = await save(definition, { status: 'active' });
  assert.deepEqual((await tickScheduler(db, { now: due+10_000 })).resumed, [id]);
  const result = await getRunResult(id);
  assert.equal(result.status, 'success');
  assert.equal(result.output, 4);
  assert.equal((await getRun(id)).iteration, 2);
  assert.equal((await listCompletions('schedule-agent')).length, 1);
  assert.deepEqual((await tickScheduler(db, { now: due+20_000 })).started, []);
  assert.equal((await listRuns(definition.id)).length, 1);
});

test('inline Function execution is not stolen, and queued work blocks a due scheduled occurrence', async () => {
  const inlineTask = await createTask(task());
  const inline = createRun(inlineTask);
  await insertRun(inline);
  const ignored = await tickScheduler(db);
  assert.deepEqual(ignored.started, []);
  assert.deepEqual(ignored.resumed, []);
  assert.equal((await getRun(inline.id)).steps.length, 0);
  const scheduled = await createTask(task(undefined, { schedule: { type: 'interval', every: 1, unit: 'minutes' } }));
  const queued = await enqueueRun(scheduled);
  const due = Date.parse(scheduled.scheduling.nextRunAt);
  const first = await tickScheduler(db, { now: due });
  assert.deepEqual(first.started, [queued.id]);
  assert.equal((await listRuns(scheduled.id)).length, 1);
  assert.equal(Date.parse((await getTask(scheduled.id)).scheduling.nextRunAt), due);
  const second = await tickScheduler(db, { now: due+5_000 });
  assert.equal(second.started.length, 1);
  assert.equal((await listRuns(scheduled.id)).length, 2);
});

test('completion reconciliation recovers a final result missing its inbox entry without executing again', async () => {
  const definition = await createTask(task());
  const run = await enqueueRun(definition);
  await tickScheduler(db);
  sqlite.prepare('DELETE FROM run_completions WHERE run_id=?').run(run.id);
  const recovered = await tickScheduler(db);
  assert.deepEqual(recovered.started, []);
  assert.deepEqual(recovered.resumed, []);
  assert.equal((await listCompletions()).length, 1);
  assert.deepEqual((await getRunResult(run.id)).output, { count: 1 });
  assert.equal((await getRun(run.id)).steps.length, 1);
});
