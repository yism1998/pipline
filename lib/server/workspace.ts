import { env } from 'cloudflare:workers';
import type { WorkspaceInfo } from '../contracts';

export function getWorkspaceInfo(): WorkspaceInfo {
  const bindings = env as unknown as Record<string, unknown>;
  const path = (key: string) => typeof bindings[key] === 'string' && bindings[key] ? bindings[key] as string : null;
  const rootPath = path('PIPELINE_WORKSPACE_ROOT');
  return {
    id: 'local', configured: !!rootPath, definitionStorage: 'local-d1', rootPath,
    statePath: path('PIPELINE_STATE_DIR'), functionsPath: path('PIPELINE_FUNCTIONS_DIR'),
    runsPath: path('PIPELINE_RUNS_DIR'), registryPath: path('PIPELINE_FUNCTION_REGISTRY'),
  };
}
