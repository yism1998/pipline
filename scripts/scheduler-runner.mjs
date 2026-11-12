import { fileURLToPath } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeLocalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('调度器需要有效的本地服务地址'); }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('调度器仅允许本地 HTTP 服务，不会向远程地址发送请求');
  }
  return url.origin;
}

export function portFromArgs(args, fallback) {
  let port = fallback;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') port = Number(args[++i]);
    else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('服务端口必须在 1–65535 之间');
  return port;
}

/** A process-owned loop; it never depends on an open browser or contacts a remote Site. */
export function startLocalScheduler({ origin, pollIntervalMs = 5000, timeoutMs = 45000, fetchImpl = fetch, logger = console } = {}) {
  const base = normalizeLocalOrigin(origin);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 10) throw new Error('调度检查间隔必须至少为 10ms');
  let stopped = false;
  let timer;
  let activeRequest;
  let connected = false;
  let reportedError = '';

  async function tick() {
    if (stopped) return;
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(`${base}/api/scheduler/tick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`本地调度接口 HTTP ${response.status}`);
      const result = await response.json();
      if (!result || !result.scheduler || !Array.isArray(result.started) || !Array.isArray(result.resumed)) throw new Error('本地调度接口尚未就绪');
      if (!connected) logger.info?.(`[Pipeline] 本地调度器已连接，每 ${pollIntervalMs / 1000} 秒检查一次执行规则。`);
      connected = true;
      reportedError = '';
      if (result.started.length || result.resumed.length) logger.info?.(`[Pipeline] 后台启动 ${result.started.length} 个，自动续跑 ${result.resumed.length} 个。`);
      for (const error of result.errors ?? []) logger.warn?.(`[Pipeline] 任务 ${error.taskId}：${error.message}`);
    } catch (error) {
      if (stopped) return;
      const message = error instanceof Error ? error.message : '本地服务尚未就绪';
      if (message !== reportedError) logger.warn?.(`[Pipeline] 调度器等待本地服务：${message}`);
      reportedError = message;
      connected = false;
    } finally {
      clearTimeout(timeout);
      activeRequest = undefined;
      if (!stopped) {
        timer = setTimeout(tick, pollIntervalMs);
        timer.unref?.();
      }
    }
  }

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    activeRequest?.abort();
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const origin = process.argv[2] ?? 'http://127.0.0.1:5198';
  const stop = startLocalScheduler({ origin });
  // Standalone mode owns its lifetime; imported mode follows the web server.
  const keepAlive = setInterval(() => {}, 60000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(); clearInterval(keepAlive); });
}
