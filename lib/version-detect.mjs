// Pi and Codex are installed, upgraded and removed outside this process, so
// their versions cannot be resolved once at startup. A manager left running
// across an upgrade would keep quoting the version the machine no longer has —
// which is precisely the reading the compatibility panel exists to give, so a
// stale one is worse than none.
//
// Detection is not free: it asks a login shell, which on a machine with a
// version manager costs the better part of a second. Nothing may wait on that —
// the launcher decides whether a port belongs to this manager by probing
// /api/state with a one-second timeout, and
// treats a slower answer as a server that failed to start. So detection is
// asynchronous, callers are always handed what is already known, and a value
// that has aged past its window is refreshed behind them.

import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// A login shell may print its own startup diagnostics before the command's
// answer (for example, an Ubuntu/WSL banner with `24.04.4`).  Taking the first
// semver from the whole stream can therefore report the operating system as
// Pi's version.  Prefer a line that names the command, then a line containing
// only the version that `pi --version` and `codex --version` normally emit.
function parseVersion(output, name) {
  const lines = String(output).split(/\r?\n/);
  const namedPattern = new RegExp(`(?:^|\\s)${name}(?:-cli)?(?=\\s|[:)]|$)[^\\d]*(\\d+\\.\\d+\\.\\d+)`, "i");
  for (const line of lines) {
    const match = line.match(namedPattern);
    if (match) return match[1];
  }
  for (const line of lines) {
    const match = line.match(/^\s*v?(\d+\.\d+\.\d+)\s*$/i);
    if (match) return match[1];
  }
  // Do not guess from a version embedded in unrelated shell text: if the
  // command did not emit a named or standalone version, it is unknown.
  return "";
}

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

async function firstVersionFrom(name, commands, run) {
  for (const [command, args] of commands) {
    try {
      const version = parseVersion(await run(command, args), name);
      if (version) return version;
    } catch {}
  }
  return "";
}

export async function detectPiVersion({ platform = process.platform, run = runVersionCommand } = {}) {
  // Ask the command the user's shell selects, not the newest npm manifest in
  // ~/.nvm: an inactive install can survive a move to Pi's managed installer
  // or another package manager. A fresh shell also has no parent Bash hash.
  return (await firstVersionFrom("pi", versionCommands("pi", platform), run)) || "unknown";
}

export async function detectCodexVersion({ platform = process.platform, run = runVersionCommand } = {}) {
  return (await firstVersionFrom("codex", versionCommands("codex", platform), run)) || "unknown";
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
