import type { Run, RunResult } from '../contracts';
import { pathValue } from './functions';

export function isTerminalRun(run: Run): run is Run & { status: RunResult['status'] } {
  return run.status === 'success' || run.status === 'failed' || run.status === 'cancelled';
}

/** The Agent-facing response deliberately excludes internal steps, logs and the definition. */
export function toRunResult(run: Run): RunResult | null {
  if (!isTerminalRun(run)) return null;
  const path = run.definition.result?.path;
  const output = path ? pathValue(run.context, path) ?? null : run.context;
  return {
    runId: run.id, taskId: run.taskId, taskName: run.taskName, taskVersion: run.taskVersion, status: run.status,
    output: structuredClone(output), resources: structuredClone(run.resources), startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt, durationMs: run.durationMs,
    recipient: run.recipient ?? run.definition.result?.recipient ?? 'default',
    ...(run.error ? { error: run.error } : {}), ...(run.trigger ? { trigger: run.trigger } : {}),
    ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
  };
}
