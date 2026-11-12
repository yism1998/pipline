/** Scheduler behavior against the real SQL, store and execution engine. */
import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { createHarness, functionSpec } from './harness.mjs';

const harness = await createHarness({ scheduler: true });
const { sqlite, db, engine } = harness;
const { parseTask, createTask, updateTask, getTask, getRun, listRuns, startRun, cancelRun, functionExecutors, tickScheduler } = engine;

beforeEach(() => harness.reset());
after(() => harness.close());

function task(functions = [functionSpec()], extra = {}) {
  return parseTask({ name: '调度行为验证', status: 'active', functions, initialContext: {}, loop: { maxIterations: 1 }, ...extra });
}
async function createScheduled(schedule, extra = {}, functions = [functionSpec()]) {
  const saved = await createTask(task(functions, { schedule, ...extra }));
  return getTask(saved.id);
}
async function save(previous, changes) {
  return updateTask(parseTask({ ...changes, version: previous.version }, previous), previous.version);
}
function dueAt(definition) {
  assert.ok(definition.scheduling?.nextRunAt, 'an active scheduled Task must expose its next due time');
  return Date.parse(definition.scheduling.nextRunAt);
}
function onceAfter(milliseconds = 60_000) { return { type: 'once', at: new Date(Date.now() + milliseconds).toISOString() }; }
const everyMinute = { type: 'interval', every: 1, unit: 'minutes' };

// Use the persisted schedule and execution results instead of a fake timer or
// mock store. The injected tick timestamp only removes real waiting.
test('a future once schedule waits until due and executes only once, including after an ordinary save', async () => {
  let definition = await createScheduled(onceAfter());
  const due = dueAt(definition);
  const early = await tickScheduler(db, { now: due - 1 });
  assert.deepEqual(early.started, []);
  assert.equal((await listRuns(definition.id)).length, 0);
  assert.equal(dueAt(await getTask(definition.id)), due);

  const tick = await tickScheduler(db, { now: due });
  assert.equal(tick.started.length, 1);
  const run = await getRun(tick.started[0]);
  assert.equal(run.status, 'success');
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.scheduledFor, new Date(due).toISOString());
  assert.equal(run.context.count, 1);
  definition = await getTask(definition.id);
  assert.equal(definition.scheduling.completed, true);
  assert.equal(definition.scheduling.nextRunAt, null);
  assert.equal(definition.scheduling.lastRunId, run.id);
  assert.equal(Date.parse(definition.scheduling.lastRunAt), due);

  definition = await save(definition, { name: '只改名称' });
  assert.equal(definition.scheduling.completed, true);
  assert.deepEqual((await tickScheduler(db, { now: due + 86_400_000 })).started, []);
  assert.equal((await listRuns(definition.id)).length, 1);
});

test('interval schedules advance from the observed tick and equivalent-rule saves retain the next occurrence', async () => {
  let definition = await createScheduled({ type: 'interval', every: 2, unit: 'minutes' });
  const due = dueAt(definition);
  definition = await save(definition, { name: '更新其他字段', schedule: { type: 'interval', every: 2, unit: 'minutes' } });
  assert.equal(dueAt(definition), due);
  const tickAt = due + 23_000;
  const tick = await tickScheduler(db, { now: tickAt });
  assert.equal(tick.started.length, 1);
  const run = await getRun(tick.started[0]);
  assert.equal(run.scheduledFor, new Date(due).toISOString());
  definition = await getTask(definition.id);
  assert.equal(dueAt(definition), tickAt + 120_000);
  assert.equal(definition.scheduling.lastRunId, run.id);
  const next = dueAt(definition);
  definition = await save(definition, { description: '保存不会重置计时', schedule: structuredClone(definition.schedule) });
  assert.equal(dueAt(definition), next);
  assert.equal(definition.scheduling.lastRunId, run.id);
  assert.deepEqual((await tickScheduler(db, { now: next - 1 })).started, []);
  assert.equal((await tickScheduler(db, { now: next })).started.length, 1);
});

test('paused and draft Tasks disable scheduling, and re-enabling an interval begins a fresh period', async t => {
  for (const status of ['paused', 'draft']) {
    const definition = await createScheduled(everyMinute, { status });
    assert.equal(definition.scheduling.nextRunAt, null);
    assert.deepEqual((await tickScheduler(db, { now: Date.now() + 86_400_000 })).started, []);
    assert.equal((await listRuns(definition.id)).length, 0);
  }
  let definition = await createScheduled(everyMinute);
  const oldDue = dueAt(definition);
  definition = await save(definition, { status: 'paused' });
  assert.equal(definition.scheduling.nextRunAt, null);
  assert.deepEqual((await tickScheduler(db, { now: oldDue + 1 })).started, []);
  const resumedAt = oldDue + 120_000;
  t.mock.timers.enable({ apis: ['Date'], now: resumedAt });
  try { definition = await save(definition, { status: 'active' }); }
  finally { t.mock.timers.reset(); }
  assert.equal(dueAt(definition), resumedAt + 60_000);
  assert.deepEqual((await tickScheduler(db, { now: resumedAt })).started, []);
  assert.equal((await tickScheduler(db, { now: resumedAt + 60_000 })).started.length, 1);
});

test('a late restart coalesces missed interval occurrences and recovers a due once schedule once', async () => {
  const interval = await createScheduled(everyMinute);
  const once = await createScheduled(onceAfter(120_000));
  const intervalDue = dueAt(interval);
  const onceDue = dueAt(once);
  const restartedAt = Math.max(intervalDue, onceDue) + 30 * 86_400_000;
  const recovered = await tickScheduler(db, { now: restartedAt });
  assert.equal(recovered.started.length, 2);
  assert.equal((await listRuns(interval.id)).length, 1);
  assert.equal((await listRuns(once.id)).length, 1);
  assert.equal(dueAt(await getTask(interval.id)), restartedAt + 60_000);
  assert.equal((await getTask(once.id)).scheduling.completed, true);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.deepEqual((await tickScheduler(db, { now: restartedAt + attempt * 5_000 })).started, []);
  }
  assert.equal((await listRuns(interval.id)).length, 1);
  assert.equal((await listRuns(once.id)).length, 1);
});

test('concurrent ticks claim the same due occurrence at most once', async () => {
  const definition = await createScheduled(everyMinute);
  const due = dueAt(definition);
  const ticks = await Promise.all(Array.from({ length: 8 }, () => tickScheduler(db, { now: due })));
  assert.equal(ticks.flatMap(tick => tick.started).length, 1);
  const runs = await listRuns(definition.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'success');
  assert.equal(runs[0].context.count, 1);
  assert.equal(dueAt(await getTask(definition.id)), due + 60_000);
});

test('a busy Task does not overlap a running occurrence and retries its due schedule after the run ends', async () => {
  const originalFetch = globalThis.fetch;
  let releaseResponse;
  let announce;
  const entered = new Promise(resolve => { announce = resolve; });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    announce();
    return new Promise(resolve => { releaseResponse = () => resolve(Response.json({ context: { remoteDone: true } })); });
  };
  try {
    const definition = await createScheduled(everyMinute, {}, [functionSpec({ handler: 'code.remote', config: { endpoint: 'https://runner.example.com/schedule' } })]);
    const due = dueAt(definition);
    const pending = tickScheduler(db, { now: due });
    await entered;
    const busy = await tickScheduler(db, { now: due + 60_000 });
    assert.deepEqual(busy.started, []);
    assert.equal((await listRuns(definition.id)).length, 1);
    assert.equal(requests, 1);
    assert.equal(dueAt(await getTask(definition.id)), due + 60_000);
    releaseResponse();
    await pending;
    globalThis.fetch = async () => { requests++; return Response.json({ context: { remoteDone: true } }); };
    assert.equal((await tickScheduler(db, { now: due + 65_000 })).started.length, 1);
    assert.equal(requests, 2);
    assert.equal((await listRuns(definition.id)).length, 2);
  } finally { globalThis.fetch = originalFetch; releaseResponse?.(); }
});

test('a paused manual Run blocks a scheduled Run until it is cancelled', async () => {
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
    const definition = await createScheduled(everyMinute, {}, [functionSpec(), functionSpec()]);
    const manual = await startRun(definition);
    assert.equal(manual.status, 'paused');
    const due = dueAt(definition);
    const busy = await tickScheduler(db, { now: due });
    assert.deepEqual(busy.started, []);
    assert.deepEqual(busy.resumed, []);
    assert.equal((await listRuns(definition.id)).length, 1);
    assert.equal(dueAt(await getTask(definition.id)), due);
    await cancelRun(manual.id);
    functionExecutors['counter.increment'] = originalExecutor;
    const tick = await tickScheduler(db, { now: due + 5_000 });
    assert.equal(tick.started.length, 1);
    assert.equal((await getRun(manual.id)).status, 'cancelled');
    assert.equal((await getRun(tick.started[0])).status, 'success');
  } finally { Date.now = originalNow; functionExecutors['counter.increment'] = originalExecutor; }
});

test('scheduled Runs resume a saved Function checkpoint automatically without replaying completed Functions', async () => {
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
    const definition = await createScheduled(everyMinute, {}, [functionSpec(), functionSpec()]);
    const due = dueAt(definition);
    const first = await tickScheduler(db, { now: due });
    const paused = await getRun(first.started[0]);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.context.count, 1);
    assert.equal(paused.functionIndex, 1);
    functionExecutors['counter.increment'] = originalExecutor;
    const next = await tickScheduler(db, { now: due + 5_000 });
    assert.deepEqual(next.started, []);
    assert.deepEqual(next.resumed, [paused.id]);
    const resumed = await getRun(paused.id);
    assert.equal(resumed.status, 'success');
    assert.equal(resumed.context.count, 2);
    assert.equal(resumed.steps.length, 2);
    assert.equal((await listRuns(definition.id)).length, 1);
  } finally { Date.now = originalNow; functionExecutors['counter.increment'] = originalExecutor; }
});

test('automatic resume fails a scheduled Run with an unknown remote result without replaying its request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ context: { shouldNotAppear: true } }); };
  try {
    const remoteFunction = functionSpec({ handler: 'code.remote', config: { endpoint: 'https://runner.example.com/schedule' } });
    const definition = await createScheduled(everyMinute, {}, [remoteFunction]);
    const due = dueAt(definition);
    const first = await tickScheduler(db, { now: due, execute: async id => {
      // Simulate a worker dying after the external-operation marker was saved.
      sqlite.prepare("UPDATE runs SET status='paused', inflight_function=?, locked_until=NULL, lock_token=NULL WHERE id=?").run(`1:${remoteFunction.id}`, id);
      return getRun(id);
    } });
    const id = first.started[0];
    assert.equal((await getRun(id)).status, 'paused');
    const resumed = await tickScheduler(db, { now: due + 5_000 });
    assert.deepEqual(resumed.resumed, [id]);
    const failed = await getRun(id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /结果未知/);
    assert.equal(requests, 0);
    assert.equal(failed.context.shouldNotAppear, undefined);
    assert.deepEqual((await tickScheduler(db, { now: due + 10_000 })).resumed, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('each scheduled occurrence starts from isolated initial Context and keeps its own resources', async () => {
  const definition = await createScheduled(everyMinute, { initialContext: { count: 10, nested: { preserved: true } } }, [
    functionSpec(),
    functionSpec({ handler: 'context.merge', config: { values: { runId: '{{runId}}', nested: { seen: '{{context.count}}' } } } }),
    functionSpec({ handler: 'resource.add', config: { name: '执行结果', type: 'application/json', value: '{{context}}' } }),
  ]);
  const firstTick = await tickScheduler(db, { now: dueAt(definition) });
  const next = await getTask(definition.id);
  const secondTick = await tickScheduler(db, { now: dueAt(next) });
  const first = await getRun(firstTick.started[0]);
  const second = await getRun(secondTick.started[0]);
  for (const run of [first, second]) {
    assert.equal(run.status, 'success');
    assert.equal(run.context.count, 11);
    assert.deepEqual(run.context.nested, { preserved: true, seen: 11 });
    assert.equal(run.context.runId, run.id);
    assert.equal(run.resources.length, 1);
    assert.deepEqual(run.resources[0].value, run.context);
  }
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.resources[0].id, second.resources[0].id);
  assert.deepEqual((await getTask(definition.id)).initialContext, { count: 10, nested: { preserved: true } });
  assert.deepEqual((await getRun(first.id)).context, first.context);
});

test('schedule validation accepts explicit offsets and rejects ambiguous or invalid rules', () => {
  const future = Date.now() + 86_400_000;
  const offset = new Date(future).toISOString().replace('Z', '+00:00');
  assert.equal(task(undefined, { schedule: { type: 'once', at: offset } }).schedule.at, new Date(future).toISOString());
  for (const schedule of [
    { type: 'interval', every: 0, unit: 'minutes' },
    { type: 'interval', every: 1.5, unit: 'hours' },
    { type: 'interval', every: 366, unit: 'days' },
    { type: 'interval', every: 1, unit: 'seconds' },
    { type: 'once', at: '2030-01-01T10:00:00' },
    { type: 'once', at: new Date(Date.now() - 1_000).toISOString() },
    { type: 'cron', expression: '* * * * *' },
  ]) assert.throws(() => task(undefined, { schedule }));
  assert.deepEqual(task().schedule, { type: 'manual' });
});

test('a Task rule change, pause or deletion between selection and claim cannot start its obsolete occurrence', async () => {
  for (const change of ['rule', 'paused', 'deleted']) {
    const definition = await createScheduled(onceAfter());
    const due = dueAt(definition);
    let intercepted = false;
    const racingDb = {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.includes('SELECT s.*,t.data')) return statement;
        const wrapper = {
          bind(...args) { statement.bind(...args); return wrapper; },
          async all() {
            const selected = await statement.all();
            if (!intercepted) {
              intercepted = true;
              const current = await getTask(definition.id);
              if (change === 'rule') await save(current, { schedule: onceAfter(86_400_000) });
              else if (change === 'paused') await save(current, { status: 'paused' });
              else await engine.deleteTask(definition.id);
            }
            return selected;
          },
        };
        return wrapper;
      },
    };
    const tick = await tickScheduler(racingDb, { now: due });
    assert.equal(intercepted, true);
    assert.deepEqual(tick.started, [], `obsolete ${change} occurrence must not execute`);
    assert.equal((await listRuns(definition.id)).length, 0);
    if (change === 'rule') assert.ok(dueAt(await getTask(definition.id)) > due);
    else if (change === 'paused') assert.equal((await getTask(definition.id)).scheduling.nextRunAt, null);
    else await assert.rejects(getTask(definition.id), /不存在/);
  }
});

test('failure inside the claim-and-advance transaction rolls back the Run and retains a due once occurrence', async () => {
  const definition = await createScheduled(onceAfter());
  const due = dueAt(definition);
  const statements = new WeakMap();
  let injectFailure = true;
  const failingDb = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      statements.set(statement, sql);
      return statement;
    },
    async batch(batch) {
      if (injectFailure && statements.get(batch[0])?.includes('INSERT OR IGNORE INTO runs')) {
        injectFailure = false;
        // The heartbeat row already exists. This valid prepared statement fails
        // at execution, after claim INSERT, and must roll back that INSERT.
        return db.batch([batch[0], db.prepare("INSERT INTO scheduler_meta (id,last_heartbeat_at) VALUES ('local',NULL)")]);
      }
      return db.batch(batch);
    },
  };
  const failed = await tickScheduler(failingDb, { now: due });
  assert.deepEqual(failed.started, []);
  assert.equal(failed.errors.length, 1);
  assert.equal((await listRuns(definition.id)).length, 0);
  const stillDue = await getTask(definition.id);
  assert.equal(stillDue.scheduling.completed, false);
  assert.equal(dueAt(stillDue), due);
  const recovered = await tickScheduler(failingDb, { now: due + 5_000 });
  assert.equal(recovered.started.length, 1);
  assert.equal((await getRun(recovered.started[0])).status, 'success');
  assert.equal((await getTask(definition.id)).scheduling.completed, true);
  assert.deepEqual((await tickScheduler(failingDb, { now: due + 10_000 })).started, []);
  assert.equal((await listRuns(definition.id)).length, 1);
});

test('the scheduler reports its persisted heartbeat and becomes offline after 60 seconds without a tick', async () => {
  const now = Date.now();
  const before = await engine.getSchedulerStatus(db, now);
  assert.equal(before.enabled, false);
  assert.equal(before.lastHeartbeatAt, null);
  const tick = await tickScheduler(db, { now });
  assert.equal(tick.scheduler.enabled, true);
  assert.equal(tick.scheduler.lastHeartbeatAt, new Date(now).toISOString());
  assert.equal(tick.scheduler.pollIntervalMs, 5_000);
  assert.equal((await engine.getSchedulerStatus(db, now + 59_999)).enabled, true);
  assert.equal((await engine.getSchedulerStatus(db, now + 60_001)).enabled, false);
});

test('cancelling a paused scheduled once Run prevents automatic resume and does not create another occurrence', async () => {
  const definition = await createScheduled(onceAfter());
  const due = dueAt(definition);
  const tick = await tickScheduler(db, { now: due, execute: async id => {
    sqlite.prepare("UPDATE runs SET status='paused', locked_until=NULL, lock_token=NULL WHERE id=?").run(id);
    return getRun(id);
  } });
  const id = tick.started[0];
  assert.equal((await getRun(id)).status, 'paused');
  assert.equal((await cancelRun(id)).status, 'cancelled');
  const next = await tickScheduler(db, { now: due + 5_000 });
  assert.deepEqual(next.started, []);
  assert.deepEqual(next.resumed, []);
  assert.equal((await getRun(id)).status, 'cancelled');
  assert.equal((await listRuns(definition.id)).length, 1);
  assert.equal((await getTask(definition.id)).scheduling.completed, true);
});
