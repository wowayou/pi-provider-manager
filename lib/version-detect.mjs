// Pi and Codex are installed, upgraded and removed outside this process, so
// their versions cannot be resolved once at startup. A manager left running
// across an upgrade would keep quoting the version the machine no longer has —
// which is precisely the reading the compatibility panel exists to give, so a
// stale one is worse than none.
//
// Detection is not free: with no npm install tree to read, it falls back to a
// login shell, which on a machine with a version manager costs the better part
// of a second. Nothing may wait on that — the launcher decides whether a port
// belongs to this manager by probing /api/state with a one-second timeout, and
// treats a slower answer as a server that failed to start. So detection is
// asynchronous, callers are always handed what is already known, and a value
// that has aged past its window is refreshed behind them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /\d+\.\d+\.\d+/;

async function runVersionCommand(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 8000,
    // On Windows both tools are installed as `.cmd` shims, which execFile cannot
    // start on its own: without a shell the panel reports "unknown" on a machine
    // where the command answers perfectly from a prompt. Measured on Windows
    // 11 / Node 22 against an installed Codex — `shell: false` fails ENOENT,
    // `shell: true` returns `codex-cli 0.144.5`. Every command and argument
    // reaching here is a constant in this file, so there is nothing a shell
    // could be talked into.
    shell: process.platform === "win32",
  });
  return stdout;
}

// A login shell first: both tools normally live in a version manager's PATH,
// which the detached server does not inherit. The bare command is the fallback
// for environments without bash, and the only form Windows gets.
function versionCommands(name, platform) {
  return platform === "win32"
    ? [[name, ["--version"]]]
    : [["/bin/bash", ["-lic", `${name} --version`]], [name, ["--version"]]];
}

async function firstVersionFrom(commands, run) {
  for (const [command, args] of commands) {
    try {
      const match = String(await run(command, args)).match(VERSION_PATTERN);
      if (match) return match[0];
    } catch {}
  }
  return "";
}

export async function detectPiVersion({
  homeDir = os.homedir(),
  platform = process.platform,
  run = runVersionCommand,
} = {}) {
  // Reading the install tree beats asking the binary: it costs no process, and
  // it still answers when this process's PATH has no `pi` on it at all.
  const nvmNodes = path.join(homeDir, ".nvm", "versions", "node");
  const installed = [];
  let nodeVersions = [];
  try {
    nodeVersions = fs.readdirSync(nvmNodes);
  } catch {}
  for (const nodeVersion of nodeVersions) {
    const manifestPath = path.join(
      nvmNodes,
      nodeVersion,
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (typeof manifest.version === "string") installed.push(manifest.version);
    } catch {}
  }
  if (installed.length > 0) {
    // Several Node versions can each carry a Pi. The newest is the one a shell
    // is most likely to run, and the only defensible single answer.
    return installed.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  }
  return (await firstVersionFrom(versionCommands("pi", platform), run)) || "unknown";
}

export async function detectCodexVersion({ platform = process.platform, run = runVersionCommand } = {}) {
  // Codex ships as a single binary rather than an npm package, so unlike Pi
  // there is no install tree to inspect — only the command itself.
  return (await firstVersionFrom(versionCommands("codex", platform), run)) || "unknown";
}

// Turns an async detector into a value the request path can read for free.
//
// `get()` never waits and never spawns: it returns the last detected version,
// and when that has aged past `ttlMs` it starts one refresh in the background —
// so the reader after an upgrade sees the old number and the next one sees the
// new, instead of every reader paying for a login shell. `ready()` resolves once
// there is something real to serve, which is what the server awaits before it
// starts listening.
export function liveVersion(detect, { ttlMs = 10_000, now = Date.now } = {}) {
  let value = "";
  // Null until a detection has settled, which is not the same as "detected long
  // ago": a fake or freshly started clock can legitimately read zero.
  let readAt = null;
  let pending = null;

  function refresh() {
    if (pending) return pending;
    // Started here and now rather than on a microtask, so one refresh is already
    // in flight by the time the caller that triggered it looks again.
    let attempt;
    try {
      attempt = Promise.resolve(detect());
    } catch (error) {
      attempt = Promise.reject(error);
    }
    pending = attempt
      .then((detected) => { if (detected) value = detected; })
      // A detector that throws has already lost its answer; stamping the clock
      // anyway is what keeps a broken PATH from being re-probed once per
      // request for as long as it stays broken.
      .catch(() => {})
      .then(() => { readAt = now(); pending = null; });
    return pending;
  }

  const stale = () => readAt === null || now() - readAt >= ttlMs;

  return {
    get() {
      if (stale()) refresh();
      return value || "unknown";
    },
    ready() {
      if (!stale()) return Promise.resolve(value || "unknown");
      return refresh().then(() => value || "unknown");
    },
  };
}
