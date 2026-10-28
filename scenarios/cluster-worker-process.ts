import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function spawnWorkerProcess(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const compiledEntry = resolve(process.cwd(), "dist/worker/main.js");
  const useCompiled = import.meta.url.endsWith(".js") && existsSync(compiledEntry);
  const args = useCompiled
    ? [compiledEntry]
    : ["./node_modules/tsx/dist/cli.mjs", "worker/main.ts"];
  const forwardLogs = env["AGBOSS_LOG_WORKERS"] === "true";

  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    let errBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (forwardLogs) {
        process.stderr.write(`[worker:${String(child.pid)}] ${text}`);
      }
      if (!ready && text.includes("WORKER_READY")) {
        ready = true;
        resolveWorker(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      errBuf += text;
      if (forwardLogs) {
        process.stderr.write(`[worker:${String(child.pid)}] ${text}`);
      }
    });
    child.once("error", (err) => !ready && rejectWorker(err));
    child.once("exit", (code) => {
      if (!ready) {
        rejectWorker(
          new Error(`Worker exited before ready (code=${String(code)}): ${errBuf}`),
        );
      }
    });
  });
}

export async function stopWorkerProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      child.kill("SIGCONT");
    } catch {
      // Ignore if not stopped.
    }
    child.kill("SIGTERM");
  });
}
