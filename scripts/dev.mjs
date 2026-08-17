import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const viteArgs = process.argv.slice(2);

const backend = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
  cwd: projectRoot,
  stdio: "inherit",
});

const frontend = spawn(process.execPath, [viteBin, ...viteArgs], {
  cwd: projectRoot,
  stdio: "inherit",
});

let shuttingDown = false;
function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!backend.killed) backend.kill(signal);
  if (!frontend.killed) frontend.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

backend.on("exit", (code) => {
  if (!shuttingDown) {
    shutdown();
    process.exitCode = code ?? 1;
  }
});

frontend.on("exit", (code) => {
  if (!shuttingDown) {
    shutdown();
    process.exitCode = code ?? 0;
  }
});
