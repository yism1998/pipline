import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(), data: text('data').notNull(), version: integer('version').notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
export const functions = sqliteTable('functions', {
  id: text('id').primaryKey(), data: text('data').notNull(), version: integer('version').notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(), taskId: text('task_id').notNull(), status: text('status').notNull(), data: text('data').notNull(),
  triggerKey: text('trigger_key'),
  lockToken: text('lock_token'), lockedUntil: integer('locked_until'), cancelledAt: text('cancelled_at'), inflightFunction: text('inflight_function'),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [index('runs_task_created_idx').on(table.taskId, table.createdAt), uniqueIndex('runs_trigger_key_unique').on(table.triggerKey)]);
export const runCompletions = sqliteTable('run_completions', {
  runId: text('run_id').primaryKey(), recipient: text('recipient').notNull(), data: text('data').notNull(),
  createdAt: text('created_at').notNull(), acknowledgedAt: text('acknowledged_at'),
}, (table) => [index('run_completions_inbox_idx').on(table.recipient, table.acknowledgedAt, table.createdAt)]);

export const taskSchedules = sqliteTable('task_schedules', {
  taskId: text('task_id').primaryKey(), ruleKey: text('rule_key').notNull(), generation: text('generation').notNull(),
  revision: integer('revision').notNull(), taskVersion: integer('task_version').notNull(),
  nextRunAt: text('next_run_at'), lastRunAt: text('last_run_at'), lastRunId: text('last_run_id'),
  completed: integer('completed').notNull().default(0), error: text('error'),
}, (table) => [index('task_schedules_due_idx').on(table.nextRunAt)]);
export const schedulerMeta = sqliteTable('scheduler_meta', {
  id: text('id').primaryKey(), lastHeartbeatAt: text('last_heartbeat_at'),
});
