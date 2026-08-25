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

import { builtUiProblem } from "./helpers/built-ui.mjs";
import { installLauncher } from "../scripts/install-launcher.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(projectRoot, "bin", "pi-provider-manager-ui");

// The launcher only needs *a* bundle to serve, so a missing one is a skip. A
// stale one is a mistake in this checkout, and staying silent about it is how
// the UI suite once failed on selectors that had nothing to do with the bug.
function builtUiGate(t) {
  const problem = builtUiProblem();
  if (!problem) return false;
  if (problem.kind === "stale") throw new Error(problem.message);
  t.skip(problem.message);
  return true;
}

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

// The launcher passes the port through the environment, not the command line,
// so `pgrep -f PI_PROVIDER_MANAGER_PORT=...` never matched the detached server
// it was meant to find: it searches argv only. Cleanup silently did nothing and
// every run of this file leaked two background servers. Read the environment.
function pidsOn(port) {
  const needle = `PI_PROVIDER_MANAGER_PORT=${port}\0`;
  if (fs.existsSync("/proc")) {
    return fs.readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .filter((pid) => {
        try {
          return fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(needle);
        } catch {
          // Exited between listing and reading, or owned by someone else.
          return false;
        }
      });
  }
  // No procfs (macOS): `ps -E` prints the environment after the command.
  //
  // UNVERIFIED. This branch was written on WSL2, where procfs always exists, so
  // it has never actually run. `ps -E` is a BSD extension that Linux's ps does
  // not accept, which is why it cannot be exercised here either. If cleanup on
  // macOS leaves servers behind, check this first: the column layout of
  // `ps -Awwo pid=,command= -E` is the assumption most likely to be wrong.
  try {
    return execFileSync("ps", ["-Awwo", "pid=,command=", "-E"], { encoding: "utf8" })
      .split("\n")
      // Anchored at the end so port 5740 does not match 57404.
      .filter((line) => new RegExp(`PI_PROVIDER_MANAGER_PORT=${port}(\\s|$)`).test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}


// The checks below all run before the bundle check, so they need a project
// directory rather than a whole checkout. Writing one keeps them independent of
// whether this machine has run a build.
function fixtureProject(t, manifest = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-launch-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "pi-provider-manager-ui", ...manifest }),
  );
  return dir;
}

test("starts, then says so rather than pretending to restart", { skip: process.platform === "win32" ? "bash launcher" : false }, async (t) => {
  if (builtUiGate(t)) return;
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
  if (builtUiGate(t)) return;
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

// Everything below is about the launcher being usable by someone who has not
// read its source. Each test is here because the failure it pins was reachable
// by following the README exactly.

test("names every place it looks when it cannot find the checkout", { skip: process.platform === "win32" ? "bash launcher" : false }, () => {
  // Printing only the path it settled on left the reader unable to tell which
  // mechanism had chosen it, and therefore which one to correct.
  const attempt = spawnSync("bash", [launcher], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      PI_PROVIDER_MANAGER_OPEN_BROWSER: "0",
      PI_PROVIDER_MANAGER_PROJECT_DIR: path.join(os.tmpdir(), "ppm-does-not-exist"),
    },
  });

  assert.equal(attempt.status, 1);
  assert.match(attempt.stderr, /PI_PROVIDER_MANAGER_PROJECT_DIR/);
  assert.match(attempt.stderr, /the current directory/);
  assert.match(attempt.stderr, /the directory above this script/);
  assert.match(attempt.stderr, /\$HOME\/pi-provider-manager-ui/);
  // And both ways out, not just the diagnosis.
  assert.match(attempt.stderr, /PI_PROVIDER_MANAGER_PROJECT_DIR=\/path\/to\/checkout/);
  assert.match(attempt.stderr, /npm run install:launcher/);
});

test("refuses a Node older than the manifest declares", { skip: process.platform === "win32" ? "bash launcher" : false }, (t) => {
  // The floor lives in package.json's engines field and is read from there, so
  // this asserts the reading, not a number copied into the launcher. Below the
  // floor the alternative is a syntax error from inside the server, which names
  // neither Node nor its version.
  const project = fixtureProject(t, { engines: { node: ">=999" } });
  const refused = run({ PI_PROVIDER_MANAGER_PROJECT_DIR: project });

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /needs 999 or newer/);
  assert.match(refused.stderr, /PI_PROVIDER_MANAGER_NODE/);

  // A manifest with no floor must not invent one, or every future Node becomes
  // a refusal the moment engines is dropped.
  const unbounded = run({ PI_PROVIDER_MANAGER_PROJECT_DIR: fixtureProject(t) });
  assert.equal(/too old/.test(unbounded.stderr), false, unbounded.stderr);
});

test("a launcher copied out of the checkout says so before starting", { skip: process.platform === "win32" ? "bash launcher" : false }, (t) => {
  // The trap this warns about shipped: a pre-0.3.0 copy still starts, it just
  // stops handing the Codex directory and the LiteLLM path to the detached
  // server, so the managed bridge breaks with nothing pointing at the launcher.
  const project = fixtureProject(t);
  fs.mkdirSync(path.join(project, "bin"));
  fs.writeFileSync(path.join(project, "bin", "pi-provider-manager-ui"), "#!/usr/bin/env bash\n# a newer launcher\n");

  const stale = run({ PI_PROVIDER_MANAGER_PROJECT_DIR: project });
  assert.match(stale.stderr, /not the one in the checkout/);
  assert.match(stale.stderr, new RegExp(`checkout: ${path.join(project, "bin", "pi-provider-manager-ui")}`));
  assert.match(stale.stderr, /npm run install:launcher/);

  // No version number is compared, so the same content must be silent — and
  // this is the ordinary case: running the checkout's own launcher.
  const own = run({ PI_PROVIDER_MANAGER_PROJECT_DIR: projectRoot, PI_PROVIDER_MANAGER_PORT: "not-a-port" });
  assert.equal(/not the one in the checkout/.test(own.stderr), false, own.stderr);
});

test("installing puts a shim in place, never a copy that can go stale", { skip: process.platform === "win32" ? "POSIX shim" : false }, (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-install-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  const first = installLauncher({ env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(first.destination, path.join(agentDir, "bin", "pi-provider-manager-ui"));
  assert.equal(first.replaced, null);
  assert.equal(fs.statSync(first.destination).mode & 0o777, 0o700, "same 0700 this project writes everywhere else");

  // The distinction the whole design rests on: it must not be the launcher's
  // body, or it is a copy again and goes stale with the next pull.
  const shim = fs.readFileSync(first.destination, "utf8");
  const real = fs.readFileSync(launcher, "utf8");
  assert.equal(shim.includes("PI_PROVIDER_MANAGER_SERVE_UI"), false, "not a copy of the launcher");
  assert.ok(shim.length < real.length / 4, `shim is ${shim.length} bytes against the launcher's ${real.length}`);
  assert.match(shim, new RegExp(`exec "\\$launcher"`));
  assert.ok(shim.includes(projectRoot), "it names the checkout it runs");

  // Reinstalling is how someone recovers from a stale copy, so it has to be
  // idempotent rather than an error.
  assert.equal(installLauncher({ env: { PI_CODING_AGENT_DIR: agentDir } }).replaced, "shim");
  fs.writeFileSync(first.destination, real);
  assert.equal(installLauncher({ env: { PI_CODING_AGENT_DIR: agentDir } }).replaced, "copy");

  // Something that is not ours is not silently overwritten. This is a file in
  // the user's own bin directory; guessing wrong destroys their script.
  fs.writeFileSync(first.destination, "#!/bin/sh\necho not ours\n");
  assert.throws(
    () => installLauncher({ env: { PI_CODING_AGENT_DIR: agentDir } }),
    /Pass --force/,
  );
  assert.equal(fs.readFileSync(first.destination, "utf8"), "#!/bin/sh\necho not ours\n", "and it really did not write");
  assert.equal(installLauncher({ env: { PI_CODING_AGENT_DIR: agentDir }, force: true }).replaced, "copy");
});

test("the installed shim runs the checkout's launcher, not its own logic", { skip: process.platform === "win32" ? "POSIX shim" : false }, (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-shim-run-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const { destination } = installLauncher({ env: { PI_CODING_AGENT_DIR: agentDir } });

  // A rejected port proves the exec reached the real launcher without starting
  // a server: the message exists nowhere in the shim.
  const through = spawnSync("bash", [destination], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PI_PROVIDER_MANAGER_OPEN_BROWSER: "0", PI_PROVIDER_MANAGER_PORT: "70000" },
  });
  assert.equal(through.status, 1);
  assert.match(through.stderr, /PI_PROVIDER_MANAGER_PORT must be an integer/);
  assert.equal(/not the one in the checkout/.test(through.stderr), false, "a shim is not a stale copy");

  // And it reports the loss rather than execing a path that is gone.
  fs.writeFileSync(destination, fs.readFileSync(destination, "utf8").replace(projectRoot, path.join(os.tmpdir(), "ppm-moved-away")));
  const moved = spawnSync("bash", [destination], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_PROVIDER_MANAGER_OPEN_BROWSER: "0" } });
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /no longer at/);
  assert.match(moved.stderr, /npm run install:launcher/);
});
