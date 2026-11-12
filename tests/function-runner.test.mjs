import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFunctionRunner, loadFunctionModules } from '../examples/remote-function-server.mjs';

const token = 'function-runner-test-secret';
const modules = await loadFunctionModules(fileURLToPath(new URL('../examples/function-modules.json', import.meta.url)));
const server = createFunctionRunner({ token, modules });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise(resolve => server.close(resolve)));
const call = (path, definitionKey, config) => fetch(`${origin}${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ [definitionKey]: { id: 'fn-test', name: 'Callable Function', handler: 'code.remote', config }, context: { name: ' Function ' }, resources: [], runId: 'fn-run', iteration: 1 }),
});

test('Function Runner exposes only the fn execution variable', async () => {
  const response = await call('/functions/code', 'fn', { code: 'return {context: {name: fn.name, hasOldVariable: typeof hook !== "undefined"}};' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { context: { name: 'Callable Function', hasOldVariable: false } });
});

test('registered modules execute and removed endpoints and payloads are rejected', async () => {
  const response = await call('/functions/code', 'fn', { entry: 'normalize' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).context.normalizedName, 'FUNCTION');
  assert.equal((await call('/hooks/code', 'fn', { entry: 'normalize' })).status, 404);
  assert.equal((await call('/functions/code', 'hook', { entry: 'normalize' })).status, 400);
});
