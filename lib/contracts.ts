export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Context = Record<string, Json>;
export type FunctionSpec = {
  id: string; name: string; type: 'code' | 'agent'; enabled: boolean;
  handler: 'context.set' | 'context.merge' | 'counter.increment' | 'resource.add' | 'code.remote' | 'agent.http';
  config: Context; retries: number; onError: 'stop' | 'continue';
  source?: { id: string; version: number };
};
export type FunctionDefinition = FunctionSpec & { description: string; version: number; createdAt: string; updatedAt: string };
export type ScheduleRule =
  | { type: 'manual' }
  | { type: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' }
  | { type: 'once'; at: string };
export type ScheduleState = { nextRunAt: string | null; lastRunAt: string | null; lastRunId: string | null; completed: boolean; error?: string };
export type SchedulerStatus = { enabled: boolean; lastHeartbeatAt: string | null; pollIntervalMs: number; nextRunAt: string | null };
export type Task = {
  id: string; name: string; description: string; category: string; status: 'active' | 'draft' | 'paused';
  functions: FunctionSpec[]; initialContext: Context;
  schedule?: ScheduleRule; scheduling?: ScheduleState;
  result?: { path?: string; recipient?: string };
  loop: { maxIterations: number; stopPath?: string; stopValue?: Json };
  version: number; createdAt: string; updatedAt: string;
};
export type Resource = { id: string; name: string; type: string; value: Json; functionId: string; iteration: number; createdAt: string };
export type RunLog = { id: string; level: 'info' | 'error' | 'warn'; message: string; functionId?: string; iteration: number; at: string };
export type RunStep = { functionId: string; functionName: string; iteration: number; status: 'success' | 'failed' | 'skipped'; durationMs: number; attempt: number; error?: string; at: string };
export type Run = {
  id: string; taskId: string; taskName: string; taskVersion: number; status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'paused';
  context: Context; resources: Resource[]; logs: RunLog[]; steps: RunStep[];
  iteration: number; functionIndex: number; startedAt: string; finishedAt?: string; durationMs: number; error?: string;
  definition: Task; kind?: 'task' | 'function'; functionId?: string; functionVersion?: number; trigger?: 'manual' | 'schedule'; scheduledFor?: string;
  execution?: 'inline' | 'background'; recipient?: string;
};
export type RunResult = {
  runId: string; taskId: string; taskName: string; taskVersion: number; status: 'success' | 'failed' | 'cancelled';
  output: Json; resources: Resource[]; startedAt: string; finishedAt: string; durationMs: number; error?: string;
  trigger?: 'manual' | 'schedule'; scheduledFor?: string; recipient: string;
};
export type RunTicket = { runId: string; taskId: string; status: Run['status']; resultUrl: string };
export type Completion = { runId: string; recipient: string; result: RunResult; createdAt: string; acknowledgedAt?: string };
export type WorkspaceInfo = { id: 'local'; configured: boolean; definitionStorage: 'local-d1'; rootPath: string | null; statePath: string | null; functionsPath: string | null; runsPath: string | null; registryPath: string | null };
export type Bootstrap = { tasks: Task[]; functions: FunctionDefinition[]; runs: Run[]; user: { name: string; email: string }; serviceAccess: boolean; scheduler?: SchedulerStatus; workspace?: WorkspaceInfo };
export const handlers = [
  { value: 'context.set', label: '写入上下文', type: 'code', description: '将 config.values 写入当前 Context' },
  { value: 'context.merge', label: '合并上下文', type: 'code', description: '合并 config.values 到当前 Context' },
  { value: 'counter.increment', label: '计数器递增', type: 'code', description: 'config.key 指定字段，config.amount 指定步长' },
  { value: 'resource.add', label: '生成资源', type: 'code', description: 'config.name / type / value 定义资源' },
  { value: 'code.remote', label: '远程代码 Runner', type: 'code', description: '向 config.endpoint 发送代码和上下文，由独立 Runner 执行' },
  { value: 'agent.http', label: '调用 Agent', type: 'agent', description: '向 config.endpoint 发送 prompt 和上下文，返回 context / resources' },
] as const;
