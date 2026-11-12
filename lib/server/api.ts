import { listTasks, listRuns, getTask, getRun, createTask, updateTask, deleteTask, cancelRun, listFunctions, getFunction, createFunction, updateFunction, deleteFunction, instantiateFunction, getRunResult, listCompletions, ackCompletion, reconcileCompletions } from './store';
import { ApiError, body, context, parseTask, parseFunctionDefinition, route } from './validation';
import { enqueueRun, executeRun, callFunction } from './engine';
import { openapi } from './openapi';
import { getSchedulerStatus, tickScheduler } from './scheduler';
import type { Bootstrap, Context, Run, RunTicket } from '../contracts';
import { getWorkspaceInfo } from './workspace';

function recipient(value: unknown): string {
  if (value === undefined) return 'default';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new ApiError(400, 'recipient 必须是 1–100 字符的接收者标识');
  return value.trim();
}
function waitSeconds(value: unknown, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 25) throw new ApiError(400, 'waitSeconds 必须是 0–25 之间的秒数');
  return value;
}
function executionInput(input: Context, waiting: boolean) {
  const allowed = waiting ? ['context', 'recipient', 'waitSeconds'] : ['context', 'recipient'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError(400, `执行请求仅接受 ${allowed.join('、')}`);
  return { context: input.context === undefined ? {} : context(input.context), ...(input.recipient === undefined ? {} : { recipient: recipient(input.recipient) }), waitSeconds: waiting ? waitSeconds(input.waitSeconds, 25) : 0 };
}
function ticket(run: Run): RunTicket { return { runId: run.id, taskId: run.taskId, status: run.status, resultUrl: `/api/runs/${encodeURIComponent(run.id)}/result` }; }
async function finalResult(runId: string, seconds: number, signal: AbortSignal): Promise<Response> {
  const deadline = Date.now() + seconds * 1000;
  while (true) {
    const result = await getRunResult(runId);
    if (result) return Response.json(result);
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal.aborted) {
      const current=await getRun(runId);
      if (['success','failed','cancelled'].includes(current.status)) {
        const finished=await getRunResult(runId);
        if (finished) return Response.json(finished);
      }
      return Response.json({ ...ticket(current), ready: false }, { status: 202 });
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
  }
}

export async function handleApi(request: Request): Promise<Response> {
  return route(async () => {
    const url=new URL(request.url);const parts=url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);const method=request.method;
    if (parts[0]==='health' && method==='GET') return Response.json({ok:true,service:'pipeline',version:'1.0.0'});
    if (parts[0]==='openapi.json' && method==='GET') return Response.json(openapi(url.origin));
    if (parts.length===1 && parts[0]==='workspace' && method==='GET') return Response.json(getWorkspaceInfo());
    if (parts[0]==='completions') {
      if (parts.length===1 && method==='GET') {
        if ([...url.searchParams.keys()].some(key=>!['recipient','limit'].includes(key))) throw new ApiError(400,'结果收件箱仅接受 recipient、limit 查询参数');
        const target=recipient(url.searchParams.get('recipient')??undefined);
        const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50;
        if (!Number.isInteger(limit)||limit<1||limit>100) throw new ApiError(400,'limit 必须是 1–100 之间的整数');
        await reconcileCompletions();
        return Response.json({completions:await listCompletions(target,limit)});
      }
      if (parts.length===3 && parts[2]==='ack' && method==='POST') {
        const input=context(await body(request));
        if (Object.keys(input).some(key=>key!=='recipient')) throw new ApiError(400,'确认结果仅接受 recipient');
        await reconcileCompletions();
        await ackCompletion(parts[1],recipient(input.recipient));
        return Response.json({runId:parts[1],acknowledged:true});
      }
    }
    if (parts[0]==='bootstrap' && method==='GET') {
      const [tasks,functions,runs,scheduler]=await Promise.all([listTasks(),listFunctions(),listRuns(),getSchedulerStatus()]);
      const email=request.headers.get('oai-authenticated-user-email')??''; let name=request.headers.get('oai-authenticated-user-full-name')??'';
      if (request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf8' || request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8') {try {name=decodeURIComponent(name);}catch{name='';}}
      const result:Bootstrap={tasks,functions,runs,scheduler,workspace:getWorkspaceInfo(),user:{name:name||email.split('@')[0]||'我的工作空间',email},serviceAccess:true};
      return Response.json(result);
    }
    if (parts[0]==='scheduler') {
      if (parts.length===1 && method==='GET') return Response.json(await getSchedulerStatus());
      if (parts.length===2 && parts[1]==='tick' && method==='POST') {
        if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new ApiError(403,'调度 tick 仅供本地 Runner 调用');
        const input=context(await body(request));
        if (Object.keys(input).length || url.search) throw new ApiError(400,'tick 不接受客户端参数，执行时间由服务器决定');
        return Response.json(await tickScheduler());
      }
    }
    if (parts[0]==='functions') {
      if (parts.length===1) {
        if (method==='GET') { return Response.json({functions:await listFunctions()}); }
        if (method==='POST') return Response.json(await createFunction(parseFunctionDefinition(await body(request))),{status:201});
      }
      if (parts.length===2) {
        if (method==='GET') return Response.json(await getFunction(parts[1]));
        if (method==='PATCH') {const previous=await getFunction(parts[1]);return Response.json(await updateFunction(parseFunctionDefinition(await body(request),previous),previous.version));}
        if (method==='DELETE') {await deleteFunction(parts[1]);return Response.json({deleted:true});}
      }
      if (parts.length===3 && parts[2]==='call' && method==='POST') {
        const input=context(await body(request));
        if (Object.keys(input).some(key=>key!=='context')) throw new ApiError(400,'Function 调用仅接受 context，不允许覆盖代码或执行配置');
        const overrides=input.context===undefined?{}:context(input.context);
        return Response.json(await callFunction(await getFunction(parts[1]),overrides),{status:201});
      }
      if (parts.length===3 && parts[2]==='instantiate' && method==='POST') {
        const input=context(await body(request));
        if (Object.keys(input).length) throw new ApiError(400,'Function 实例化不接受覆盖字段，请在 Task 中编辑副本');
        return Response.json(await instantiateFunction(parts[1]),{status:201});
      }
    }
    if (parts[0]==='tasks') {
      if (parts.length===1) {
        if (method==='GET') return Response.json({tasks:await listTasks()});
        if (method==='POST') return Response.json(await createTask(parseTask(await body(request))),{status:201});
      }
      if (parts.length===2) {
        if (method==='GET') return Response.json(await getTask(parts[1]));
        if (method==='PATCH') {const previous=await getTask(parts[1]);return Response.json(await updateTask(parseTask(await body(request),previous),previous.version));}
        if (method==='DELETE') {await deleteTask(parts[1]);return Response.json({deleted:true});}
      }
      if (parts.length===3 && ['run','execute'].includes(parts[2]) && method==='POST') {
        const input=executionInput(context(await body(request)),parts[2]==='execute');
        const run=await enqueueRun(await getTask(parts[1]),input.context,{...(input.recipient===undefined?{}:{recipient:input.recipient})});
        if (parts[2]==='execute') return finalResult(run.id,input.waitSeconds,request.signal);
        return Response.json(ticket(run),{status:202});
      }
    }
    if (parts[0]==='runs') {
      if (parts.length===1 && method==='GET') return Response.json({runs:await listRuns(url.searchParams.get('taskId')??undefined)});
      if (parts.length===2 && method==='GET') return Response.json(await getRun(parts[1]));
      if (parts.length===3 && parts[2]==='result' && method==='GET') {
        if ([...url.searchParams.keys()].some(key=>key!=='waitSeconds')) throw new ApiError(400,'结果查询仅接受 waitSeconds');
        const raw=url.searchParams.get('waitSeconds');
        const seconds=raw===null?0:waitSeconds(raw.trim()?Number(raw):NaN);
        return finalResult(parts[1],seconds,request.signal);
      }
      if (parts.length===3 && method==='POST') {
        if (parts[2]==='cancel') return Response.json(await cancelRun(parts[1]));
        if (parts[2]==='resume') return Response.json(await executeRun(parts[1]));
      }
    }
    throw new ApiError(404,'接口不存在，请查看 /api/openapi.json');
  },request);
}
