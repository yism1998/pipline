/**
 * Trusted-code runner reference for code.remote functions.
 * Requires Node >= 22.13. Put behind an HTTPS reverse proxy for hosted use.
 * node:vm and worker_threads are NOT a security boundary for untrusted code.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRunWorkspace, prepareWorkspace, resolveWorkspace } from '../scripts/workspace.mjs';

const entryPattern = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;

/** Only this server-owned registry can associate a Function entry with a file. */
export async function loadFunctionModules(registryPath) {
  if (!registryPath) return {};
  const path = resolve(registryPath);
  const registry = JSON.parse(await readFile(path, 'utf8'));
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Module registry must be a JSON object');
  const modules = {};
  for (const [entry, specifier] of Object.entries(registry)) {
    if (!entryPattern.test(entry) || typeof specifier !== 'string' || !specifier.trim()) throw new Error(`Invalid module binding: ${entry}`);
    const hash = specifier.lastIndexOf('#');
    const file = hash < 0 ? specifier : specifier.slice(0, hash);
    const exportName = hash < 0 ? 'default' : specifier.slice(hash + 1);
    if (!file || !/^[A-Za-z_$][\w$]*$/.test(exportName)) throw new Error(`Invalid file or export for ${entry}`);
    modules[entry] = { url: pathToFileURL(resolve(dirname(path), file)).href, exportName };
  }
  return modules;
}

const workerSource = `
  const { parentPort, workerData } = require('node:worker_threads');
  const vm = require('node:vm');
  const { fn, context, resources, iteration, runId, binding, workspace } = workerData;
  async function execute() {
    if (binding) {
      const module = await import(binding.url);
      const handler = module[binding.exportName];
      if (typeof handler !== 'function') throw new Error('Registered module export must be a function');
      return handler({ context, resources, fn, iteration, runId, workspace });
    }
    const sandbox = vm.createContext({ context, resources, fn, iteration, runId, workspace });
    const script = new vm.Script('(async () => { "use strict"; \\n' + fn.config.code + '\\n})()');
    return script.runInContext(sandbox, { timeout: 3000 });
  }
  execute()
    .then(value => parentPort.postMessage({ ok: true, value: JSON.parse(JSON.stringify(value)) }))
    .catch(error => parentPort.postMessage({ ok: false, error: String(error.message || error) }));
`;

function authorized(request, token) {
  const supplied = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Request body exceeds 256 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function execute(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: payload,
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Code runner timed out after 5 seconds')), 5000);
    worker.once('message', message => finish(message.ok ? null : new Error(message.error), message.value));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Runner exited before a result (exit ${code})`)); });
  });
}

export function createFunctionRunner({ token, modules = {}, workspace }) {
  if (!token || token.length < 16) throw new Error('Set FUNCTION_RUNNER_TOKEN or PIPELINE_RUNNER_TOKEN to a secret with at least 16 characters before starting.');
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/functions/code') return json(response, 404, { error: 'POST /functions/code required' });
    if (!authorized(request, token)) return json(response, 401, { error: 'Unauthorized' });
    try {
    const payload = await readBody(request);
    const fn = payload.fn;
    if (fn?.handler !== 'code.remote' || !fn?.config) {
      return json(response, 400, { error: 'A code.remote function is required' });
    }
    const { code, entry } = fn.config;
    const hasCode = typeof code === 'string' && !!code.trim();
    const hasEntry = typeof entry === 'string' && !!entry.trim();
    if ((code !== undefined && !hasCode) || (entry !== undefined && !hasEntry) || hasCode === hasEntry) return json(response, 400, { error: 'Specify exactly one of config.code or config.entry' });
    let binding;
    if (hasEntry) {
      if (!entryPattern.test(entry) || !Object.prototype.hasOwnProperty.call(modules, entry)) return json(response, 400, { error: 'Function entry is not registered in this Runner' });
      binding = modules[entry];
    }
    if (!payload.context || typeof payload.context !== 'object' || Array.isArray(payload.context)) {
      return json(response, 400, { error: 'context must be a JSON object' });
    }
    const runWorkspace = workspace ? prepareRunWorkspace(workspace, payload.runId) : undefined;
    const result = await execute({ ...payload, fn, binding, workspace: runWorkspace });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Code must return an object');
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new Error('Result exceeds 64 KiB');
    return json(response, 200, result);
    } catch (error) {
      return json(response, 422, { error: String(error.message || error) });
    }
  });
  server.requestTimeout = 10_000;
  return server;
}

export async function startFunctionRunner() {
  const port = Number(process.env.FUNCTION_RUNNER_PORT || 8789);
  const workspace = prepareWorkspace(resolveWorkspace());
  const modules = await loadFunctionModules(workspace.registryPath);
  const server = createFunctionRunner({ token: process.env.FUNCTION_RUNNER_TOKEN || process.env.PIPELINE_RUNNER_TOKEN, modules, workspace });
  server.listen(port, '127.0.0.1', () => console.log(`Trusted Function runner: http://127.0.0.1:${server.address().port}/functions/code (${Object.keys(modules).length} registered modules)`));
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await startFunctionRunner();
