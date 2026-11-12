import type { ScheduleRule, ScheduleState, Task } from '../contracts';

export const POLL_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_EVERY = 365;
export function intervalMilliseconds(rule: Extract<ScheduleRule, { type: 'interval' }>): number {
  return rule.every * { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[rule.unit];
}
export function scheduleKey(rule: ScheduleRule = { type: 'manual' }): string {
  return rule.type === 'interval' ? `interval:${rule.every}:${rule.unit}` : rule.type === 'once' ? `once:${new Date(rule.at).toISOString()}` : 'manual';
}
export function sameSchedule(a?: ScheduleRule, b?: ScheduleRule): boolean { return scheduleKey(a) === scheduleKey(b); }
export function computeScheduleState(task: Task, previousTask?: Task, previousState?: ScheduleState, now = Date.now()): ScheduleState {
  const rule = task.schedule ?? { type: 'manual' };
  const unchanged = !!previousTask && sameSchedule(rule, previousTask.schedule);
  const completed = rule.type === 'once' && unchanged && !!previousState?.completed;
  let nextRunAt: string | null = null;
  if (task.status === 'active' && rule.type !== 'manual' && !completed) {
    const keepDue = unchanged && previousTask?.status === 'active' && previousState?.nextRunAt;
    nextRunAt = keepDue || (rule.type === 'once' ? new Date(rule.at).toISOString() : new Date(now + intervalMilliseconds(rule)).toISOString());
  }
  return { nextRunAt, lastRunAt: previousState?.lastRunAt ?? null, lastRunId: previousState?.lastRunId ?? null, completed };
}
