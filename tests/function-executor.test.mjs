import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFunctionRunner, loadFunctionModules } from '../examples/remote-function-server.mjs';
import { createHarness, functionSpec } from './harness.mjs';

const harness = await createHarness();
const { runnerEndpoint, executeFunction } = harness.engine;
const token = 'local-runner-test-token-only';
const modules = await loadFunctionModules(fileURLToPath(new URL('../examples/function-modules.json', import.meta.url)));
const server = createFunctionRunner({ token, modules });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const endpoint = `${origin}/functions/code`;
const payload = config => ({ fn: functionSpec({ handler: 'code.remote', config }), context: { name: ' Pipeline ' }, resources: [], runId: 'runner-test', iteration: 1 });
const post = (config, authorization = `Bearer ${token}`) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(payload(config)) });
after(async () => { await new Promise(resolve => server.close(resolve)); harness.close(); });

test('only an explicitly allowed exact loopback origin can bypass public HTTPS validation', () => {
  assert.equal(runnerEndpoint(endpoint, origin).href, endpoint);
  assert.equal(runnerEndpoint('https://runner.example.com/functions', origin).protocol, 'https:');
  for (const value of [endpoint, 'http://192.168.1.1:8789/functions', 'http://localhost:8789/functions']) assert.throws(() => runnerEndpoint(value));
  for (const value of ['http://127.0.0.1:1/functions', 'http://localhost:8789/functions', 'http://user:pass@127.0.0.1:8789/functions', `${endpoint}#fragment`]) assert.throws(() => runnerEndpoint(value, origin));
  for (const allowed of ['https://127.0.0.1', 'http://192.168.1.2', 'http://127.0.0.1/path', `${origin}?x=1`, `http://user@127.0.0.1`]) assert.throws(() => runnerEndpoint(endpoint, allowed));
});

test('authenticated inline code executes with Context and returns a patch', async () => {
  const response = await post({ code: 'return { context: { greeting: context.name.trim() }, stop: false };' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { context: { greeting: 'Pipeline' }, stop: false });
  assert.equal((await post({ code: 'return {};' }, 'Bearer wrong-token')).status, 401);
});

test('a registered entry executes the bound file and unregistered paths cannot execute', async () => {
  const response = await post({ entry: 'normalize' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    context: { normalizedName: 'PIPELINE' },
    resources: [{ name: 'normalized-1.json', type: 'application/json', value: { name: 'Pipeline' } }],
  });
  for (const config of [{ entry: '../functions/normalize.mjs' }, { entry: 'missing' }, { entry: 'normalize', code: 'return {}' }, {}, { entry: 1 }, { code: '' }]) {
    assert.equal((await post(config)).status, 400);
  }
});

test('the actual Function executor sends the registered entry and server-side token to a local Runner', async () => {
  const definition = functionSpec({ handler: 'code.remote', config: { endpoint, entry: 'normalize', secretEnv: 'PIPELINE_RUNNER_TOKEN' } });
  const result = await executeFunction(definition, { runId: 'integration', iteration: 2, context: { name: ' Context ' }, resources: [], secrets: name => ({ PIPELINE_LOCAL_RUNNER_ORIGIN: origin, PIPELINE_RUNNER_TOKEN: token })[name] });
  assert.equal(result.context.normalizedName, 'CONTEXT');
  assert.equal(result.resources[0].name, 'normalized-2.json');
});

test('an infinite inline loop terminates and the Runner still accepts a subsequent call', async () => {
  const response = await post({ code: 'while (true) {}' });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /timed out/);
  assert.equal((await post({ entry: 'normalize' })).status, 200);
});
