import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunWorkspace, prepareWorkspace, resolveWorkspace, workspaceBindings } from '../scripts/workspace.mjs';
import { createFunctionRunner, loadFunctionModules } from '../examples/remote-function-server.mjs';

const temporary = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'pipeline-workspace-')); temporary.push(path); return path; };
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

test('workspace defaults and overrides resolve consistently against the application root', () => {
  const root = temp();
  const defaults = resolveWorkspace({ root, environment: {} });
  assert.equal(defaults.rootPath, join(root, '.pipeline'));
  assert.equal(defaults.registryPath, join(root, '.pipeline/functions/modules.json'));
  writeFileSync(join(root, '.dev.vars'), 'PIPELINE_WORKSPACE_ROOT="local data"\n');
  assert.equal(resolveWorkspace({ root, environment: {} }).rootPath, join(root, 'local data'));
  const override = resolveWorkspace({ root, environment: { PIPELINE_WORKSPACE_ROOT: 'explicit', FUNCTION_RUNNER_MODULES: 'modules/custom.json' } });
  assert.equal(override.rootPath, join(root, 'explicit'));
  assert.equal(override.registryPath, join(root, 'modules/custom.json'));
  assert.equal(workspaceBindings(override).PIPELINE_STATE_DIR, join(root, 'explicit/state'));
});

test('initialization preserves registered modules and Run directories are shared only within a Run', () => {
  const workspace = prepareWorkspace(resolveWorkspace({ root: temp(), environment: {} }));
  assert.deepEqual(JSON.parse(readFileSync(workspace.registryPath, 'utf8')), {});
  writeFileSync(workspace.registryPath, '{"custom":"./custom.mjs"}');
  prepareWorkspace(workspace);
  assert.equal(JSON.parse(readFileSync(workspace.registryPath, 'utf8')).custom, './custom.mjs');
  const first = prepareRunWorkspace(workspace, 'run-one');
  assert.deepEqual(first, prepareRunWorkspace(workspace, 'run-one'));
  assert.notEqual(first.rootPath, prepareRunWorkspace(workspace, 'run-two').rootPath);
  for (const id of ['../escape', '/absolute', '.', '', 'a/b', 'a\\b']) assert.throws(() => prepareRunWorkspace(workspace, id));
});

test('a Runner supplies its own workspace and files survive subsequent Function calls within the same Run', async () => {
  const workspace = prepareWorkspace(resolveWorkspace({ root: temp(), environment: {} }));
  writeFileSync(join(workspace.functionsPath, 'memo.mjs'), `
    import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export default async ({ context, workspace }) => {
      const path = join(workspace.workPath, 'memo.txt');
      if (context.text) await writeFile(path, context.text);
      const value = await readFile(path, 'utf8').catch(() => null);
      return {context: {value, directory: workspace.rootPath}};
    };
  `);
  writeFileSync(workspace.registryPath, '{"memo":"./memo.mjs"}');
  const modules = await loadFunctionModules(workspace.registryPath);
  const server = createFunctionRunner({ token: 'workspace-test-token', modules, workspace });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (runId, context) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/functions/code`, {
      method: 'POST', headers: { Authorization: 'Bearer workspace-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, iteration: 1, context, resources: [], fn: { id: 'memo', handler: 'code.remote', config: { entry: 'memo' } }, workspace: { workPath: '/ignored-client-path' } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const first = await call('run-one', { text: 'shared by functions' });
    assert.equal(first.context.value, 'shared by functions');
    const second = await call('run-one', {});
    assert.equal(second.context.value, 'shared by functions');
    assert.equal(second.context.directory, join(workspace.runsPath, 'run-one'));
    const isolated = await call('run-two', {});
    assert.equal(isolated.context.value, null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
