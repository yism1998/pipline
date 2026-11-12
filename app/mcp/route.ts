import { handleApi } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

const object = { type: 'object', additionalProperties: true };
const fn = {
  type: 'object', required: ['id', 'name', 'type', 'handler', 'config'],
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, type: { enum: ['code', 'agent'] },
    handler: { enum: ['context.set', 'context.merge', 'counter.increment', 'resource.add', 'code.remote', 'agent.http'] },
    source: { type: 'object', required: ['id', 'version'], additionalProperties: false, properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 1 } } },
    enabled: { type: 'boolean' }, config: object, retries: { type: 'integer', minimum: 0, maximum: 3 }, onError: { enum: ['stop', 'continue'] },
  },
};
const functionProperties = { ...fn.properties, description: { type: 'string', maxLength: 2000 } };
const schedule = { oneOf: [
  { type: 'object', required: ['type'], additionalProperties: false, properties: { type: { const: 'manual' } } },
  { type: 'object', required: ['type', 'every', 'unit'], additionalProperties: false, properties: { type: { const: 'interval' }, every: { type: 'integer', minimum: 1, maximum: 365 }, unit: { enum: ['minutes', 'hours', 'days'] } } },
  { type: 'object', required: ['type', 'at'], additionalProperties: false, properties: { type: { const: 'once' }, at: { type: 'string', format: 'date-time', description: '带时区的未来执行时间' } } },
] };
const taskProperties = {
  name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' },
  status: { enum: ['active', 'draft', 'paused'] }, schedule, functions: { type: 'array', minItems: 1, maxItems: 20, items: fn, description: '按数组顺序执行；同一次 Run 的全部 Function 与 Loop 轮次共享 Context。' }, initialContext: object,
  loop: { type: 'object', required: ['maxIterations'], properties: { maxIterations: { type: 'integer', minimum: 1, maximum: 20 }, stopPath: { type: 'string' }, stopValue: {} } },
  result: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', maxLength: 200, description: '最终 Context 输出路径，例如 report；未设时返回完整 Context。' }, recipient: { type: 'string', minLength: 1, maxLength: 100, description: '最终结果收件箱标识，默认 default。' } } },
};
const idInput = (name: string) => ({ type: 'object', properties: { [name]: { type: 'string' } }, required: [name], additionalProperties: false });
const recipient = { type: 'string', minLength: 1, maxLength: 100 };
const waiting = { type: 'number', minimum: 0, maximum: 25, default: 25 };
const functionTools = [
  { name: 'functions_list', description: '列出独立保存的 Function 工具定义，不要求关联 Task。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'function_get', description: '读取完整 Function 定义及版本。', inputSchema: idInput('functionId') },
  { name: 'function_create', description: '独立注册 Function。code.remote 使用 config.endpoint 绑定 Runner，config.code 或 config.entry 绑定实现；保存不会执行。', inputSchema: { type: 'object', properties: functionProperties, required: ['name', 'type', 'handler', 'config'], additionalProperties: false } },
  { name: 'function_update', description: '修改 Function 定义，传当前 version 检查冲突；不影响已有 Task 内的快照。', inputSchema: { type: 'object', properties: { ...functionProperties, functionId: { type: 'string' }, version: { type: 'integer', minimum: 1 } }, required: ['functionId', 'version'], additionalProperties: false } },
  { name: 'function_delete', description: '删除 Function 定义；保留 Task 和历史 Run 中已保存的快照。', inputSchema: idInput('functionId') },
  { name: 'function_instantiate', description: '从库复制带新 ID 和 source 版本的 Function，将返回对象放入 Task.functions；本操作不执行代码。', inputSchema: idInput('functionId') },
  { name: 'function_call', description: '独立调用已注册且启用的 Function，传入 context 并保存真实 Run，无需先创建 Task。外部 Agent 读取 Run 结果后自行决策与验收；执行失败以 isError=true 返回，内容保留 Run.status/error。', inputSchema: { type: 'object', properties: { functionId: { type: 'string' }, context: object }, required: ['functionId'], additionalProperties: false } },
];
const tools = [
  ...functionTools,
  { name: 'workspace_get', description: '读取本地工作空间的实际根目录、D1 状态目录、Function 模块与运行目录；只读返回服务端配置，不修改工作空间。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'scheduler_status', description: '读取本地调度器心跳、在线状态与下次执行时间。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'tasks_list', description: '列出 Pipeline 任务定义，包含已定义的 Function 组合和 Loop 配置；平台不内置 Agent 主控。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'task_get', description: '读取完整任务定义。', inputSchema: idInput('taskId') },
  { name: 'task_create', description: '由 Agent 创建可复用 Task，将多个 Function 放入 functions 数组按顺序执行并共享本次 Run 的 Context。可同时配置 Loop 和执行规则。', inputSchema: { type: 'object', properties: taskProperties, required: ['name', 'functions'], additionalProperties: false } },
  { name: 'task_update', description: '修改任务。请先读取最新版本并传 version，冲突时重新读取。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, version: { type: 'integer' }, ...taskProperties }, required: ['taskId', 'version'], additionalProperties: false } },
  { name: 'task_delete', description: '删除指定任务定义，保留历史运行的任务快照。', inputSchema: idInput('taskId') },
  { name: 'run_start', description: '提交 Task 并立即返回执行票据。平台后台接管 Function、Loop 和自动续跑，Agent 无需逐步调度；用 run_wait 或结果收件箱取得最终结果。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, context: object, recipient }, required: ['taskId'], additionalProperties: false } },
  { name: 'task_execute', description: '提交 Task 并等待最终结果，默认最多等待 25 秒。中间执行由平台接管，不返回步骤或日志；等待超时仅返回票据，任务仍在后台继续，稍后用 run_wait 或收件箱取得结果。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, context: object, recipient, waitSeconds: waiting }, required: ['taskId'], additionalProperties: false } },
  { name: 'run_result', description: '只读取最终结果；未完成时返回票据，不泄漏中间步骤或日志，也不会触发执行。', inputSchema: idInput('runId') },
  { name: 'run_wait', description: '等待平台后台执行完成，默认最多 25 秒，只返回最终结果或仍待完成的票据；不需要 Agent 续跑 Function。', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, waitSeconds: waiting }, required: ['runId'], additionalProperties: false } },
  { name: 'completions_list', description: '读取指定 recipient 的未确认最终结果收件箱；只含已结束的后台任务，不含中间执行过程。', inputSchema: { type: 'object', properties: { recipient, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }, additionalProperties: false } },
  { name: 'completion_ack', description: '确认已收到某次运行的最终结果，重复确认安全；确认后结果不再出现在未读收件箱，运行记录仍保留。', inputSchema: { type: 'object', properties: { runId: { type: 'string' }, recipient }, required: ['runId'], additionalProperties: false } },
  { name: 'runs_list', description: '读取最近的持久化运行记录。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'run_get', description: '调试用途：读取 Run 的状态、Context、资源、Function 调用步骤与日志。正常托管流程用 run_result/run_wait 即可。', inputSchema: idInput('runId') },
  { name: 'run_resume', description: '显式续跑调试工具；托管 Task 由平台自动续跑，通常无需 Agent 调用。并发续跑会被拒绝。', inputSchema: idInput('runId') },
  { name: 'run_cancel', description: '协作式取消运行；当前远程请求的已发生副作用无法撤回。', inputSchema: idInput('runId') },
];

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  let rpc: { id?: string | number | null; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  try { rpc = await request.json(); } catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }, 400); }
  if (!rpc || typeof rpc !== 'object') return reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400);
  const id = rpc.id ?? null;
  const result = (value: unknown) => reply({ jsonrpc: '2.0', id, result: value });
  if (rpc.method === 'server/discover') return result({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'pipeline', version: '1.0.0' } });
  if (rpc.method === 'initialize') return result({ protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'pipeline', version: '1.0.0' } });
  if (rpc.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
  if (rpc.method === 'ping') return result({});
  if (rpc.method === 'tools/list') return result({ tools });
  if (rpc.method !== 'tools/call') return reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  const params = rpc.params;
  const args = params?.arguments ?? {};
  const name = params?.name;
  const toolError = (message: string) => result({ isError: true, content: [{ type: 'text', text: message }] });
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return toolError('arguments 必须为对象');
  const tool = tools.find(t => t.name === name);
  if (!tool) return toolError('未知工具');
  const allowed = tool.inputSchema.properties as Record<string, unknown>;
  const unknown = Object.keys(args).find(key => !Object.prototype.hasOwnProperty.call(allowed, key));
  if (unknown) return toolError(`不支持的参数 ${unknown}`);
  if (args.recipient!==undefined && typeof args.recipient!=='string') return toolError('recipient 必须是字符串');
  if (args.waitSeconds!==undefined && typeof args.waitSeconds!=='number') return toolError('waitSeconds 必须是数字');
  if (args.limit!==undefined && typeof args.limit!=='number') return toolError('limit 必须是整数');
  try {
    let method = 'GET';
    let path = '/api/tasks';
    let body: unknown;
    const taskId = typeof args.taskId === 'string' ? encodeURIComponent(args.taskId) : '';
    const functionId = typeof args.functionId === 'string' ? encodeURIComponent(args.functionId) : '';
    const functionPath = '/api/functions';
    const runId = typeof args.runId === 'string' ? encodeURIComponent(args.runId) : '';
    if (['task_get', 'task_update', 'task_delete', 'run_start', 'task_execute'].includes(name!) && !taskId) return toolError('缺少 taskId');
    if (['run_get', 'run_resume', 'run_cancel', 'run_result', 'run_wait', 'completion_ack'].includes(name!) && !runId) return toolError('缺少 runId');
    if (['function_get', 'function_update', 'function_delete', 'function_instantiate', 'function_call'].includes(name!) && !functionId) return toolError('缺少 functionId');
    switch (name) {
      case 'functions_list': path = functionPath; break;
      case 'function_get': path = `${functionPath}/${functionId}`; break;
      case 'function_create': method = 'POST'; path = functionPath; body = args; break;
      case 'function_update': { method = 'PATCH'; path = `${functionPath}/${functionId}`; const patch = { ...args }; delete patch.functionId; body = patch; break; }
      case 'function_delete': method = 'DELETE'; path = `${functionPath}/${functionId}`; break;
      case 'function_instantiate': method = 'POST'; path = `${functionPath}/${functionId}/instantiate`; body = {}; break;
      case 'function_call': method = 'POST'; path = `/api/functions/${functionId}/call`; body = { context: args.context === undefined ? {} : args.context }; break;
      case 'workspace_get': path = '/api/workspace'; break;
      case 'scheduler_status': path = '/api/scheduler'; break;
      case 'task_get': path += `/${taskId}`; break;
      case 'task_create': method = 'POST'; body = args; break;
      case 'task_update': { method = 'PATCH'; path += `/${taskId}`; const patch = { ...args }; delete patch.taskId; body = patch; break; }
      case 'task_delete': method = 'DELETE'; path += `/${taskId}`; break;
      case 'run_start': method = 'POST'; path += `/${taskId}/run`; body = { ...(args.context===undefined?{}:{context:args.context}), ...(args.recipient===undefined?{}:{recipient:args.recipient}) }; break;
      case 'task_execute': method = 'POST'; path += `/${taskId}/execute`; body = { ...(args.context===undefined?{}:{context:args.context}), ...(args.recipient===undefined?{}:{recipient:args.recipient}), waitSeconds: args.waitSeconds===undefined?25:args.waitSeconds }; break;
      case 'run_result': path = `/api/runs/${runId}/result`; break;
      case 'run_wait': path = `/api/runs/${runId}/result?waitSeconds=${encodeURIComponent(String(args.waitSeconds===undefined?25:args.waitSeconds))}`; break;
      case 'completions_list': { const query=new URLSearchParams(); if(args.recipient!==undefined) query.set('recipient',String(args.recipient)); if(args.limit!==undefined) query.set('limit',String(args.limit)); path=`/api/completions${query.size?'?'+query:''}`; break; }
      case 'completion_ack': method = 'POST'; path = `/api/completions/${runId}/ack`; body = { ...(args.recipient===undefined?{}:{recipient:args.recipient}) }; break;
      case 'runs_list': path = '/api/runs'; break;
      case 'run_get': path = `/api/runs/${runId}`; break;
      case 'run_resume': method = 'POST'; path = `/api/runs/${runId}/resume`; body = {}; break;
      case 'run_cancel': method = 'POST'; path = `/api/runs/${runId}/cancel`; body = {}; break;
    }
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    const response = await handleApi(new Request(new URL(path, request.url), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const payload = await response.text();
    const callFailed = ['function_call','task_execute','run_result','run_wait'].includes(name!) && response.ok && ['failed','cancelled'].includes(JSON.parse(payload).status);
    return result({ isError: !response.ok || callFailed, content: [{ type: 'text', text: payload || (response.ok ? '操作成功' : `HTTP ${response.status}`) }] });
  } catch (error) { return toolError(error instanceof Error ? error.message : '工具调用失败'); }
}

export async function GET() { return reply({ name: 'Pipeline MCP', protocol: '2026-07-28', transport: 'stateless HTTP POST', tools: tools.map(t => t.name) }); }
