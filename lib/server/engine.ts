import { env } from 'cloudflare:workers';
import type { Context, FunctionDefinition, FunctionSpec, Run, RunLog, Task } from '../contracts';
import { ApiError, context, parseRecipient } from './validation';
import { executeFunction, mergeContext, pathValue } from './functions';
import { acquireLease, getInflight, getRun, insertRun, isCancelled, markInflight, persistRun, releaseLease, database, taskDefinition } from './store';

function addLog(run: Run,level:RunLog['level'],message:string,fn?:FunctionSpec) { run.logs.push({id:crypto.randomUUID(),level,message,functionId:fn?.id,iteration:run.iteration,at:new Date().toISOString()}); }
function finish(run:Run,status:'success'|'failed') {
  const path = run.definition.result?.path;
  if (status === 'success' && path && pathValue(run.context, path) === undefined) {
    status = 'failed'; run.error = `Task 未生成约定的最终结果字段 ${path}`;
    addLog(run, 'error', run.error);
  }
  run.status=status; run.finishedAt=new Date().toISOString();
}
export function createRun(inputTask:Task,overrides:Context={}, trigger:Run['trigger']='manual', scheduledFor?:string, now=Date.now()): Run {
  const task = taskDefinition(inputTask);
  if (task.status!=='active') throw new ApiError(409,'请先将 Task 设为已启用后再执行');
  if (!task.functions.some(fn=>fn.enabled)) throw new ApiError(400,'至少需要启用一个 Function');
  const run: Run = {id:crypto.randomUUID(),taskId:task.id,taskName:task.name,taskVersion:task.version,status:'running',context:structuredClone(mergeContext(task.initialContext,overrides)),resources:[],logs:[],steps:[],iteration:1,functionIndex:0,startedAt:new Date(now).toISOString(),durationMs:0,definition:structuredClone(task),kind:'task',execution:trigger==='schedule'?'background':'inline',recipient:parseRecipient(task.result?.recipient),trigger,...(scheduledFor?{scheduledFor}:{})};
  addLog(run,'info',`开始执行 ${task.name} · v${task.version}`); return run;
}
export async function startRun(task:Task,overrides:Context={},db=database()): Promise<Run> {
  const run=createRun(task,overrides); await insertRun(run,db); return executeRun(run.id,db);
}
/** Persist a Task snapshot for the platform worker; no Function executes in the caller's request. */
export async function enqueueRun(task: Task, overrides: Context = {}, options: { recipient?: string } = {}, db = database()): Promise<Run> {
  const run = createRun(task, overrides);
  run.status = 'queued'; run.execution = 'background';
  run.recipient = parseRecipient(options.recipient, run.recipient ?? 'default');
  addLog(run, 'info', 'Task 已提交后台队列，平台将接管执行与续跑');
  await insertRun(run, db);
  return run;
}
/** A standalone Function call shares the Run engine without creating a Task definition. */
export async function callFunction(definition: FunctionDefinition, overrides: Context = {}, db = database()): Promise<Run> {
  if (!definition.enabled) throw new ApiError(409, '请先启用 Function 后再调用');
  const now = new Date().toISOString();
  const fn: FunctionSpec = { id: crypto.randomUUID(), name: definition.name, type: definition.type, enabled: true, handler: definition.handler, config: structuredClone(definition.config), retries: definition.retries, onError: 'stop', source: { id: definition.id, version: definition.version } };
  const task: Task = { id: `function-call:${crypto.randomUUID()}`, name: definition.name, description: definition.description, category: 'Function Call', status: 'active', functions: [fn], initialContext: {}, schedule: { type: 'manual' }, loop: { maxIterations: 1 }, version: definition.version, createdAt: now, updatedAt: now };
  const run = createRun(task, overrides);
  run.kind = 'function'; run.functionId = definition.id; run.functionVersion = definition.version;
  await insertRun(run, db);
  return executeRun(run.id, db);
}
export async function executeRun(id:string, db=database(), budgetMs=18_000): Promise<Run> {
  const token=crypto.randomUUID(); await acquireLease(id,token,db);
  const run=await getRun(id,db); run.status='running'; delete run.error;
  const batchStart=Date.now();
  try {
    if (await getInflight(id,db)) {
      run.error='上次请求在远程 Function 执行期间中断，结果未知。为避免重复副作用，请先检查 Runner 幂等记录，再发起新的运行。';
      addLog(run,'error',run.error); finish(run,'failed'); await persistRun(run,token,db); return run;
    }
    addLog(run,'info',run.steps.length ? '继续执行下一批次' : '执行器已取得运行锁');
    while (run.status==='running') {
      if (await isCancelled(id,db)) return getRun(id,db);
      if (run.functionIndex >= run.definition.functions.length) {
        const loop=run.definition.loop;
        if (loop.stopPath && JSON.stringify(pathValue(run.context,loop.stopPath))===JSON.stringify(loop.stopValue === undefined ? true : loop.stopValue)) { addLog(run,'info',`满足停止条件 ${loop.stopPath}`); finish(run,'success'); break; }
        if (run.iteration>=loop.maxIterations) { addLog(run,'info','全部 Function 与 Loop 执行完成'); finish(run,'success'); break; }
        run.iteration++;run.functionIndex=0;addLog(run,'info',`进入第 ${run.iteration} 轮 Loop`);
        if (!await persistRun(run,token,db)) return getRun(id,db);
      }
      if (Date.now()-batchStart>=budgetMs) { run.status='paused';addLog(run,'warn',run.execution==='background'?'本批次达到执行时间预算，已保存断点；平台会自动继续':'本批次达到执行时间预算，已保存断点；调用 resume 执行后续 Function');break; }
      const fn=run.definition.functions[run.functionIndex];
      if (!fn.enabled) { run.steps.push({functionId:fn.id,functionName:fn.name,iteration:run.iteration,status:'skipped',durationMs:0,attempt:0,at:new Date().toISOString()});run.functionIndex++; if (!await persistRun(run,token,db)) return getRun(id,db); continue; }
      const remote=fn.handler==='code.remote'||fn.handler==='agent.http';
      if (remote && budgetMs-(Date.now()-batchStart)<8_100) { run.status='paused';addLog(run,'warn','本批次剩余时间不足一次远程 Function，已保存断点');break; }
      const start=Date.now(); let success=false, error='',attempt=0;
      addLog(run,'info',`执行 Function：${fn.name}`,fn);
      // Persist the cursor before external effects and mark uncertain remote calls.
      if (!await persistRun(run,token,db)) return getRun(id,db);
      if (remote && !await markInflight(id,token,`${run.iteration}:${fn.id}`,db)) return getRun(id,db);
      for (attempt=1;attempt<=(remote?1:fn.retries+1);attempt++) {
        try {
          const result=await executeFunction(fn,{runId:run.id,iteration:run.iteration,context:run.context,resources:run.resources,secrets:(name)=>{ const value=(env as unknown as Record<string,unknown>)[name];return typeof value==='string'?value:undefined; }});
          const nextContext=result.context ? (result.replaceContext ? context(result.context) : mergeContext(run.context,result.context)) : run.context;
          if (run.resources.length+(result.resources?.length??0)>200) throw new Error('一次运行最多保存 200 个资源');
          const resources=(result.resources??[]).map(resource=>({...resource,id:crypto.randomUUID(),functionId:fn.id,iteration:run.iteration,createdAt:new Date().toISOString()}));
          if (JSON.stringify([...run.resources,...resources]).length>262_144) throw new Error('运行资源总大小不能超过 256KB');
          run.context=nextContext;run.resources.push(...resources);success=true;
          if (result.stop) {addLog(run,'info','Function 请求结束本次运行',fn);finish(run,'success');} break;
        } catch (cause) { error=cause instanceof Error?cause.message:'Function 执行失败';if (attempt<(remote?1:fn.retries+1)) addLog(run,'warn',`Function 重试 ${attempt}/${fn.retries}：${error}`,fn); }
      }
      const totalAttempts=Math.min(attempt,remote?1:fn.retries+1);
      run.steps.push({functionId:fn.id,functionName:fn.name,iteration:run.iteration,status:success?'success':'failed',durationMs:Date.now()-start,attempt:totalAttempts,...(!success?{error}:{}),at:new Date().toISOString()});
      run.functionIndex++;
      if (!success) { addLog(run,'error',error,fn); if (fn.onError==='stop') {run.error=error;finish(run,'failed');} }
      else addLog(run,'info',`Function 完成：${fn.name}`,fn);
      if (!await persistRun(run,token,db)) return getRun(id,db);
    }
    await persistRun(run,token,db); return getRun(id,db);
  } catch (error) {
    run.error=error instanceof Error?error.message:'执行器出错';addLog(run,'error',run.error);finish(run,'failed');await persistRun(run,token,db);return getRun(id,db);
  } finally {await releaseLease(id,token,db);}
}
