import { z } from 'zod';
import type { Context, FunctionDefinition, Task, Json } from '../contracts';
import { MAX_INTERVAL_EVERY, sameSchedule } from './schedule';
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const recipientSchema = z.string().trim().min(1).max(100);
export function parseRecipient(value: unknown, fallback = 'default'): string {
  const result = recipientSchema.safeParse(value === undefined ? fallback : value);
  if (!result.success) throw new ApiError(400, 'recipient 必须是 1–100 字符的标识');
  return result.data;
}
export function safeJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 12) throw new ApiError(400, 'JSON 嵌套不能超过 12 层');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 500) throw new ApiError(400, '单个数组不能超过 500 项'); value.forEach(item => safeJson(item, depth + 1)); return; }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) { if (blockedKeys.has(key)) throw new ApiError(400, `禁止使用字段 ${key}`); safeJson(item, depth + 1); }
    return;
  }
  throw new ApiError(400, '值必须是合法 JSON');
}
export function context(value: unknown): Context {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Context 必须是 JSON 对象');
  safeJson(value);
  if (JSON.stringify(value).length > 65_536) throw new ApiError(400, 'Context 或 Function 配置不能超过 64KB');
  return value as Context;
}
const functionSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), type: z.enum(['code', 'agent']), enabled: z.boolean().default(true),
  handler: z.enum(['context.set', 'context.merge', 'counter.increment', 'resource.add', 'code.remote', 'agent.http']),
  config: z.unknown().transform(context), retries: z.number().int().min(0).max(3).default(0), onError: z.enum(['stop', 'continue']).default('stop'),
  source: z.object({ id: z.string().min(1).max(100), version: z.number().int().min(1) }).optional(),
}).superRefine((fn, ctx) => {
  if ((fn.type === 'agent') !== (fn.handler === 'agent.http')) ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Agent Function 必须使用 agent.http，Code Function 不能使用 agent.http'});
});
export function parseFunctionDefinition(value: unknown, previous?: FunctionDefinition): FunctionDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Function 必须是 JSON 对象');
  safeJson(value);
  const input = value as Record<string, unknown>;
  const merged = previous ? { ...previous, ...input } : input;
  const id = previous?.id ?? crypto.randomUUID();
  const result = functionSchema.safeParse({ ...merged, id });
  const description = z.string().max(2000).default('').safeParse(merged.description);
  if (!result.success) throw new ApiError(400, result.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('；'));
  if (!description.success) throw new ApiError(400, 'Function 描述不能超过 2000 字符');
  if (previous && input.version !== undefined && input.version !== previous.version) throw new ApiError(409, 'Function 已被修改，请刷新后重试');
  const now = new Date().toISOString();
  return { ...result.data, description: description.data, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
}
const scheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({ type: z.literal('interval'), every: z.number().int().min(1).max(MAX_INTERVAL_EVERY), unit: z.enum(['minutes', 'hours', 'days']) }).strict(),
  z.object({ type: z.literal('once'), at: z.string().datetime({ offset: true }) }).strict(),
]);
const taskSchema = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(''), category: z.string().trim().min(1).max(80).default('通用任务'), status: z.enum(['active', 'draft', 'paused']).default('draft'),
  schedule: scheduleSchema.default({ type: 'manual' }),
  result: z.object({
    path: z.string().trim().min(1).max(200).refine(path => !path.split('.').some(key => !key || blockedKeys.has(key)), '结果路径不合法').optional(),
    recipient: recipientSchema.optional(),
  }).strict().optional(),
  functions: z.array(functionSchema).min(1).max(20), initialContext: z.unknown().default({}).transform(context),
  loop: z.object({ maxIterations: z.number().int().min(1).max(20), stopPath: z.string().max(200).optional(), stopValue: z.unknown().optional() }).default({maxIterations: 1}).superRefine((loop, ctx) => {
    if (loop.stopPath && loop.stopPath.split('.').some(key => !key || blockedKeys.has(key))) ctx.addIssue({code: z.ZodIssueCode.custom, message:'停止条件路径不合法'});
    if (loop.stopValue !== undefined) { try { safeJson(loop.stopValue); } catch { ctx.addIssue({code:z.ZodIssueCode.custom, message:'停止条件值不合法'}); } }
  }),
});
export function parseTask(value: unknown, previous?: Task): Task {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Task 必须是 JSON 对象');
  safeJson(value); const input = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(input, 'hooks')) throw new ApiError(400, 'Task 仅支持 functions 字段');
  const functions = input.functions ?? previous?.functions;
  const result = taskSchema.safeParse({ ...(previous ?? {}), ...input, functions });
  if (!result.success) throw new ApiError(400, result.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('；'));
  if (result.data.schedule.type === 'once') {
    const timestamp = Date.parse(result.data.schedule.at);
    const preservePast = !!previous && sameSchedule(result.data.schedule, previous.schedule);
    if (!Number.isFinite(timestamp) || (timestamp <= Date.now() && !preservePast)) throw new ApiError(400, '一次性执行时间必须是带时区的有效未来时间');
    result.data.schedule.at = new Date(timestamp).toISOString();
  }
  const ids = result.data.functions.map(fn => fn.id);
  if (new Set(ids).size !== ids.length) throw new ApiError(400, 'Function ID 不能重复');
  if (result.data.functions.length * result.data.loop.maxIterations > 200) throw new ApiError(400, '一次运行最多执行 200 个 Function 步骤');
  if (previous && input.version !== undefined && input.version !== previous.version) throw new ApiError(409, 'Task 已被修改，请刷新后重试');
  const now = new Date().toISOString();
  return { ...result.data, loop: result.data.loop as Task['loop'], id: previous?.id ?? crypto.randomUUID(), version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
}
export async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? '0') > 131_072) throw new ApiError(413, '请求不能超过 128KB');
  const text = await request.text(); if (text.length > 131_072) throw new ApiError(413, '请求不能超过 128KB');
  if (!text.trim()) return {};
  try { const value = JSON.parse(text); safeJson(value); return value; }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, '请求体不是合法 JSON'); }
}
export function assertOrigin(request: Request) { const origin = request.headers.get('origin'); if (origin && origin !== new URL(request.url).origin) throw new ApiError(403, '拒绝跨站写入请求'); }
export async function route(fn: () => Promise<Response>, request?: Request): Promise<Response> {
  try {
    if (request && !['GET','HEAD','OPTIONS'].includes(request.method)) assertOrigin(request);
    const response = await fn(); response.headers.set('Cache-Control', 'no-store'); response.headers.set('X-Content-Type-Options', 'nosniff'); return response;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : '服务暂时不可用，请稍后重试';
    if (status === 500) console.error('Pipeline API error', error);
    return Response.json({error: message}, {status, headers:{'Cache-Control':'no-store'}});
  }
}
