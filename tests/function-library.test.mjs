/** Independent Function library, snapshot behavior, and its HTTP/MCP contracts. */
import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness, functionSpec } from './harness.mjs';

const harness = await createHarness();
const { engine } = harness;
const { parseFunctionDefinition, createFunction, listFunctions, getFunction, updateFunction, deleteFunction, instantiateFunction, parseTask, createTask, getTask, startRun, getRun } = engine;
const envKey = `__functionApiEnv_${crypto.randomUUID().replaceAll('-', '')}`;
globalThis[envKey] = { DB: harness.db };
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  absWorkingDir: root,
  stdin: { contents: "export { handleApi } from './lib/server/api.ts'; export { POST as mcpPost } from './app/mcp/route.ts'; export { openapi } from './lib/server/openapi.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
  plugins: [{ name: 'functionSpec-library-test-env', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-env', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const env = globalThis[${JSON.stringify(envKey)}];`, loader: 'js' }));
  } }],
});
const { handleApi, mcpPost, openapi } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
beforeEach(() => harness.reset());
after(() => { harness.close(); delete globalThis[envKey]; });

const definition = (extra = {}) => parseFunctionDefinition({ ...functionSpec(), description: '可复用计数 Function', ...extra });
async function api(path, method = 'GET', input) {
  const response = await handleApi(new Request(`http://127.0.0.1:5198/api${path}`, { method, ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }));
  return { status: response.status, value: await response.json() };
}
async function rpc(name, args = {}) {
  const response = await mcpPost(new Request('http://127.0.0.1:5198/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  return (await response.json()).result;
}

test('Function definitions persist independently without creating a Task or Run', async () => {
  const created = await createFunction(definition());
  assert.equal(created.version, 1);
  assert.equal(created.description, '可复用计数 Function');
  assert.equal((await listFunctions()).length, 1);
  assert.deepEqual(await getFunction(created.id), created);
  assert.deepEqual(await engine.listTasks(), []);
  assert.deepEqual(await engine.listRuns(), []);
  assert.equal(harness.sqlite.prepare('SELECT count(*) AS n FROM task_schedules').get().n, 0);
});

test('Function validation rejects invalid type/config/source and version conflicts', async () => {
  for (const input of [null, [], { ...functionSpec(), type: 'agent' }, { ...functionSpec(), config: [] }, { ...functionSpec(), source: { id: 'library', version: 0 } }, { ...functionSpec(), description: 'x'.repeat(2001) }]) {
    assert.throws(() => parseFunctionDefinition(input), error => error.status === 400);
  }
  assert.throws(() => parseFunctionDefinition({ ...functionSpec(), config: JSON.parse('{"constructor":1}') }), error => error.status === 400);
  const initial = await createFunction(definition());
  const first = parseFunctionDefinition({ name: '修改一', version: 1 }, initial);
  const stale = parseFunctionDefinition({ name: '过期修改', version: 1 }, initial);
  await updateFunction(first, initial.version);
  await assert.rejects(updateFunction(stale, initial.version), error => error.status === 409);
  const latest = await getFunction(initial.id);
  assert.equal(latest.version, 2);
  assert.equal(latest.name, '修改一');
  assert.equal(latest.createdAt, initial.createdAt);
  assert.throws(() => parseFunctionDefinition({ version: 1 }, latest), error => error.status === 409);
});

test('instantiation preserves source version and creates independent executable snapshots', async () => {
  const library = await createFunction(definition({ config: { key: 'count', amount: 2 } }));
  const first = await instantiateFunction(library.id);
  const second = await instantiateFunction(library.id);
  assert.notEqual(first.id, library.id);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.source, { id: library.id, version: 1 });
  for (const metadata of ['description', 'version', 'createdAt', 'updatedAt']) assert.equal(first[metadata], undefined);
  first.config.amount = 99;
  assert.equal(second.config.amount, 2);
  assert.equal((await getFunction(library.id)).config.amount, 2);
});

test('library changes and deletion do not change Task or historical Run snapshots', async () => {
  const library = await createFunction(definition({ config: { key: 'count', amount: 2 } }));
  const instance = await instantiateFunction(library.id);
  const task = await createTask(parseTask({ name: '快照任务', status: 'active', functions: [instance], initialContext: {}, loop: { maxIterations: 1 } }));
  const run = await startRun(task);
  assert.equal(run.context.count, 2);
  await updateFunction(parseFunctionDefinition({ config: { key: 'count', amount: 5 } }, library), library.version);
  assert.equal((await instantiateFunction(library.id)).source.version, 2);
  await deleteFunction(library.id);
  await assert.rejects(getFunction(library.id), error => error.status === 404);
  const savedTask = await getTask(task.id);
  assert.deepEqual(savedTask.functions, task.functions);
  assert.deepEqual((await getRun(run.id)).definition.functions, task.functions);
  const nextRun = await startRun(savedTask);
  assert.equal(nextRun.context.count, 2);
  assert.deepEqual(nextRun.definition.functions[0].source, { id: library.id, version: 1 });
});

test('HTTP Function CRUD, instantiate, bootstrap, and missing IDs honor the documented contract', async () => {
  const created = await api('/functions', 'POST', { name: '仅定义', type: 'code', handler: 'context.set', config: { values: { ready: true } } });
  assert.equal(created.status, 201);
  assert.equal(created.value.version, 1);
  assert.equal((await api('/functions')).value.functions.length, 1);
  const id = created.value.id;
  assert.equal((await api(`/functions/${id}`)).value.name, '仅定义');
  const copied = await api(`/functions/${id}/instantiate`, 'POST', {});
  assert.equal(copied.status, 201);
  assert.deepEqual(copied.value.source, { id, version: 1 });
  assert.equal((await api(`/functions/${id}/instantiate`, 'POST', { unexpected: true })).status, 400);
  assert.equal((await api(`/functions/${id}`, 'PATCH', { name: '已修改', version: 1 })).value.version, 2);
  assert.equal((await api(`/functions/${id}`, 'PATCH', { version: 1 })).status, 409);
  const bootstrap = (await api('/bootstrap')).value;
  assert.equal(bootstrap.functions.length, 1);
  assert.deepEqual(bootstrap.tasks, []);
  assert.deepEqual(bootstrap.runs, []);
  assert.equal((await api(`/functions/${id}`, 'DELETE')).status, 200);
  for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal((await api(`/functions/${id}`, method, method === 'PATCH' ? {} : undefined)).status, 404);
  assert.equal((await api(`/functions/${id}/instantiate`, 'POST', {})).status, 404);
});

test('MCP exposes Function lifecycle tools and delegates writes to the same versioned API', async () => {
  const listing = await mcpPost(new Request('http://127.0.0.1:5198/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
  const tools = (await listing.json()).result.tools;
  for (const name of ['functions_list', 'function_get', 'function_create', 'function_update', 'function_delete', 'function_instantiate']) assert.ok(tools.some(tool => tool.name === name), name);
  const createdResult = await rpc('function_create', { name: 'AI 定义', type: 'code', handler: 'context.set', config: { values: { by: 'ai' } } });
  assert.equal(createdResult.isError, false);
  const created = JSON.parse(createdResult.content[0].text);
  const result = await rpc('function_instantiate', { functionId: created.id });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text).source, { id: created.id, version: 1 });
  assert.equal((await rpc('function_get')).isError, true);
  assert.equal((await rpc('function_update', { functionId: created.id, version: 7, name: '冲突' })).isError, true);
  assert.equal((await rpc('function_delete', { functionId: created.id })).isError, false);
  assert.deepEqual(await engine.listTasks(), []);
  const doc = openapi('http://127.0.0.1:5198');
  assert.ok(doc.paths['/api/functions/{id}/instantiate'].post.responses['201']);
  assert.deepEqual(doc.components.schemas.FunctionDefinitionInput.required, ['name', 'type', 'handler', 'config']);
});
