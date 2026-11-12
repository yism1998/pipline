import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** Resolve against the application directory, never a caller's incidental cwd. */
export function resolveWorkspace({ root = projectRoot, environment = process.env } = {}) {
  const envFile = join(root, '.dev.vars');
  const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const rootPath = resolve(root, environment.PIPELINE_WORKSPACE_ROOT || local.PIPELINE_WORKSPACE_ROOT || '.pipeline');
  const functionsPath = join(rootPath, 'functions');
  const registry = environment.FUNCTION_RUNNER_MODULES || local.FUNCTION_RUNNER_MODULES;
  return {
    id: 'local', configured: true, definitionStorage: 'local-d1', rootPath,
    statePath: join(rootPath, 'state'), functionsPath, runsPath: join(rootPath, 'runs'),
    registryPath: registry ? resolve(root, registry) : join(functionsPath, 'modules.json'),
  };
}

export function prepareWorkspace(workspace) {
  for (const directory of [workspace.rootPath, workspace.statePath, workspace.functionsPath, workspace.runsPath]) mkdirSync(directory, { recursive: true });
  const defaultRegistry = join(workspace.functionsPath, 'modules.json');
  if (workspace.registryPath === defaultRegistry && !existsSync(defaultRegistry)) writeFileSync(defaultRegistry, '{}\n', { flag: 'wx' });
  return workspace;
}

export function prepareRunWorkspace(workspace, runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('runId must be a valid execution identifier');
  const rootPath = join(workspace.runsPath, runId);
  const workPath = join(rootPath, 'work');
  const artifactsPath = join(rootPath, 'artifacts');
  mkdirSync(workPath, { recursive: true });
  mkdirSync(artifactsPath, { recursive: true });
  return { workspaceId: workspace.id, runId, rootPath, workPath, artifactsPath };
}

export function workspaceBindings(workspace) {
  return {
    PIPELINE_WORKSPACE_ROOT: workspace.rootPath, PIPELINE_STATE_DIR: workspace.statePath,
    PIPELINE_FUNCTIONS_DIR: workspace.functionsPath, PIPELINE_RUNS_DIR: workspace.runsPath,
    PIPELINE_FUNCTION_REGISTRY: workspace.registryPath,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(resolveWorkspace(), null, 2));
