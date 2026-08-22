// The bash launcher had no test, and shipped two bugs in consecutive releases:
// a reused instance printed exactly what a fresh start printed, and then the
// restart command it printed named *this* launcher's directory rather than the
// running instance's — which is wrong precisely during an upgrade, the one time
// anybody reads it.
//
// Everything here drives the real script.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(projectRoot, "bin", "pi-provider-manager-ui");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function run(env) {
  return spawnSync("bash", [launcher], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: projectRoot,
    env: { ...process.env, PI_PROVIDER_MANAGER_OPEN_BROWSER: "0", ...env },
  });
}

function pidsOn(port) {
  try {
    return execFileSync("pgrep", ["-f", `PI_PROVIDER_MANAGER_PORT=${port}`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("starts, then says so rather than pretending to restart", { skip: process.platform === "win32" ? "bash launcher" : false }, async (t) => {
  if (!fs.existsSync(path.join(projectRoot, "dist", "client", "index.html"))) {
    return t.skip("built UI required; run npm run build");
  }
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-launch-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-launch-codex-"));
  const port = await freePort();
  const env = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_PROVIDER_MANAGER_CODEX_DIR: codexDir,
    PI_PROVIDER_MANAGER_PORT: String(port),
  };

  try {
    const first = run(env);
    assert.equal(first.status, 0, first.stderr);
    // The URL and both directories are unconditional: a blocked browser bridge
    // once left people with no port and no error on screen, and an unset
    // CODEX_HOME silently means the real one.
    assert.match(first.stdout, new RegExp(`ready: http://127\\.0\\.0\\.1:${port}/`));
    assert.match(first.stdout, new RegExp(`Pi config:\\s+${agentDir}`));
    assert.match(first.stdout, new RegExp(`Codex config:\\s+${codexDir}`));
    assert.equal(/reused/.test(first.stdout), false);

    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
    const pid = state.compatibility.servicePid;
    assert.ok(pid > 0, "the server reports its own process id");

    const second = run(env);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /reused the instance already running/);
    // The restart command has to name the process that is actually running.
    // Naming this launcher's own directory is wrong exactly when it matters:
    // during an upgrade the running instance lives somewhere else.
    assert.match(second.stdout, new RegExp(`kill ${pid}\\b`));
  } finally {
    for (const pid of pidsOn(port)) {
      try { process.kill(Number(pid), "SIGTERM"); } catch {}
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test("a reused instance is described by itself, not by this shell", { skip: process.platform === "win32" ? "bash launcher" : false }, async (t) => {
  if (!fs.existsSync(path.join(projectRoot, "dist", "client", "index.html"))) {
    return t.skip("built UI required; run npm run build");
  }
  const runningPi = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-launch-live-pi-"));
  const runningCodex = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-launch-live-codex-"));
  const otherPi = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-launch-other-pi-"));
  const otherCodex = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-launch-other-codex-"));
  const port = await freePort();

  try {
    assert.equal(run({
      PI_CODING_AGENT_DIR: runningPi,
      PI_PROVIDER_MANAGER_CODEX_DIR: runningCodex,
      PI_PROVIDER_MANAGER_PORT: String(port),
    }).status, 0);

    // Same port, different directories: what gets printed must describe the
    // instance holding the port, not what this invocation would have used.
    const reused = run({
      PI_CODING_AGENT_DIR: otherPi,
      PI_PROVIDER_MANAGER_CODEX_DIR: otherCodex,
      PI_PROVIDER_MANAGER_PORT: String(port),
    });
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, new RegExp(`Pi config:\\s+${runningPi}`));
    assert.match(reused.stdout, new RegExp(`Codex config:\\s+${runningCodex}`));
    assert.equal(reused.stdout.includes(otherPi), false, "this shell's directories are not the running instance's");
    assert.equal(reused.stdout.includes(otherCodex), false);
  } finally {
    for (const pid of pidsOn(port)) {
      try { process.kill(Number(pid), "SIGTERM"); } catch {}
    }
    for (const dir of [runningPi, runningCodex, otherPi, otherCodex]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
