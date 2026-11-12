import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";
import { portFromArgs, startLocalScheduler } from "./scheduler-runner.mjs";
import { prepareWorkspace, resolveWorkspace, workspaceBindings } from "./workspace.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) throw new Error("Expected dev, build, or start.");
const managedLinux = readExecutionProfile() === "managed-linux";
const workspace = resolveWorkspace();
if (command !== 'build') prepareWorkspace(workspace);

if (command === "start") {
  const port = portFromArgs(args, 8787);
  const child = spawn(process.execPath, [
    "--import", fileURLToPath(new URL("./sites-env.mjs", import.meta.url)),
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", workspace.statePath,
    ...Object.entries(workspaceBindings(workspace)).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
    "--ip", "127.0.0.1", "--inspector-port", "0",
    ...(!args.some(arg => arg === "--port" || arg === "-p" || arg.startsWith("--port=")) ? ["--port", String(port)] : []), ...args,
  ], { stdio: "inherit", env: process.env });
  const stop = process.env.PIPELINE_DISABLE_SCHEDULER === "1" ? () => {} : startLocalScheduler({ origin: `http://127.0.0.1:${port}` });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop(); child.kill(signal); });
  child.once("error", error => { stop(); console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { stop(); process.exitCode = code ?? (signal ? 1 : 0); });
} else {

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../node_modules/vite/bin/vite.js"
  : "../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
if (command === "dev" && process.env.PIPELINE_DISABLE_SCHEDULER !== "1") {
  const port = portFromArgs(args, 5173);
  const stop = startLocalScheduler({ origin: `http://127.0.0.1:${port}` });
  process.once("exit", stop);
}
await import(cli.href);
}
