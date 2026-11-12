/** One-time schema/data migration coverage; runtime exposes only Function fields. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const oldEndpoint = 'http://127.0.0.1:8789/hooks/code';
const newEndpoint = 'http://127.0.0.1:8789/functions/code';
const at = '2026-11-12T01:00:00.000Z';
const source = name => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of ['0000_redundant_onslaught.sql', '0001_illegal_ben_urich.sql', '0002_windy_plazm.sql']) db.exec(source(file));
  const oldFunction = {
    id: 'fn-old', name: 'Existing function', type: 'code', enabled: true,
    handler: 'code.remote', config: { endpoint: oldEndpoint, entry: 'normalize' },
    retries: 0, onError: 'stop', description: 'preserve metadata', version: 3,
    createdAt: at, updatedAt: at,
  };
  const currentFunction = { ...structuredClone(oldFunction), id: 'fn-current', config: { endpoint: newEndpoint, entry: 'normalize' } };
  const externalFunction = { ...structuredClone(oldFunction), id: 'fn-external', config: { endpoint: 'https://runner.example.com/hooks/code', entry: 'normalize' } };
  const functions = [oldFunction, currentFunction, externalFunction];
  for (const fn of functions) db.prepare('INSERT INTO hooks (id,data,version,created_at,updated_at) VALUES (?,?,?,?,?)').run(fn.id, JSON.stringify(fn), fn.version, fn.createdAt, fn.updatedAt);
  const oldTask = {
    id: 'task-old', name: 'Agent task', description: 'keep task data', category: 'tests', status: 'active',
    hooks: [oldFunction, externalFunction], initialContext: { inputs: [1, true, null], hookIndex: 'business data' },
    schedule: { type: 'interval', every: 1, unit: 'hours' }, loop: { maxIterations: 3 },
    version: 7, createdAt: at, updatedAt: at,
  };
  const currentTask = { ...structuredClone(oldTask), id: 'task-current', functions: [currentFunction] };
  delete currentTask.hooks;
  const mixedTask = { ...structuredClone(currentTask), id: 'task-mixed', hooks: [oldFunction] };
  const tasks = [oldTask, currentTask, mixedTask];
  for (const task of tasks) db.prepare('INSERT INTO tasks (id,data,version,created_at,updated_at) VALUES (?,?,?,?,?)').run(task.id, JSON.stringify(task), task.version, task.createdAt, task.updatedAt);
  db.prepare('INSERT INTO task_schedules (task_id,rule_key,generation,revision,task_version,next_run_at,last_run_at,last_run_id,completed,error) VALUES (?,?,?,?,?,?,?,?,?,?)').run(oldTask.id, 'interval:1:hours', 'schedule-generation', 9, 7, at, at, 'previous-run', 0, null);
  const schedule = { ...db.prepare('SELECT * FROM task_schedules').get() };
  const context = { report: { title: 'keep report', rows: [1, null, false] }, hooks: ['business data'], hookId: 'not metadata' };
  const steps = [
    { hookId: 'fn-old', hookName: 'Legacy step', iteration: 1, status: 'success', durationMs: 11, attempt: 1, at },
    { functionId: 'fn-current', functionName: 'Current step', iteration: 1, status: 'failed', durationMs: 12, attempt: 2, error: 'keep error', at },
    { functionId: 'fn-current', functionName: 'Preferred step', hookId: 'stale-id', hookName: 'stale name', iteration: 2, status: 'skipped', durationMs: 0, attempt: 0, at },
  ];
  const resources = [
    { id: 'res-old', hookId: 'fn-old', name: 'old.json', type: 'json', value: { hookId: 'business value', values: [1, true, null] }, iteration: 1, createdAt: at },
    { id: 'res-current', functionId: 'fn-current', name: 'current.txt', type: 'text', value: 'retained text', iteration: 1, createdAt: at },
    { id: 'res-mixed', functionId: 'fn-current', hookId: 'stale-id', name: 'mixed.json', type: 'json', value: { nested: { hookIndex: 42 } }, iteration: 2, createdAt: at },
  ];
  const logs = [
    { id: 'log-run', level: 'info', message: 'Run log with no function', iteration: 1, at },
    { id: 'log-old', hookId: 'fn-old', level: 'info', message: 'Legacy log', iteration: 1, at },
    { id: 'log-current', functionId: 'fn-current', level: 'warn', message: 'Current log', iteration: 1, at },
    { id: 'log-mixed', functionId: 'fn-current', hookId: 'stale-id', level: 'error', message: 'Preferred log', iteration: 2, at },
  ];
  const runs = [];
  for (const status of ['success', 'failed', 'cancelled', 'running', 'paused']) {
    // Cancellation changes the status column without rewriting the last saved JSON.
    const run = {
      id: `run-${status}`, taskId: oldTask.id, taskName: oldTask.name, taskVersion: 7,
      status: status === 'cancelled' ? 'running' : status, definition: oldTask,
      context, steps, resources, logs, iteration: 2, hookIndex: 1, startedAt: at, durationMs: 50,
      ...(status === 'failed' ? { error: 'Original failure' } : {}),
      ...(['success', 'failed'].includes(status) ? { finishedAt: at } : {}),
    };
    const pending = ['running', 'paused'].includes(status);
    const row = { id: run.id, task_id: oldTask.id, status, data: JSON.stringify(run), trigger_key: `trigger-${status}`, lock_token: pending ? 'lease-token' : null, locked_until: pending ? 123456 : null, cancelled_at: status === 'cancelled' ? at : null, inflight_hook: pending ? '2:fn-old' : null, created_at: at, updated_at: at };
    db.prepare('INSERT INTO runs (id,task_id,status,data,trigger_key,lock_token,locked_until,cancelled_at,inflight_hook,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
    runs.push({ row, data: run });
  }
  const canonicalRun = {
    id: 'run-current', taskId: 'function-call:current', taskName: 'Current function call', taskVersion: 3,
    status: 'success', definition: currentTask, context, steps: [], resources: [], logs: [],
    iteration: 1, functionIndex: 1, kind: 'function', functionId: currentFunction.id,
    functionVersion: 3, startedAt: at, finishedAt: at, durationMs: 10,
  };
  db.prepare('INSERT INTO runs (id,task_id,status,data,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(canonicalRun.id, canonicalRun.taskId, canonicalRun.status, JSON.stringify(canonicalRun), at, at);
  db.exec(source('0003_function_only.sql'));
  return { db, functions, tasks, runs, canonicalRun, context, steps, resources, logs, schedule };
}

test('one-time migration renames storage and preserves definitions, task data and schedule state', t => {
  const { db, functions, tasks, schedule } = fixture(t);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(tables.includes('functions'));
  assert.ok(!tables.includes('hooks'));
  const columns = db.prepare('PRAGMA table_info(runs)').all().map(row => row.name);
  assert.ok(columns.includes('inflight_function'));
  assert.ok(!columns.includes('inflight_hook'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM functions').get().count, functions.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, tasks.length);
  for (const original of functions) {
    const row = db.prepare('SELECT * FROM functions WHERE id=?').get(original.id);
    const actual = JSON.parse(row.data);
    const expected = structuredClone(original);
    if (expected.config.endpoint === oldEndpoint) expected.config.endpoint = newEndpoint;
    assert.deepEqual(actual, expected);
    assert.deepEqual({ id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at }, { id: original.id, version: original.version, created_at: original.createdAt, updated_at: original.updatedAt });
  }
  for (const original of tasks) {
    const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(original.id);
    const actual = JSON.parse(row.data);
    assert.equal('hooks' in actual, false);
    assert.deepEqual(actual.initialContext, original.initialContext);
    assert.equal(actual.version, original.version);
    assert.equal(row.version, original.version);
    assert.equal(actual.createdAt, original.createdAt);
    assert.equal(actual.updatedAt, original.updatedAt);
    const expected = structuredClone(original.functions ?? original.hooks);
    for (const fn of expected) if (fn.config.endpoint === oldEndpoint) fn.config.endpoint = newEndpoint;
    assert.deepEqual(actual.functions, expected);
    const rest = { ...actual };
    delete rest.functions;
    const expectedRest = { ...original };
    delete expectedRest.functions;
    delete expectedRest.hooks;
    assert.deepEqual(rest, expectedRest);
  }
  assert.deepEqual({ ...db.prepare('SELECT * FROM task_schedules').get() }, schedule);
});

test('Run state and history survive migration; only pending snapshots change their local Runner address', t => {
  const { db, runs, canonicalRun } = fixture(t);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, runs.length + 1);
  for (const { row: originalRow, data: original } of runs) {
    const row = { ...db.prepare('SELECT * FROM runs WHERE id=?').get(original.id) };
    const actual = JSON.parse(row.data);
    const expectedColumns = { ...originalRow, inflight_function: originalRow.inflight_hook };
    delete expectedColumns.data;
    delete expectedColumns.inflight_hook;
    const actualColumns = { ...row };
    delete actualColumns.data;
    assert.deepEqual(actualColumns, expectedColumns);
    assert.equal(actual.status, original.status);
    assert.equal(actual.taskVersion, original.taskVersion);
    assert.equal(actual.startedAt, original.startedAt);
    assert.equal(actual.finishedAt, original.finishedAt);
    assert.equal(actual.error, original.error);
    assert.equal(actual.durationMs, original.durationMs);
    assert.equal(actual.iteration, original.iteration);
    assert.equal(actual.functionIndex, original.hookIndex);
    assert.equal(actual.kind, 'task');
    assert.equal('hookIndex' in actual, false);
    assert.equal('hooks' in actual.definition, false);
    const expectedEndpoint = ['running', 'paused'].includes(row.status) ? newEndpoint : oldEndpoint;
    assert.equal(actual.definition.functions[0].config.endpoint, expectedEndpoint);
    assert.equal(actual.definition.functions[1].config.endpoint, 'https://runner.example.com/hooks/code');
  }
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM runs WHERE id=?').get(canonicalRun.id).data), canonicalRun);
});

test('legacy, canonical and mixed step/resource/log metadata migrate without changing business data', t => {
  const { db, context, steps, resources, logs } = fixture(t);
  const actual = JSON.parse(db.prepare("SELECT data FROM runs WHERE id='run-success'").get().data);
  assert.deepEqual(actual.context, context);
  assert.deepEqual(actual.steps, [
    { ...steps[0], functionId: 'fn-old', functionName: 'Legacy step', hookId: undefined, hookName: undefined },
    steps[1],
    { ...steps[2], hookId: undefined, hookName: undefined },
  ].map(value => JSON.parse(JSON.stringify(value))));
  assert.deepEqual(actual.resources, [
    { ...resources[0], functionId: 'fn-old', hookId: undefined },
    resources[1],
    { ...resources[2], hookId: undefined },
  ].map(value => JSON.parse(JSON.stringify(value))));
  assert.deepEqual(actual.logs, [
    logs[0], { ...logs[1], functionId: 'fn-old', hookId: undefined }, logs[2], { ...logs[3], hookId: undefined },
  ].map(value => JSON.parse(JSON.stringify(value))));
});
