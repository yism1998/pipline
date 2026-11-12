import type { Run, SchedulerStatus, Task } from '../contracts';
import { createRun, executeRun } from './engine';
import { database, syncScheduleStatement, serializeRun, reconcileCompletions, type ScheduleRow } from './store';
import { intervalMilliseconds, POLL_INTERVAL_MS } from './schedule';
import { ApiError } from './validation';
export { computeScheduleState, intervalMilliseconds, sameSchedule } from './schedule';

export type SchedulerTickResult = { scheduler: SchedulerStatus; started: string[]; resumed: string[]; skipped: number; errors: { taskId: string; message: string }[] };
export type SchedulerTickOptions = { now?: number; budgetMs?: number; maxTasks?: number; execute?: (id: string, db: D1Database, budgetMs: number) => Promise<Run> };
export async function getSchedulerStatus(db = database(), now = Date.now()): Promise<SchedulerStatus> {
  const [meta, next] = await Promise.all([
    db.prepare("SELECT last_heartbeat_at FROM scheduler_meta WHERE id='local'").first<{ last_heartbeat_at: string | null }>(),
    db.prepare("SELECT MIN(s.next_run_at) AS next_run_at FROM task_schedules s JOIN tasks t ON t.id=s.task_id WHERE json_extract(t.data,'$.status')='active' AND s.completed=0").first<{ next_run_at: string | null }>(),
  ]);
  const lastHeartbeatAt = meta?.last_heartbeat_at ?? null;
  return { enabled: !!lastHeartbeatAt && now-Date.parse(lastHeartbeatAt) <= POLL_INTERVAL_MS*12, lastHeartbeatAt, pollIntervalMs: POLL_INTERVAL_MS, nextRunAt: next?.next_run_at ?? null };
}

/** The HTTP endpoint uses wall-clock time only. Time and executor injection are for local behavior tests. */
export async function tickScheduler(db = database(), options: SchedulerTickOptions = {}): Promise<SchedulerTickResult> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const deadline = Date.now() + Math.min(18_000, Math.max(1, options.budgetMs ?? 18_000));
  const maxTasks = Math.min(10, Math.max(1, Math.trunc(options.maxTasks ?? 5)));
  const execute = options.execute ?? executeRun;
  const result: SchedulerTickResult = { scheduler: { enabled: true, lastHeartbeatAt: at, pollIntervalMs: POLL_INTERVAL_MS, nextRunAt: null }, started: [], resumed: [], skipped: 0, errors: [] };
  await db.prepare("INSERT INTO scheduler_meta (id,last_heartbeat_at) VALUES ('local',?) ON CONFLICT(id) DO UPDATE SET last_heartbeat_at=excluded.last_heartbeat_at").bind(at).run();

  // Rebuild missing schedule rows from current Function task definitions.
  const unscheduled = await db.prepare('SELECT t.data FROM tasks t LEFT JOIN task_schedules s ON t.id=s.task_id WHERE s.task_id IS NULL LIMIT 200').all<{ data: string }>();
  if (unscheduled.results.length) await db.batch(unscheduled.results.map(row => syncScheduleStatement(db, JSON.parse(row.data) as Task, undefined, row.data)));
  let attempted = 0;
  const seen = new Set<string>();
  const runBatch = async (runId: string, taskId: string, kind: 'started' | 'resumed') => {
    attempted++; seen.add(taskId);
    try { await execute(runId, db, Math.max(1, deadline-Date.now())); result[kind].push(runId); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) result.skipped++;
      else result.errors.push({ taskId, message: cause instanceof Error ? cause.message : '执行器出错' });
    }
  };

  // Agent-dispatched runs belong to their saved snapshot. Scheduled runs also
  // follow the live Task's active state; neither requires Agent step-by-step
  // control. Inline Function calls remain owned by their requesting executor.
  const resumable = await db.prepare(`SELECT r.id,r.task_id,r.status FROM runs r LEFT JOIN tasks t ON t.id=r.task_id
    WHERE (json_extract(r.data,'$.execution')='background' OR r.trigger_key IS NOT NULL)
    AND r.status IN ('queued','running','paused') AND (r.locked_until IS NULL OR r.locked_until<?)
    AND ((r.trigger_key IS NULL AND COALESCE(json_extract(r.data,'$.trigger'),'manual')<>'schedule')
      OR json_extract(t.data,'$.status')='active')
    ORDER BY r.updated_at,r.created_at LIMIT ?`).bind(Date.now(), maxTasks).all<{ id: string; task_id: string; status: Run['status'] }>();
  for (const row of resumable.results) {
    if (attempted >= maxTasks || Date.now() >= deadline) break;
    if (seen.has(row.task_id)) { result.skipped++; continue; }
    await runBatch(row.id, row.task_id, row.status === 'queued' ? 'started' : 'resumed');
  }

  const due = await db.prepare(`SELECT s.*,t.data FROM task_schedules s JOIN tasks t ON t.id=s.task_id
    WHERE s.next_run_at<=? AND s.completed=0 AND json_extract(t.data,'$.status')='active'
    AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id=s.task_id AND status IN ('queued','running','paused'))
    ORDER BY s.next_run_at LIMIT ?`).bind(at, maxTasks*4).all<ScheduleRow & { data: string }>();
  for (const row of due.results) {
    if (attempted >= maxTasks || Date.now() >= deadline) break;
    if (seen.has(row.task_id)) { result.skipped++; continue; }
    const task: Task = JSON.parse(row.data) as Task;
    const rule = task.schedule ?? { type: 'manual' };
    if (rule.type === 'manual' || !row.next_run_at) { result.skipped++; continue; }
    let run: Run;
    try { run = createRun(task, {}, 'schedule', row.next_run_at, now); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法启动 Task';
      await db.prepare('UPDATE task_schedules SET error=? WHERE task_id=? AND revision=?').bind(message, task.id, row.revision).run();
      result.errors.push({ taskId: task.id, message }); continue;
    }
    const triggerKey = `${task.id}:${row.generation}:${row.next_run_at}`;
    // One atomic transaction owns the occurrence and advances it only after its durable Run exists.
    const claim = db.prepare(`INSERT OR IGNORE INTO runs (id,task_id,status,data,trigger_key,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? FROM task_schedules s JOIN tasks t ON t.id=s.task_id
      WHERE s.task_id=? AND s.revision=? AND s.generation=? AND s.next_run_at=? AND s.completed=0
      AND t.version=? AND s.task_version=t.version AND json_extract(t.data,'$.status')='active'
      AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id=? AND status IN ('queued','running','paused'))`)
      .bind(run.id, task.id, run.status, serializeRun(run), triggerKey, run.startedAt, run.startedAt, task.id, row.revision, row.generation, row.next_run_at, task.version, task.id);
    const next = rule.type === 'once' ? null : new Date(now+intervalMilliseconds(rule)).toISOString();
    const advance = db.prepare(`UPDATE task_schedules SET next_run_at=?,last_run_at=?,last_run_id=?,completed=?,revision=revision+1,error=NULL
      WHERE task_id=? AND revision=? AND generation=? AND next_run_at=?
      AND EXISTS (SELECT 1 FROM runs WHERE id=? AND trigger_key=?)`)
      .bind(next, at, run.id, rule.type === 'once' ? 1 : 0, task.id, row.revision, row.generation, row.next_run_at, run.id, triggerKey);
    try {
      const saved = await db.batch([claim, advance]);
      if (!saved[0].meta.changes) { result.skipped++; continue; }
      await runBatch(run.id, task.id, 'started');
    } catch (cause) { result.errors.push({ taskId: task.id, message: cause instanceof Error ? cause.message : '调度持久化失败' }); }
  }
  // Recover completion entries after a process stopped between saving a
  // terminal Run and recording its result. Unique run IDs prevent duplicates.
  await reconcileCompletions(db);
  result.scheduler = await getSchedulerStatus(db, now);
  return result;
}
