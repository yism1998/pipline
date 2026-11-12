/** Function-only APIs and Agent-created task composition with shared Context. */
import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness, functionSpec } from './harness.mjs';

const harness = await createHarness({ scheduler: true });
const envKey = `__functionApiEnv_${crypto.randomUUID().replaceAll('-', '')}`;
globalThis[envKey] = { DB: harness.db };
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  absWorkingDir: root,
  stdin: { contents: "export { handleApi } from './lib/server/api.ts'; export { POST as mcpPost } from './app/mcp/route.ts'; export { openapi } from './lib/server/openapi.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
  plugins: [{ name: 'function-test-env', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-env', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const env = globalThis[${JSON.stringify(envKey)}];`, loader: 'js' }));
  } }],
});
const { handleApi, mcpPost, openapi } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
beforeEach(() => harness.reset());
after(() => { harness.close(); delete globalThis[envKey]; });

async function api(path, method = 'GET', input) {
  const response = await handleApi(new Request(`http://127.0.0.1:5198/api${path}`, { method, ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }));
  return { status: response.status, value: await response.json() };
}
async function rpc(name, args = {}) {
  const response = await mcpPost(new Request('http://127.0.0.1:5198/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  return (await response.json()).result;
}
const input = (extra = {}) => ({ name: '可调用计数函数', type: 'code', handler: 'counter.increment', config: { key: 'count', amount: 2 }, ...extra });
const data = result => JSON.parse(result.content[0].text);

test('Function lifecycle is versioned and removed routes are unavailable', async () => {
  const created = await api('/functions', 'POST', input());
  assert.equal(created.status, 201);
  const fn = created.value;
  assert.equal((await api('/functions')).value.functions[0].id, fn.id);
  assert.equal((await api(`/functions/${fn.id}`)).value.name, fn.name);
  const copied = await api(`/functions/${fn.id}/instantiate`, 'POST', {});
  assert.equal(copied.status, 201);
  assert.notEqual(copied.value.id, fn.id);
  assert.deepEqual(copied.value.source, { id: fn.id, version: 1 });
  assert.equal((await api(`/functions/${fn.id}`, 'PATCH', { name: '新版', version: 1 })).value.version, 2);
  assert.equal((await api(`/functions/${fn.id}`, 'PATCH', { name: '过期', version: 1 })).status, 409);
  const bootstrap = (await api('/bootstrap')).value;
  assert.equal(bootstrap.functions[0].version, 2);
  assert.equal('hooks' in bootstrap, false);
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) assert.equal((await api('/hooks', method, method === 'GET' ? undefined : {})).status, 404);
  assert.equal((await api(`/hooks/${fn.id}`)).status, 404);
  assert.equal((await api('/seed', 'POST', {})).status, 404);
  assert.equal((await api(`/functions/${fn.id}`, 'DELETE')).status, 200);
  assert.equal((await api(`/functions/${fn.id}`)).status, 404);
});

test('direct Function calls persist real isolated Runs without creating Task or schedule records', async () => {
  const fn = (await api('/functions', 'POST', input())).value;
  const first = await api(`/functions/${fn.id}/call`, 'POST', { context: { count: 3, request: 'one' } });
  assert.equal(first.status, 201);
  assert.equal(first.value.kind, 'function');
  assert.equal(first.value.functionId, fn.id);
  assert.equal(first.value.functionVersion, 1);
  assert.equal(first.value.status, 'success');
  assert.equal(first.value.context.count, 5);
  assert.ok(first.value.steps[0].functionId);
  assert.equal(first.value.steps[0].functionName, fn.name);
  assert.equal(first.value.functionIndex, 1);
  assert.equal(first.value.definition.functions.length, 1);
  assert.equal('hookIndex' in first.value, false);
  assert.equal('hookId' in first.value.steps[0], false);
  const second = await api(`/functions/${fn.id}/call`, 'POST', { context: { count: 10 } });
  assert.equal(second.value.context.count, 12);
  assert.notEqual(second.value.id, first.value.id);
  assert.notEqual(second.value.taskId, first.value.taskId);
  assert.equal(second.value.context.request, undefined);
  assert.deepEqual((await api('/tasks')).value.tasks, []);
  assert.equal(harness.sqlite.prepare('SELECT count(*) AS n FROM task_schedules').get().n, 0);
  assert.equal((await api('/runs')).value.runs.length, 2);
  assert.equal((await api(`/runs/${first.value.id}`)).value.context.count, 5);
});

test('disabled and invalid direct calls fail before execution; business failure is recorded in Run', async () => {
  const disabled = (await api('/functions', 'POST', input({ enabled: false }))).value;
  assert.equal((await api(`/functions/${disabled.id}/call`, 'POST', {})).status, 409);
  assert.equal((await api('/runs')).value.runs.length, 0);
  const fn = (await api('/functions', 'POST', input())).value;
  assert.equal((await api(`/functions/${fn.id}/call`, 'POST', { context: [] })).status, 400);
  assert.equal((await api(`/functions/${fn.id}/call`, 'POST', { config: {} })).status, 400);
  assert.equal((await api('/functions/missing/call', 'POST', {})).status, 404);
  const failed = await api(`/functions/${fn.id}/call`, 'POST', { context: { count: 'not-a-number' } });
  assert.equal(failed.status, 201);
  assert.equal(failed.value.status, 'failed');
  assert.match(failed.value.error, /有效数字/);
  assert.equal(failed.value.steps[0].status, 'failed');
});

test('Task creation and updates require the functions protocol', async () => {
  const fn = functionSpec();
  const base = { name: '组合任务', status: 'active', loop: { maxIterations: 1 } };
  const created = await api('/tasks', 'POST', { ...base, functions: [fn] });
  assert.equal(created.status, 201);
  assert.equal((await api('/tasks', 'POST', { ...base, hooks: [fn] })).status, 400);
  assert.equal((await api('/tasks', 'POST', { ...base, functions: [fn], hooks: [fn] })).status, 400);
  assert.equal((await api(`/tasks/${created.value.id}`, 'PATCH', { version: 1, hooks: [fn] })).status, 400);
  assert.deepEqual(created.value.functions, [fn]);
  assert.equal('hooks' in created.value, false);
  const submitted = await api(`/tasks/${created.value.id}/run`, 'POST', {});
  assert.equal(submitted.status, 202);
  assert.equal(submitted.value.status, 'queued');
  assert.equal('context' in submitted.value, false);
  await harness.engine.tickScheduler();
  const run = (await api(`/runs/${submitted.value.runId}`)).value;
  assert.equal(run.context.count, 1);
  assert.equal(run.definition.functions[0].id, fn.id);
  assert.equal('hooks' in run.definition, false);
});

test('Agent-created Tasks combine Functions with nested shared Context across steps and Loop rounds', async () => {
  const functions = [
    functionSpec({ name: '准备客户', handler: 'context.set', config: { values: { customer: { name: 'Pipeline', token: 'shared-token' } } } }),
    functionSpec({ name: '累计轮次', handler: 'counter.increment', config: { key: 'count', amount: 1 } }),
    functionSpec({ name: '读取并派生', handler: 'context.merge', config: { values: { report: { customer: '{{context.customer.name}}', token: '{{context.customer.token}}', count: '{{context.count}}' } } } }),
    functionSpec({ name: '保存本轮', handler: 'resource.add', config: { name: 'report-{{iteration}}.json', type: 'application/json', value: '{{context}}' } }),
  ];
  const created = await rpc('task_create', { name: 'Agent 共享上下文组合', status: 'active', functions, initialContext: { count: 0, request: 'default' }, loop: { maxIterations: 2 } });
  assert.equal(created.isError, false);
  const task = data(created);
  assert.equal(task.functions.length, 4);
  const firstTicket = data(await rpc('run_start', { taskId: task.id, context: { request: 'first' } }));
  assert.equal(firstTicket.status, 'queued');
  assert.equal('context' in firstTicket, false);
  await harness.engine.tickScheduler();
  const first = data(await rpc('run_result', { runId: firstTicket.runId }));
  assert.equal(first.status, 'success');
  assert.equal(first.output.count, 2);
  assert.deepEqual(first.output.report, { customer: 'Pipeline', token: 'shared-token', count: 2 });
  assert.equal(first.resources.length, 2);
  assert.equal(first.resources[0].value.report.count, 1);
  assert.equal(first.resources[1].value.report.count, 2);
  assert.equal(first.resources[1].value.request, 'first');
  assert.equal('steps' in first, false);
  const secondTicket = data(await rpc('run_start', { taskId: task.id }));
  await harness.engine.tickScheduler();
  const second = data(await rpc('run_result', { runId: secondTicket.runId }));
  assert.equal(second.output.count, 2);
  assert.equal(second.output.request, 'default');
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.resources[0].value.request, 'default');
  assert.deepEqual((await api(`/tasks/${task.id}`)).value.initialContext, { count: 0, request: 'default' });
  assert.equal((await api(`/runs/${first.runId}`)).value.context.request, 'first');
});

test('function calls retain their executed Function version after library update or deletion', async () => {
  const fn = (await api('/functions', 'POST', input())).value;
  const run = (await api(`/functions/${fn.id}/call`, 'POST', { context: { count: 1 } })).value;
  await api(`/functions/${fn.id}`, 'PATCH', { version: 1, config: { key: 'count', amount: 20 } });
  const next = (await api(`/functions/${fn.id}/call`, 'POST', { context: { count: 1 } })).value;
  assert.equal(next.functionVersion, 2);
  assert.equal(next.context.count, 21);
  await api(`/functions/${fn.id}`, 'DELETE');
  const previous = (await api(`/runs/${run.id}`)).value;
  assert.equal(previous.functionVersion, 1);
  assert.equal(previous.context.count, 3);
  assert.equal(previous.definition.functions[0].config.amount, 2);
});

test('MCP exposes only Function tools and rejects removed tool names and arguments', async () => {
  const listing = await mcpPost(new Request('http://127.0.0.1:5198/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
  const tools = (await listing.json()).result.tools;
  for (const name of ['functions_list', 'function_get', 'function_create', 'function_update', 'function_delete', 'function_instantiate', 'function_call', 'task_create', 'workspace_get']) assert.ok(tools.some(tool => tool.name === name), name);
  assert.equal(tools.some(tool => /^hook/.test(tool.name)), false);
  assert.deepEqual(tools.find(tool => tool.name === 'task_create').inputSchema.required, ['name', 'functions']);
  const created = data(await rpc('function_create', input()));
  assert.equal(data(await rpc('functions_list')).functions[0].id, created.id);
  assert.equal((await rpc('hooks_list')).isError, true);
  assert.equal((await rpc('hook_get', { hookId: created.id })).isError, true);
  const result = await rpc('function_call', { functionId: created.id, context: { count: 8 } });
  assert.equal(result.isError, false);
  assert.equal(data(result).context.count, 10);
  assert.equal(data(result).kind, 'function');
  assert.equal((await rpc('function_call')).isError, true);
  assert.equal((await rpc('function_call', { functionId: created.id, context: null })).isError, true);
  assert.equal((await rpc('function_call', { hookId: created.id })).isError, true);
  const failed = await rpc('function_call', { functionId: created.id, context: { count: 'invalid' } });
  assert.equal(failed.isError, true);
  assert.equal(data(failed).status, 'failed');
  assert.ok(data(failed).id);
  const instance = data(await rpc('function_instantiate', { functionId: created.id }));
  const task = data(await rpc('task_create', { name: 'MCP 组合', functions: [instance], initialContext: {}, loop: { maxIterations: 1 } }));
  assert.equal(task.functions.length, 1);
  assert.equal((await rpc('task_create', { name: '无效组合', hooks: [instance] })).isError, true);
  assert.equal((await rpc('task_update', { taskId: task.id, version: 1, hooks: [instance] })).isError, true);
  assert.equal((await rpc('function_update', { functionId: created.id, version: 99, name: '冲突' })).isError, true);
});

test('OpenAPI documents Function-only Task composition and execution', () => {
  const doc = openapi('http://127.0.0.1:5198');
  assert.ok(doc.paths['/api/functions/{id}/call'].post.responses['201']);
  assert.ok(doc.paths['/api/workspace'].get.responses['200']);
  assert.ok(doc.components.schemas.WorkspaceInfo.properties.rootPath);
  assert.equal(doc.components.schemas.WorkspaceInfo.properties.definitionStorage.const, 'local-d1');
  assert.equal(Object.keys(doc.paths).some(path => path.includes('/hooks')), false);
  assert.equal(doc.paths['/api/seed'], undefined);
  assert.ok(doc.components.schemas.FunctionDefinitionInput);
  assert.deepEqual(doc.components.schemas.TaskInput.required, ['name', 'functions']);
  assert.equal(doc.components.schemas.TaskInput.properties.hooks, undefined);
  assert.ok(doc.components.schemas.TaskInput.properties.functions);
  assert.ok(doc.components.schemas.Run.properties.functionIndex);
  assert.ok(doc.components.schemas.Run.properties.functionVersion);
  assert.equal(doc.components.schemas.Run.properties.hookIndex, undefined);
  assert.equal(doc.components.schemas.FunctionGatewayRequest.properties.hook, undefined);
  assert.equal(Object.keys(doc.components.schemas).some(name => /^Hook/.test(name)), false);
});

test('a stale Task update cannot alter the schedule saved by the winning update', async () => {
  const { parseTask, createTask, updateTask, getTask } = harness.engine;
  const original = await createTask(parseTask({ name: '并发规则', status: 'active', functions: [functionSpec()], schedule: { type: 'interval', every: 1, unit: 'minutes' } }));
  const winning = parseTask({ version: 1, name: '已保存', schedule: { type: 'interval', every: 1, unit: 'hours' } }, original);
  const stale = parseTask({ version: 1, name: '过期修改', schedule: { type: 'interval', every: 1, unit: 'days' } }, original);
  await updateTask(winning, 1);
  const savedSchedule = harness.sqlite.prepare('SELECT * FROM task_schedules WHERE task_id=?').get(original.id);
  await assert.rejects(updateTask(stale, 1), error => error.status === 409);
  assert.deepEqual(harness.sqlite.prepare('SELECT * FROM task_schedules WHERE task_id=?').get(original.id), savedSchedule);
  assert.equal((await getTask(original.id)).name, '已保存');
  assert.deepEqual((await getTask(original.id)).schedule, { type: 'interval', every: 1, unit: 'hours' });
});

test('scheduler backfills a current Task without schedule metadata and executes its overdue once rule', async () => {
  const now = Date.now();
  const timestamp = new Date(now - 120_000).toISOString();
  const fn = functionSpec();
  const task = { id: 'scheduled-task', name: '定时任务', description: '', category: '通用任务', status: 'active', functions: [fn], initialContext: {}, schedule: { type: 'once', at: new Date(now - 60_000).toISOString() }, loop: { maxIterations: 1 }, version: 1, createdAt: timestamp, updatedAt: timestamp };
  harness.sqlite.prepare('INSERT INTO tasks (id,data,version,created_at,updated_at) VALUES (?,?,?,?,?)').run(task.id, JSON.stringify(task), 1, timestamp, timestamp);
  const result = await harness.engine.tickScheduler(harness.db, { now });
  assert.deepEqual(result.errors, []);
  assert.equal(result.started.length, 1);
  const run = await harness.engine.getRun(result.started[0]);
  assert.equal(run.status, 'success');
  assert.equal(run.context.count, 1);
  assert.deepEqual(run.definition.functions, [fn]);
  const schedule = harness.sqlite.prepare('SELECT * FROM task_schedules WHERE task_id=?').get(task.id);
  assert.equal(schedule.completed, 1);
  assert.equal(schedule.last_run_id, run.id);
  const rawTask = JSON.parse(harness.sqlite.prepare('SELECT data FROM tasks WHERE id=?').get(task.id).data);
  assert.deepEqual(rawTask.functions, [fn]);
  assert.equal('hooks' in rawTask, false);
  assert.equal(rawTask.version, 1);
});

test('workspace metadata is available through read-only HTTP and MCP queries', async () => {
  const response = await api('/workspace');
  assert.equal(response.status, 200);
  assert.equal(response.value.id, 'local');
  assert.equal(response.value.definitionStorage, 'local-d1');
  assert.equal(typeof response.value.configured, 'boolean');
  for (const field of ['rootPath', 'statePath', 'functionsPath', 'runsPath', 'registryPath']) {
    assert.ok(response.value[field] === null || typeof response.value[field] === 'string', field);
  }
  const queried = await rpc('workspace_get');
  assert.equal(queried.isError, false);
  assert.deepEqual(data(queried), response.value);
  assert.deepEqual((await api('/tasks')).value.tasks, []);
  assert.deepEqual((await api('/functions')).value.functions, []);
  assert.deepEqual((await api('/runs')).value.runs, []);
});
