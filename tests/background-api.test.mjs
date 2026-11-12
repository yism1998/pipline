/** Agent-facing dispatch, final-only waiting and durable result inbox contracts. */
import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness, functionSpec } from './harness.mjs';

const harness = await createHarness({ scheduler: true });
const envKey = `__backgroundApiEnv_${crypto.randomUUID().replaceAll('-', '')}`;
globalThis[envKey] = { DB: harness.db };
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  absWorkingDir: root,
  stdin: { contents: "export { handleApi } from './lib/server/api.ts'; export { POST as mcpPost } from './app/mcp/route.ts'; export { openapi } from './lib/server/openapi.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22',
  plugins: [{ name: 'background-api-env', setup(builder) {
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
const data = result => JSON.parse(result.content[0].text);
async function task(extra = {}) {
  const response = await api('/tasks', 'POST', {
    name: '只提交目标，平台处理过程', status: 'active', initialContext: { privateScratch: 'internal' },
    functions: [
      functionSpec({ handler: 'context.set', config: { values: { topic: 'Pipeline' } } }),
      functionSpec({ handler: 'context.merge', config: { values: { report: { title: '{{context.topic}}', request: '{{context.request}}' } } } }),
      functionSpec({ handler: 'resource.add', config: { name: 'report.json', type: 'json', value: '{{context.report}}' } }),
    ],
    loop: { maxIterations: 1 }, result: { path: 'report', recipient: 'writer' }, ...extra,
  });
  assert.equal(response.status, 201, JSON.stringify(response.value));
  return response.value;
}
const tick = () => harness.engine.tickScheduler(harness.db);
async function concurrentTick() {
  await new Promise(resolve => setTimeout(resolve, 15));
  return tick();
}
function assertFinalOnly(result) {
  for (const field of ['context', 'steps', 'logs', 'definition', 'functionIndex', 'iteration']) assert.equal(field in result, false, field);
}

test('dispatch returns a durable queue ticket without running or exposing intermediate Function state', async () => {
  const definition = await task();
  const submitted = await api(`/tasks/${definition.id}/run`, 'POST', { context: { request: 'one' }, recipient: 'agent-one' });
  assert.equal(submitted.status, 202);
  assert.deepEqual(Object.keys(submitted.value).sort(), ['resultUrl', 'runId', 'status', 'taskId']);
  assert.equal(submitted.value.status, 'queued');
  const stored = await harness.engine.getRun(submitted.value.runId);
  assert.equal(stored.execution, 'background');
  assert.equal(stored.recipient, 'agent-one');
  assert.deepEqual(stored.steps, []);
  assert.equal(stored.context.topic, undefined);
  assert.equal((await api(`/tasks/${definition.id}/run`, 'POST', {})).status, 409);
  assert.deepEqual((await api('/completions?recipient=agent-one')).value.completions, []);
});

test('bounded waiting returns only a pending ticket and never drives the execution itself', async () => {
  const definition = await task();
  const submitted = await api(`/tasks/${definition.id}/execute`, 'POST', { context: { request: 'pending' }, waitSeconds: 0.01 });
  assert.equal(submitted.status, 202);
  assert.equal(submitted.value.ready, false);
  assert.equal(submitted.value.status, 'queued');
  assertFinalOnly(submitted.value);
  const pending = await api(`/runs/${submitted.value.runId}/result?waitSeconds=0.01`);
  assert.equal(pending.status, 202);
  assertFinalOnly(pending.value);
  assert.deepEqual((await harness.engine.getRun(submitted.value.runId)).steps, []);
});

test('execute waits for the independent worker and delivers only the projected final output', async () => {
  const definition = await task();
  const worker = concurrentTick();
  const finished = await api(`/tasks/${definition.id}/execute`, 'POST', { context: { request: 'ready' }, waitSeconds: 1 });
  await worker;
  assert.equal(finished.status, 200);
  assert.equal(finished.value.status, 'success');
  assert.deepEqual(finished.value.output, { title: 'Pipeline', request: 'ready' });
  assert.equal(finished.value.recipient, 'writer');
  assert.equal(finished.value.resources[0].value.request, 'ready');
  assertFinalOnly(finished.value);
  assert.deepEqual((await api(`/runs/${finished.value.runId}/result`)).value, finished.value);
});

test('leaving a waiting request does not cancel the durable Task execution', async () => {
  const definition=await task();
  const controller=new AbortController();
  const waiting=handleApi(new Request(`http://127.0.0.1:5198/api/tasks/${definition.id}/execute`, {
    method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,
    body:JSON.stringify({context:{request:'disconnected'},waitSeconds:1}),
  }));
  const timer=setTimeout(()=>controller.abort(),15);
  let response;
  try { response=await waiting; } finally { clearTimeout(timer); }
  assert.equal(response.status,202);
  const ticket=await response.json();
  assert.equal((await harness.engine.getRun(ticket.runId)).status,'queued');
  await tick();
  const result=(await api(`/runs/${ticket.runId}/result`)).value;
  assert.equal(result.status,'success');
  assert.equal(result.output.request,'disconnected');
});

test('MCP task_execute, run_start, run_wait and run_result expose tickets or final results consistently', async () => {
  const definition = await task();
  const submitted = await rpc('run_start', { taskId: definition.id, context: { request: 'mcp' } });
  assert.equal(submitted.isError, false);
  const ticket = data(submitted);
  assert.equal(ticket.status, 'queued');
  assert.equal(data(await rpc('run_result', { runId: ticket.runId })).ready, false);
  const worker = concurrentTick();
  const waited = await rpc('run_wait', { runId: ticket.runId, waitSeconds: 1 });
  await worker;
  assert.equal(waited.isError, false);
  assert.deepEqual(data(waited).output, { title: 'Pipeline', request: 'mcp' });
  assertFinalOnly(data(waited));
  const workerAgain = concurrentTick();
  const executed = await rpc('task_execute', { taskId: definition.id, context: { request: 'second' }, waitSeconds: 1 });
  await workerAgain;
  assert.equal(executed.isError, false);
  assert.equal(data(executed).output.request, 'second');
});

test('final failure and cancellation are delivered as terminal results and MCP tool errors', async () => {
  const definition = await task({ functions: [functionSpec({ handler: 'context.set', config: { values: { draft: true } } })] });
  const ticket = (await api(`/tasks/${definition.id}/run`, 'POST', {})).value;
  await tick();
  const failed = await api(`/runs/${ticket.runId}/result`);
  assert.equal(failed.status, 200);
  assert.equal(failed.value.status, 'failed');
  assert.match(failed.value.error, /report/);
  assertFinalOnly(failed.value);
  assert.equal((await rpc('run_result', { runId: ticket.runId })).isError, true);
  const next = (await api(`/tasks/${definition.id}/run`, 'POST', {})).value;
  assert.equal((await api(`/runs/${next.runId}/cancel`, 'POST', {})).value.status, 'cancelled');
  const cancelled = await rpc('run_wait', { runId: next.runId, waitSeconds: 0 });
  assert.equal(cancelled.isError, true);
  assert.equal(data(cancelled).status, 'cancelled');
});

test('recipient inboxes contain only final results and acknowledgement is scoped and idempotent', async () => {
  const definition = await task();
  const queued = (await api(`/tasks/${definition.id}/run`, 'POST', { recipient: 'specific-agent', context: { request: 'inbox' } })).value;
  assert.deepEqual((await api('/completions?recipient=specific-agent')).value.completions, []);
  await tick();
  assert.deepEqual((await api('/completions')).value.completions, []);
  const inbox = data(await rpc('completions_list', { recipient: 'specific-agent', limit: 10 }));
  assert.equal(inbox.completions.length, 1);
  assert.equal(inbox.completions[0].runId, queued.runId);
  assertFinalOnly(inbox.completions[0].result);
  assert.equal((await api(`/completions/${queued.runId}/ack`, 'POST', {})).status, 404);
  for (let i = 0; i < 2; i++) assert.equal((await rpc('completion_ack', { runId: queued.runId, recipient: 'specific-agent' })).isError, false);
  assert.deepEqual((await api('/completions?recipient=specific-agent')).value.completions, []);
  assert.equal((await api(`/runs/${queued.runId}/result`)).value.status, 'success');
});

test('inbox reconciliation repairs an interrupted delivery write without re-executing Functions', async () => {
  const definition = await task();
  const ticket = (await api(`/tasks/${definition.id}/run`, 'POST', {})).value;
  await tick();
  const before = await harness.engine.getRun(ticket.runId);
  harness.sqlite.prepare('DELETE FROM run_completions WHERE run_id=?').run(ticket.runId);
  const repaired = (await api('/completions?recipient=writer')).value.completions;
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].runId, ticket.runId);
  assert.deepEqual((await harness.engine.getRun(ticket.runId)).steps, before.steps);
  assert.equal((await api('/completions?recipient=writer')).value.completions.length, 1);
});

test('dispatch, waiting, recipients, result configuration and inbox parameters are validated', async () => {
  const definition = await task();
  for (const input of [{ context: [] }, { context: null }, { recipient: null }, { recipient: '' }, { recipient: 'x'.repeat(101) }, { config: {} }, { waitSeconds: 1 }]) assert.equal((await api(`/tasks/${definition.id}/run`, 'POST', input)).status, 400);
  for (const waitSeconds of [-1, 26, '1', null]) assert.equal((await api(`/tasks/${definition.id}/execute`, 'POST', { waitSeconds })).status, 400);
  for (const result of [{ path: 'constructor.x' }, { path: '' }, { recipient: '' }, { path: 'x', unknown: true }]) assert.equal((await api('/tasks', 'POST', { name: 'bad result', functions: [functionSpec()], result })).status, 400);
  for (const query of ['limit=0', 'limit=101', 'limit=1.1', 'recipient=', 'unexpected=x']) assert.equal((await api('/completions?'+query)).status, 400);
  assert.equal((await rpc('completions_list', { recipient: null })).isError, true);
  assert.equal((await rpc('run_wait', { runId: 'missing', waitSeconds: '1' })).isError, true);
  assert.equal((await api('/runs/missing/result')).status, 404);
  const queued=(await api(`/tasks/${definition.id}/run`,'POST',{})).value;
  assert.equal((await api(`/runs/${queued.runId}/result?waitSeconds=`)).status,400);
});

test('OpenAPI and MCP retain schedules and stop conditions alongside managed execution contracts', async () => {
  const doc = openapi('http://127.0.0.1:5198');
  assert.ok(doc.paths['/api/tasks/{id}/run'].post.responses['202']);
  assert.ok(doc.paths['/api/tasks/{id}/execute'].post.responses['200']);
  assert.ok(doc.paths['/api/runs/{id}/result'].get.responses['202']);
  assert.ok(doc.paths['/api/completions/{id}/ack']);
  assert.ok(doc.components.schemas.TaskInput.properties.result);
  assert.ok(doc.components.schemas.Loop.properties.stopPath);
  assert.ok(doc.components.schemas.ScheduleRule.oneOf.some(rule => rule.properties.type.const === 'interval'));
  assert.ok(doc.components.schemas.Run.properties.status.enum.includes('queued'));
  const response = await mcpPost(new Request('http://127.0.0.1:5198/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
  const tools = (await response.json()).result.tools;
  for (const name of ['task_execute', 'run_start', 'run_result', 'run_wait', 'completions_list', 'completion_ack', 'scheduler_status']) assert.ok(tools.some(tool => tool.name === name));
});
