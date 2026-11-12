import type { Context, FunctionSpec, Json, Resource } from '../contracts';
import { ApiError, context, safeJson } from './validation';

/** Every executor receives an isolated input and returns a context patch and resources. */
export type FunctionExecutionContext = {
  runId: string; iteration: number; context: Context; resources: Resource[];
  secrets: (name: string) => string | undefined; signal?: AbortSignal;
};
export type FunctionExecutionResult = { context?: Context; replaceContext?: boolean; resources?: {name:string; type:string; value:Json}[]; stop?: boolean };
export interface FunctionExecutor { execute(fn: FunctionSpec, input: FunctionExecutionContext): Promise<FunctionExecutionResult> }
export class FunctionError extends Error { constructor(message: string, public uncertain = false) { super(message); } }

export function pathValue(value: Json | Context, path: string): Json | undefined {
  const keys = path.split('.'); let current: unknown = value;
  for (const key of keys) {
    if (['__proto__','prototype','constructor'].includes(key) || !current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current,key)) return undefined;
    current = (current as Record<string,unknown>)[key];
  }
  return current as Json | undefined;
}
export function mergeContext(target: Context, patch: Context): Context {
  const result: Context = {...target};
  for (const [key,value] of Object.entries(patch)) {
    const old = result[key];
    result[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && old !== null && typeof old === 'object' && !Array.isArray(old) ? mergeContext(old,value) : value;
  }
  return context(result);
}
function resolve(value: Json, input: FunctionExecutionContext): Json {
  if (typeof value === 'string') {
    if (value === '{{context}}') return structuredClone(input.context);
    if (value === '{{iteration}}') return input.iteration;
    if (value === '{{runId}}') return input.runId;
    const match = /^\{\{context\.([^}]+)\}\}$/.exec(value);
    if (match) return pathValue(input.context,match[1]) ?? null;
    return value.replace(/\{\{iteration\}\}/g,String(input.iteration)).replace(/\{\{runId\}\}/g,input.runId).replace(/\{\{context\.([^}]+)\}\}/g,(_,path) => String(pathValue(input.context,path) ?? ''));
  }
  if (Array.isArray(value)) return value.map(item => resolve(item,input));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,resolve(item,input)]));
  return value;
}
function text(value: Json | undefined, fallback = '') { return typeof value === 'string' ? value : fallback; }
export function publicEndpoint(value: Json | undefined): URL {
  if (typeof value !== 'string' || !value.trim()) throw new FunctionError('请先配置 Function 的 HTTPS endpoint');
  let url: URL; try { url = new URL(value); } catch { throw new FunctionError('endpoint URL 不合法'); }
  const host = url.hostname.toLowerCase().replace(/\.$/,'');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !host.includes('.') || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) || /(^|\.)(localhost|local|internal|test|invalid|onion|arpa|home)$/.test(host)) throw new FunctionError('endpoint 必须是公开域名的 HTTPS 地址，不能使用内网/IP地址');
  return url;
}
/** A server-owned allowlist enables a loopback Runner without exposing arbitrary LAN access. */
export function runnerEndpoint(value: Json | undefined, localOrigin?: string): URL {
  if (localOrigin) {
    let allowed: URL;
    try { allowed = new URL(localOrigin); } catch { throw new FunctionError('PIPELINE_LOCAL_RUNNER_ORIGIN 必须是本机 HTTP origin'); }
    if (allowed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(allowed.hostname) || allowed.username || allowed.password || allowed.pathname !== '/' || allowed.search || allowed.hash) {
      throw new FunctionError('PIPELINE_LOCAL_RUNNER_ORIGIN 只能包含本机 HTTP origin，例如 http://127.0.0.1:8789');
    }
    if (typeof value === 'string') {
      let endpoint: URL | undefined;
      try { endpoint = new URL(value); } catch { /* publicEndpoint reports the normal validation error. */ }
      if (endpoint && endpoint.origin === allowed.origin && !endpoint.username && !endpoint.password && !endpoint.hash) return endpoint;
    }
  }
  return publicEndpoint(value);
}
async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new FunctionError('Runner 返回了空响应');
  const reader = response.body.getReader(); let bytes=0; const chunks: Uint8Array[]=[];
  try {
    while (true) { const next=await reader.read(); if (next.done) break; bytes+=next.value.byteLength; if (bytes>65_536) { await reader.cancel(); throw new FunctionError('Runner 响应超过 64KB'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes); let offset=0; for (const chunk of chunks) { all.set(chunk,offset); offset+=chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw new FunctionError('Runner 必须返回 JSON'); }
}
const remote: FunctionExecutor = { async execute(fn,input) {
  const endpoint = runnerEndpoint(fn.config.endpoint, input.secrets('PIPELINE_LOCAL_RUNNER_ORIGIN'));
  const headers: Record<string,string> = {'Content-Type':'application/json','Idempotency-Key':`${input.runId}:${input.iteration}:${fn.id}`};
  const secretName = text(fn.config.secretEnv);
  if (secretName) {
    if (!/^PIPELINE_[A-Z0-9_]{1,80}$/.test(secretName)) throw new FunctionError('secretEnv 必须以 PIPELINE_ 开头');
    const secret = input.secrets(secretName); if (!secret) throw new FunctionError(`未配置服务端密钥 ${secretName}`);
    headers.Authorization=`Bearer ${secret}`;
  }
  const controller = new AbortController(); const timeout=setTimeout(()=>controller.abort(),8_000);
  try {
    let response: Response;
    try { response = await fetch(endpoint,{method:'POST',headers,redirect:'manual',signal:controller.signal,body:JSON.stringify({fn:{id:fn.id,name:fn.name,type:fn.type,handler:fn.handler,config:fn.config},context:input.context,resources:input.resources,iteration:input.iteration,runId:input.runId,code:fn.config.code,entry:fn.config.entry,prompt:fn.config.prompt})}); }
    catch { throw new FunctionError('远程调用中断或超过 8 秒；执行结果未知，请检查 Runner 日志。平台不会自动重试此调用。',true); }
    if (!response.ok) throw new FunctionError(`Runner 返回 HTTP ${response.status}，请检查服务端日志`);
    const data = context(await responseJson(response));
    const output: FunctionExecutionResult={};
    if (data.context !== undefined) output.context=context(data.context);
    if (data.stop !== undefined) { if (typeof data.stop !== 'boolean') throw new FunctionError('Runner stop 必须是布尔值'); output.stop=data.stop; }
    if (data.resources !== undefined) {
      if (!Array.isArray(data.resources) || data.resources.length>20) throw new FunctionError('Runner resources 必须是数组，最多 20 项');
      output.resources = data.resources.map(item => {
        const resource=context(item); if (typeof resource.name!=='string' || !resource.name.trim() || resource.name.length>120 || typeof resource.type!=='string' || resource.type.length>80 || resource.value===undefined) throw new FunctionError('资源必须有 name、type、value');
        return {name:resource.name,type:resource.type,value:resource.value};
      });
    }
    return output;
  } finally { clearTimeout(timeout); }
} };

/** Register new server-owned executors here; user code executes only in an independent runner. */
export const functionExecutors: Record<FunctionSpec['handler'],FunctionExecutor> = {
  'context.set': { async execute(fn,input) { return {context:{...input.context,...context(resolve(fn.config.values ?? {},input))},replaceContext:true}; } },
  'context.merge': { async execute(fn,input) { return {context:mergeContext(input.context,context(resolve(fn.config.values ?? {},input))),replaceContext:true}; } },
  'counter.increment': { async execute(fn,input) {
    const key=text(fn.config.key,'count'); if (!key || key.includes('.') || ['__proto__','prototype','constructor'].includes(key)) throw new FunctionError('计数器 key 必须是合法顶层字段名');
    const previous=input.context[key] ?? 0, amount=fn.config.amount ?? 1;
    if (typeof previous!=='number' || typeof amount!=='number' || !Number.isFinite(previous+amount)) throw new FunctionError('计数器当前值和 amount 必须是有效数字');
    return {context:{[key]:previous+amount}};
  } },
  'resource.add': { async execute(fn,input) { return {resources:[{name:text(resolve(fn.config.name ?? '资源 {{iteration}}',input),'资源'),type:text(fn.config.type,'json'),value:resolve(fn.config.value ?? '{{context}}',input)}]}; } },
  'code.remote': remote, 'agent.http': remote,
};

export async function executeFunction(fn: FunctionSpec,input: FunctionExecutionContext): Promise<FunctionExecutionResult> {
  safeJson(fn.config); context(input.context);
  const executor=functionExecutors[fn.handler]; if (!executor) throw new ApiError(400,'未注册的 Function handler');
  return executor.execute(fn,{...input,context:structuredClone(input.context),resources:structuredClone(input.resources)});
}
