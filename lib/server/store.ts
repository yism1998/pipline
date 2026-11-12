import { env } from 'cloudflare:workers';
import type { Completion, FunctionSpec, FunctionDefinition, Run, RunResult, ScheduleState, Task } from '../contracts';
import { ApiError, parseRecipient } from './validation';
import { computeScheduleState, scheduleKey } from './schedule';
import { toRunResult } from './results';

type RunRow = { data: string; status: Run['status']; cancelled_at: string | null; locked_until: number | null };
export type ScheduleRow = { task_id: string; rule_key: string; generation: string; revision: number; task_version: number; next_run_at: string | null; last_run_at: string | null; last_run_id: string | null; completed: number; error: string | null };
export function database(): D1Database { if (!env.DB) throw new ApiError(503, '数据库尚未连接'); return env.DB; }
export async function listFunctions(db = database()): Promise<FunctionDefinition[]> {
  const rows = await db.prepare('SELECT data FROM functions ORDER BY updated_at DESC LIMIT 200').all<{ data: string }>();
  return rows.results.map(row => JSON.parse(row.data) as FunctionDefinition);
}
export async function getFunction(id: string, db = database()): Promise<FunctionDefinition> {
  const row = await db.prepare('SELECT data FROM functions WHERE id=?').bind(id).first<{ data: string }>();
  if (!row) throw new ApiError(404, 'Function 不存在');
  return JSON.parse(row.data) as FunctionDefinition;
}
export async function createFunction(fn: FunctionDefinition, db = database()): Promise<FunctionDefinition> {
  await db.prepare('INSERT INTO functions (id,data,version,created_at,updated_at) VALUES (?,?,?,?,?)').bind(fn.id, JSON.stringify(fn), fn.version, fn.createdAt, fn.updatedAt).run();
  return getFunction(fn.id, db);
}
export async function updateFunction(fn: FunctionDefinition, oldVersion: number, db = database()): Promise<FunctionDefinition> {
  const result = await db.prepare('UPDATE functions SET data=?,version=?,updated_at=? WHERE id=? AND version=?').bind(JSON.stringify(fn), fn.version, fn.updatedAt, fn.id, oldVersion).run();
  if (!result.meta.changes) throw new ApiError(409, 'Function 已被修改，请刷新后重试');
  return getFunction(fn.id, db);
}
export async function deleteFunction(id: string, db = database()) {
  await getFunction(id, db);
  await db.prepare('DELETE FROM functions WHERE id=?').bind(id).run();
}
export async function instantiateFunction(id: string, db = database()): Promise<FunctionSpec> {
  const definition = await getFunction(id, db);
  return { id: crypto.randomUUID(), name: definition.name, type: definition.type, enabled: definition.enabled, handler: definition.handler, config: structuredClone(definition.config), retries: definition.retries, onError: definition.onError, source: { id: definition.id, version: definition.version } };
}
/** Persisted task definitions exclude derived scheduling state. */
export function taskDefinition(task: Task): Task {
  const value = { ...task };
  delete value.scheduling;
  return value;
}
export function serializeRun(run: Run): string {
  return JSON.stringify({ ...run, definition: taskDefinition(run.definition) });
}
export function scheduleState(row?: ScheduleRow | null): ScheduleState {
  return { nextRunAt: row?.next_run_at ?? null, lastRunAt: row?.last_run_at ?? null, lastRunId: row?.last_run_id ?? null, completed: !!row?.completed, ...(row?.error ? { error: row.error } : {}) };
}
function taskFromRow(row: { data: string; scheduling: string | null }): Task {
  const task = JSON.parse(row.data) as Task;
  task.schedule ??= { type: 'manual' };
  task.scheduling = scheduleState(row.scheduling ? JSON.parse(row.scheduling) : null);
  return task;
}
const taskSelect = `SELECT t.data, CASE WHEN s.task_id IS NULL THEN NULL ELSE json_object('next_run_at',s.next_run_at,'last_run_at',s.last_run_at,'last_run_id',s.last_run_id,'completed',s.completed,'error',s.error) END AS scheduling FROM tasks t LEFT JOIN task_schedules s ON s.task_id=t.id`;
export async function listTasks(db = database()): Promise<Task[]> {
  const rows = await db.prepare(`${taskSelect} ORDER BY t.updated_at DESC LIMIT 200`).all<{ data: string; scheduling: string | null }>();
  return rows.results.map(taskFromRow);
}
export async function getTask(id: string, db = database()): Promise<Task> {
  const row = await db.prepare(`${taskSelect} WHERE t.id=?`).bind(id).first<{ data: string; scheduling: string | null }>();
  if (!row) throw new ApiError(404, 'Task 不存在'); return taskFromRow(row);
}
function storedTask(task: Task): string { return JSON.stringify(taskDefinition(task)); }
export function syncScheduleStatement(db: D1Database, task: Task, previous?: Task, expectedData?: string) {
  const rule = task.schedule ?? { type: 'manual' };
  const state = computeScheduleState(task, undefined, undefined, Date.parse(task.updatedAt));
  return db.prepare(`INSERT INTO task_schedules (task_id,rule_key,generation,revision,task_version,next_run_at,last_run_at,last_run_id,completed,error)
    SELECT ?,?,?,1,?,?,NULL,NULL,0,NULL WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND data=?)
    ON CONFLICT(task_id) DO UPDATE SET
      generation=CASE WHEN task_schedules.rule_key=excluded.rule_key THEN task_schedules.generation ELSE excluded.generation END,
      revision=task_schedules.revision+1, task_version=excluded.task_version,
      next_run_at=CASE WHEN ?=0 OR excluded.rule_key='manual' THEN NULL
        WHEN task_schedules.rule_key=excluded.rule_key AND ?=1 AND task_schedules.completed=1 THEN NULL
        WHEN task_schedules.rule_key=excluded.rule_key AND ?=1 AND task_schedules.next_run_at IS NOT NULL THEN task_schedules.next_run_at
        ELSE excluded.next_run_at END,
      completed=CASE WHEN task_schedules.rule_key=excluded.rule_key AND ?=1 THEN task_schedules.completed ELSE 0 END,
      rule_key=excluded.rule_key,error=NULL`)
    .bind(task.id, scheduleKey(rule), crypto.randomUUID(), task.version, state.nextRunAt, task.id, expectedData ?? storedTask(task), task.status === 'active' ? 1 : 0, rule.type === 'once' ? 1 : 0, previous?.status === 'active' ? 1 : 0, rule.type === 'once' ? 1 : 0);
}
export async function createTask(task: Task, db = database()) {
  await db.batch([db.prepare('INSERT INTO tasks (id,data,version,created_at,updated_at) VALUES (?,?,?,?,?)').bind(task.id, storedTask(task), task.version, task.createdAt, task.updatedAt), syncScheduleStatement(db, task)]);
  return getTask(task.id, db);
}
export async function updateTask(task: Task, oldVersion: number, db = database()) {
  const previous = await getTask(task.id, db);
  const results = await db.batch([db.prepare('UPDATE tasks SET data=?,version=?,updated_at=? WHERE id=? AND version=?').bind(storedTask(task), task.version, task.updatedAt, task.id, oldVersion), syncScheduleStatement(db, task, previous)]);
  if (!results[0].meta.changes) throw new ApiError(409, 'Task 已被修改，请刷新后重试'); return getTask(task.id, db);
}
export async function deleteTask(id: string, db = database()) { await getTask(id, db); await db.batch([db.prepare('DELETE FROM tasks WHERE id=?').bind(id), db.prepare('DELETE FROM task_schedules WHERE task_id=?').bind(id)]); }
function rowToRun(row: RunRow): Run {
  const run = JSON.parse(row.data) as Run; run.status = row.status;
  if (run.status === 'running' && (row.locked_until ? row.locked_until < Date.now() : Date.now()-Date.parse(run.startedAt)>45_000)) { run.status='paused';run.error=run.execution==='background'||run.trigger==='schedule'?'上次执行请求已中断，断点已保留。平台会自动继续；未知状态的远程调用不会被重复执行。':'上次执行请求已中断，断点已保留。请显式继续运行；未知状态的远程调用不会被重复执行。'; }
  if (row.cancelled_at) { run.finishedAt = row.cancelled_at; run.durationMs = Date.parse(row.cancelled_at)-Date.parse(run.startedAt); } return run;
}
export async function getRun(id: string, db = database()): Promise<Run> {
  const row = await db.prepare('SELECT data,status,cancelled_at,locked_until FROM runs WHERE id=?').bind(id).first<RunRow>();
  if (!row) throw new ApiError(404, '运行记录不存在'); return rowToRun(row);
}
export async function listRuns(taskId?: string, db = database()): Promise<Run[]> {
  const query = taskId ? db.prepare('SELECT data,status,cancelled_at,locked_until FROM runs WHERE task_id=? ORDER BY created_at DESC LIMIT 100').bind(taskId) : db.prepare('SELECT data,status,cancelled_at,locked_until FROM runs ORDER BY created_at DESC LIMIT 100');
  return (await query.all<RunRow>()).results.map(rowToRun);
}
export async function getRunResult(runId: string, db = database()): Promise<RunResult | null> {
  return toRunResult(await getRun(runId, db));
}

/** Terminal background results form a durable inbox; the Run ID is the deduplication key. */
export async function recordCompletion(run: Run, db = database()): Promise<void> {
  if (run.execution !== 'background') return;
  const result = toRunResult(run);
  if (!result) return;
  await db.prepare(`INSERT OR IGNORE INTO run_completions (run_id,recipient,data,created_at,acknowledged_at)
    SELECT ?,?,?,?,NULL WHERE EXISTS (SELECT 1 FROM runs WHERE id=? AND status=?)`)
    .bind(run.id, result.recipient, JSON.stringify(result), result.finishedAt, run.id, result.status).run();
}

/** Recover a crash between persisting a terminal Run and materializing its result inbox entry. */
export async function reconcileCompletions(db = database()): Promise<void> {
  const rows = await db.prepare(`SELECT r.data,r.status,r.cancelled_at,r.locked_until FROM runs r
    LEFT JOIN run_completions c ON c.run_id=r.id
    WHERE c.run_id IS NULL AND r.status IN ('success','failed','cancelled')
      AND json_extract(r.data,'$.execution')='background'
    ORDER BY r.updated_at LIMIT 200`).all<RunRow>();
  for (const row of rows.results) await recordCompletion(rowToRun(row), db);
}

type CompletionRow = { run_id: string; recipient: string; data: string; created_at: string; acknowledged_at: string | null };
function completionFromRow(row: CompletionRow): Completion {
  return { runId: row.run_id, recipient: row.recipient, result: JSON.parse(row.data) as RunResult, createdAt: row.created_at, ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}) };
}
export async function listCompletions(recipient = 'default', limit = 50, db = database()): Promise<Completion[]> {
  const name = parseRecipient(recipient);
  const boundedLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 50;
  const rows = await db.prepare(`SELECT run_id,recipient,data,created_at,acknowledged_at FROM run_completions
    WHERE recipient=? AND acknowledged_at IS NULL ORDER BY created_at,run_id LIMIT ?`).bind(name, boundedLimit).all<CompletionRow>();
  return rows.results.map(completionFromRow);
}
export async function ackCompletion(runId: string, recipient = 'default', db = database()): Promise<Completion> {
  const name = parseRecipient(recipient);
  const found = await db.prepare('SELECT run_id FROM run_completions WHERE run_id=? AND recipient=?').bind(runId, name).first();
  if (!found) throw new ApiError(404, '完成结果不存在');
  await db.prepare('UPDATE run_completions SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE run_id=? AND recipient=?').bind(new Date().toISOString(), runId, name).run();
  const row = await db.prepare('SELECT run_id,recipient,data,created_at,acknowledged_at FROM run_completions WHERE run_id=? AND recipient=?').bind(runId, name).first<CompletionRow>();
  if (!row) throw new ApiError(404, '完成结果不存在');
  return completionFromRow(row);
}
export async function insertRun(run: Run, db = database()) {
  const result = await db.prepare(`INSERT INTO runs (id,task_id,status,data,created_at,updated_at)
    SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM runs WHERE task_id=? AND status IN ('queued','running','paused'))`)
    .bind(run.id, run.taskId, run.status, serializeRun(run), run.startedAt, run.startedAt, run.taskId).run();
  if (!result.meta.changes) throw new ApiError(409, '该 Task 已有排队、执行中或暂停的运行，请等待结束或先取消后再试');
}
export async function acquireLease(id: string, token: string, db = database()) {
  const now = Date.now(); const result = await db.prepare("UPDATE runs SET lock_token=?,locked_until=?,status='running' WHERE id=? AND status IN ('queued','running','paused') AND (locked_until IS NULL OR locked_until<?)").bind(token,now+45_000,id,now).run();
  if (!result.meta.changes) { const run = await getRun(id,db); if (!['queued','running','paused'].includes(run.status)) throw new ApiError(409, '该运行已经结束'); throw new ApiError(409, '运行已被执行器锁定，请等待当前批次完成（最长 45 秒）'); }
}
export async function getInflight(id: string, db = database()) { return (await db.prepare('SELECT inflight_function FROM runs WHERE id=?').bind(id).first<{inflight_function:string|null}>())?.inflight_function; }
export async function markInflight(id: string, token: string, key: string, db = database()) { const result = await db.prepare("UPDATE runs SET inflight_function=? WHERE id=? AND lock_token=? AND status='running'").bind(key,id,token).run(); return result.meta.changes > 0; }
export async function persistRun(run: Run, token: string, db = database()): Promise<boolean> {
  run.durationMs = Date.now()-Date.parse(run.startedAt);
  const result = await db.prepare("UPDATE runs SET data=?,status=?,updated_at=?,inflight_function=NULL WHERE id=? AND lock_token=? AND status='running'").bind(serializeRun(run),run.status,new Date().toISOString(),run.id,token).run();
  if (result.meta.changes) {
    // A delivery write must not rewrite a successfully persisted execution outcome.
    // The background worker reconciles any interrupted inbox writes on its next tick.
    try { await recordCompletion(run, db); } catch (error) { console.error('Completion inbox write deferred', error); }
  }
  return result.meta.changes > 0;
}
export async function releaseLease(id: string, token: string, db = database()) { await db.prepare('UPDATE runs SET lock_token=NULL,locked_until=NULL WHERE id=? AND lock_token=?').bind(id,token).run(); }
export async function isCancelled(id: string, db = database()) { const row = await db.prepare('SELECT status FROM runs WHERE id=?').bind(id).first<{status:string}>(); return row?.status === 'cancelled'; }
export async function cancelRun(id: string, db = database()): Promise<Run> {
  const run = await getRun(id,db); if (!['queued','running','paused'].includes(run.status)) throw new ApiError(409, '该运行已经结束');
  const now = new Date().toISOString(); await db.prepare("UPDATE runs SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND status IN ('queued','running','paused')").bind(now,now,id).run();
  const cancelled = await getRun(id, db);
  try { await recordCompletion(cancelled, db); } catch (error) { console.error('Completion inbox write deferred', error); }
  return cancelled;
}
