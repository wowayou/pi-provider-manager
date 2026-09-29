import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeConfig } from "../lib/claude-config.mjs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeFollowCommand, claudeLaunchCommand } from "../lib/claude-shared.mjs";
import { parseArguments, processGone, runClaude, resolveClaudeCommand, sweepStaleRuns } from "../bin/claude-with-provider.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-claude-launch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createClaudeConfig({ dir, revisionKey: crypto.randomBytes(32) });
  config.saveProvider({ revision: config.publicState().revision, providerId: "one", name: "One", baseUrl: "https://one.example", authType: "api-key", model: "sonnet", credential: { mode: "new", value: "dummy-launch-key" }, setActive: false });
  return { dir, config };
}

test("Claude launch snapshot pins both credential slots without changing the global default", (t) => {
  const { config } = fixture(t);
  const before = config.publicState().revision;
  const snapshot = config.launchSettings("one");
  assert.equal(snapshot.env.ANTHROPIC_API_KEY, "dummy-launch-key");
  assert.equal(snapshot.env.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(snapshot.env.ANTHROPIC_MODEL, "sonnet");
  assert.equal(snapshot.permissions, undefined);
  assert.equal(snapshot.hooks, undefined);
  assert.equal(config.publicState().revision, before);
  assert.equal(fs.existsSync(config.settingsPath), false);
  assert.throws(() => config.launchSettings("missing"), /不存在/);
});

test("Claude launcher cleans up its private snapshot after spawn failure", async (t) => {
  const { dir } = fixture(t);
  let temporary;
  await assert.rejects(runClaude({ dir, providerId: "one" }, { binary: path.join(dir, "no-such-claude"), stdio: "ignore", onSpawn: (_child, file) => {
    temporary = file;
    assert.equal(JSON.parse(fs.readFileSync(file)).env.ANTHROPIC_API_KEY, "dummy-launch-key");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } }), /无法(启动|找到可启动的) Claude Code/);
  assert.equal(fs.existsSync(temporary), false);
});

test("Claude launcher passes arguments literally and removes snapshot after exit", async (t) => {
  const { dir } = fixture(t);
  const binary = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(binary, `import fs from 'node:fs';
if (process.argv[2] !== '--settings') process.exit(19);
if (!fs.existsSync(process.argv[3])) process.exit(20);
if (process.argv[4] !== 'literal;$(touch nope)') process.exit(21);
process.exit(7);`);
  let temporary;
  assert.equal(await runClaude({ dir, providerId: "one", extra: ["literal;$(touch nope)"] }, { binary, stdio: "ignore", onSpawn: (_child, file) => { temporary = file; } }), 7);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(path.join(dir, "nope")), false);
});

test("Claude launch commands quote paths for POSIX and PowerShell without credentials", () => {
  const launcher = { node: "/path with space/node", script: "/it's/$HOME/launcher.mjs", dir: "/tmp/claude", shell: "posix" };
  const command = claudeLaunchCommand(launcher, "gateway");
  assert.ok(command.includes("'/path with space/node'"));
  assert.ok(command.includes("'\\''"));
  assert.ok(command.endsWith("'--provider' 'gateway'"));
  assert.match(claudeLaunchCommand({ ...launcher, shell: "powershell" }, "gateway"), /^& /);
  assert.ok(claudeLaunchCommand({ ...launcher, shell: "powershell" }, "gateway").includes("it''s"));
  assert.throws(() => parseArguments(["--config-dir", "/tmp", "--provider", "one", "--", "--settings=secret"]), /重复/);
  assert.deepEqual(parseArguments(["--config-dir", "/tmp", "--provider", "one", "--", "-m", "opus"]).extra, ["-m", "opus"]);
});

test("Claude launcher resolves Windows native and npm entries without a command shell", (t) => {
  const { dir } = fixture(t);
  const packageDir = path.join(dir, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "claude.cmd"), "npm shim");
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ bin: { claude: "cli.js" } }));
  fs.writeFileSync(path.join(packageDir, "cli.js"), "");
  assert.deepEqual(resolveClaudeCommand("claude", { Path: dir }, "win32"), { file: process.execPath, args: [path.join(packageDir, "cli.js")] });
  fs.writeFileSync(path.join(dir, "claude.exe"), "native stub");
  assert.deepEqual(resolveClaudeCommand("claude", { Path: dir }, "win32"), { file: path.join(dir, "claude.exe"), args: [] });
});

test("Claude follow command names only a non-default config directory, quoted per shell", () => {
  const launcher = { node: "node", script: "x", dir: "/tmp/it's claude", shell: "posix" };
  assert.equal(claudeFollowCommand(launcher, "default-home"), "claude");
  assert.equal(claudeFollowCommand(launcher, "CLAUDE_CONFIG_DIR"), "CLAUDE_CONFIG_DIR='/tmp/it'\\''s claude' claude");
  assert.equal(claudeFollowCommand({ ...launcher, shell: "powershell" }, "PI_PROVIDER_MANAGER_CLAUDE_DIR"), "$env:CLAUDE_CONFIG_DIR = '/tmp/it''s claude'; claude");
  assert.equal(claudeFollowCommand(null, "default-home"), "");
});

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
}

test("stale-session sweep removes only sessions whose recorded processes are provably gone", async (t) => {
  const { dir } = fixture(t);
  const runs = path.join(dir, "pi-provider-manager-runs");
  const session = (name, owner) => {
    const runDir = path.join(runs, name); fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "settings.json"), "{}");
    if (owner) fs.writeFileSync(path.join(runDir, "owner.json"), JSON.stringify(owner));
    return runDir;
  };
  const gone = await deadPid();
  assert.equal(processGone(gone), true);
  assert.equal(processGone(process.pid), false);
  assert.equal(processGone(0), false);
  session("session-dead", { launcherPid: gone, claudePid: gone });
  session("session-launcher-dead-no-claude", { launcherPid: gone });
  session("session-live-launcher", { launcherPid: process.pid, claudePid: gone });
  session("session-live-claude", { launcherPid: gone, claudePid: process.pid });
  session("session-unowned-young");
  const old = session("session-unowned-old");
  const past = new Date(Date.now() - 60 * 60 * 1000); fs.utimesSync(old, past, past);
  session("session-bad-owner", "not json");
  fs.writeFileSync(path.join(runs, "session-bad-owner", "owner.json"), "{broken");
  fs.mkdirSync(path.join(runs, "unrelated"));
  assert.deepEqual(sweepStaleRuns(runs).sort(), ["session-dead", "session-launcher-dead-no-claude", "session-unowned-old"]);
  assert.deepEqual(fs.readdirSync(runs).sort(), ["session-bad-owner", "session-live-claude", "session-live-launcher", "session-unowned-young", "unrelated"]);
});

test("Claude launcher refuses a symlinked runtime directory instead of writing a key through it", { skip: process.platform === "win32" ? "symlink creation needs privileges on Windows" : false }, async (t) => {
  const { dir } = fixture(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-claude-elsewhere-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, path.join(dir, "pi-provider-manager-runs"));
  await assert.rejects(runClaude({ dir, providerId: "one" }, { binary: path.join(dir, "unused.mjs"), stdio: "ignore" }), /不是普通目录/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

// The real signal paths: the launcher runs as its own process, as it does in a
// terminal, and a fake `claude` on PATH records what reaches it.
function fakeClaudeOnPath(dir, { ignoreHangup = false } = {}) {
  const bin = path.join(dir, "fake-bin"); fs.mkdirSync(bin);
  const log = path.join(dir, "fake-claude.log");
  const source = `#!${process.execPath}
const fs = require("node:fs");
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
note("start " + process.pid + " " + process.argv[3]);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { note(signal); if (!(${ignoreHangup} && signal === "SIGHUP")) process.exit(signal === "SIGINT" ? 3 : 4); });
setInterval(() => {}, 1000);
`;
  fs.writeFileSync(path.join(bin, "claude"), source, { mode: 0o755 });
  return { log, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } };
}
const until = async (predicate, what, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("timed out: " + what); await new Promise((resolve) => setTimeout(resolve, 50)); }
};
const launcherPath = fileURLToPath(new URL("../bin/claude-with-provider.mjs", import.meta.url));
const readLog = (log) => fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
const sessions = (dir) => { try { return fs.readdirSync(path.join(dir, "pi-provider-manager-runs")); } catch { return []; } };

for (const [signal, expected, code] of [["SIGHUP", "SIGHUP", 4], ["SIGTERM", "SIGTERM", 4], ["SIGINT", "SIGINT", 3]]) {
  test(`Claude launcher forwards ${signal} and removes the snapshot (terminal close, kill, non-terminal Ctrl+C)`, { skip: process.platform === "win32" ? "POSIX signals" : false, timeout: 30000 }, async (t) => {
    const { dir } = fixture(t);
    const { log, env } = fakeClaudeOnPath(dir);
    const launcher = spawn(process.execPath, [launcherPath, "--config-dir", dir, "--provider", "one"], { env, stdio: ["pipe", "ignore", "pipe"] });
    t.after(() => { if (launcher.exitCode === null) launcher.kill("SIGKILL"); });
    await until(() => readLog(log).startsWith("start "), "fake claude start");
    assert.equal(sessions(dir).length, 1);
    launcher.kill(signal);
    const exitCode = await new Promise((resolve) => launcher.once("exit", resolve));
    assert.equal(exitCode, code);
    assert.match(readLog(log), new RegExp("^" + expected + "$", "m"));
    assert.equal(readLog(log).split("\n").filter((line) => /^SIG/.test(line)).length, 1, "delivered exactly once");
    assert.deepEqual(sessions(dir), []);
  });
}

test("Claude launcher force-stops a client that ignores the hangup, then cleans up", { skip: process.platform === "win32" ? "POSIX signals" : false, timeout: 40000 }, async (t) => {
  const { dir } = fixture(t);
  const { log, env } = fakeClaudeOnPath(dir, { ignoreHangup: true });
  const launcher = spawn(process.execPath, [launcherPath, "--config-dir", dir, "--provider", "one"], { env, stdio: ["pipe", "ignore", "pipe"] });
  t.after(() => { if (launcher.exitCode === null) launcher.kill("SIGKILL"); });
  await until(() => readLog(log).startsWith("start "), "fake claude start");
  launcher.kill("SIGHUP");
  const exitCode = await new Promise((resolve) => launcher.once("exit", resolve));
  assert.equal(exitCode, 128 + os.constants.signals.SIGKILL);
  assert.deepEqual(sessions(dir), []);
});

test("a force-killed launcher leaves its snapshot until Claude has also exited; the next launch removes it", { skip: process.platform === "win32" ? "POSIX signals" : false, timeout: 30000 }, async (t) => {
  const { dir } = fixture(t);
  const { log, env } = fakeClaudeOnPath(dir);
  const launcher = spawn(process.execPath, [launcherPath, "--config-dir", dir, "--provider", "one"], { env, stdio: ["pipe", "ignore", "pipe"] });
  await until(() => readLog(log).startsWith("start "), "fake claude start");
  const [orphan] = sessions(dir);
  const claudePid = Number(readLog(log).split(" ")[1]);
  await until(() => JSON.parse(fs.readFileSync(path.join(dir, "pi-provider-manager-runs", orphan, "owner.json"), "utf8")).claudePid === claudePid, "owner record names claude");
  launcher.kill("SIGKILL");
  await new Promise((resolve) => launcher.once("exit", resolve));
  t.after(() => { try { process.kill(claudePid, "SIGKILL"); } catch {} });
  // Claude survives its launcher; its snapshot must not be swept from under it.
  const quick = path.join(dir, "quick-claude.mjs"); fs.writeFileSync(quick, "process.exit(0);");
  assert.equal(await runClaude({ dir, providerId: "one" }, { binary: quick, stdio: "ignore" }), 0);
  assert.deepEqual(sessions(dir), [orphan]);
  process.kill(claudePid, "SIGTERM");
  await until(() => processGone(claudePid), "orphaned claude exit");
  assert.equal(await runClaude({ dir, providerId: "one" }, { binary: quick, stdio: "ignore" }), 0);
  assert.deepEqual(sessions(dir), []);
});

test("a terminal Ctrl+C is not forwarded twice; Claude already received it from the foreground group", async (t) => {
  const { dir } = fixture(t);
  const binary = path.join(dir, "count-sigint.mjs");
  const marker = path.join(dir, "sigint-count");
  fs.writeFileSync(binary, `import fs from "node:fs"; let n = 0; process.on("SIGINT", () => { n += 1; fs.writeFileSync(${JSON.stringify(marker)}, String(n)); }); setTimeout(() => process.exit(0), 800);`);
  const running = runClaude({ dir, providerId: "one" }, { binary, stdio: "ignore", interactive: true, onSpawn: () => setTimeout(() => process.emit("SIGINT"), 300) });
  assert.equal(await running, 0);
  assert.equal(fs.existsSync(marker), false, "interactive launcher does not re-send SIGINT");
});

// Windows has no POSIX signals and the npm install is a .cmd shim, so this is
// the path a Windows terminal actually takes: the launcher process resolves the
// shim to its JavaScript entry, passes arguments literally (no cmd.exe), keeps
// the snapshot for the session, and removes it after exit. Runs in CI's
// Windows job; the real Windows Claude binary is not installed there.
test("Windows: launcher runs an npm-shim claude from PATH with literal arguments and cleans up", { skip: process.platform === "win32" ? false : "Windows only; covered by the CI Windows job", timeout: 30000 }, async (t) => {
  const { dir } = fixture(t);
  const bin = path.join(dir, "npm global"); fs.mkdirSync(bin);
  const packageDir = path.join(bin, "node_modules", "@anthropic-ai", "claude-code");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\nexit /b 99\r\n");
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ bin: { claude: "cli.js" } }));
  const report = path.join(dir, "report.json");
  fs.writeFileSync(path.join(packageDir, "cli.js"), `const fs = require("node:fs");
const [flag, file, ...rest] = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ flag, file, rest, exists: fs.existsSync(file), settings: JSON.parse(fs.readFileSync(file, "utf8")), configDir: process.env.CLAUDE_CONFIG_DIR, cwd: process.cwd() }));
process.exit(7);`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.Path = bin + ";" + (process.env.Path || process.env.PATH || "");
  const cwd = path.join(dir, "project dir"); fs.mkdirSync(cwd);
  const launcher = spawn(process.execPath, [launcherPath, "--config-dir", dir, "--provider", "one", "--", "a & b", "%PATH%", "--model", "opus"], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; launcher.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => launcher.once("exit", resolve));
  assert.equal(exitCode, 7, stderr);
  const seen = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(seen.flag, "--settings");
  assert.equal(seen.exists, true);
  assert.deepEqual(seen.rest, ["a & b", "%PATH%", "--model", "opus"], "no shell expansion");
  assert.equal(seen.settings.env.ANTHROPIC_API_KEY, "dummy-launch-key");
  assert.equal(path.resolve(seen.configDir), path.resolve(dir));
  assert.equal(path.resolve(seen.cwd).toLowerCase(), path.resolve(cwd).toLowerCase());
  assert.equal(fs.existsSync(seen.file), false, "snapshot removed after exit");
  assert.deepEqual(sessions(dir), []);
});

// Unlike POSIX, Claude does not outlive a force-killed launcher on Windows:
// libuv assigns every non-detached child to a kill-on-close job object, so the
// launcher's death ends Claude too. The "Claude still running" branch of the
// sweep is covered by the cross-platform owner-record test above.
test("Windows: a force-killed launcher takes Claude with it, and the next launch sweeps the snapshot", { skip: process.platform === "win32" ? false : "Windows only; covered by the CI Windows job", timeout: 30000 }, async (t) => {
  const { dir } = fixture(t);
  const hold = path.join(dir, "hold-claude.mjs");
  const pidFile = path.join(dir, "claude.pid");
  fs.writeFileSync(hold, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const script = path.join(dir, "run.mjs");
  fs.writeFileSync(script, `import { runClaude } from ${JSON.stringify(new URL("../bin/claude-with-provider.mjs", import.meta.url).href)};
await runClaude({ dir: ${JSON.stringify(dir)}, providerId: "one" }, { binary: ${JSON.stringify(hold)}, stdio: "ignore" });`);
  const launcher = spawn(process.execPath, [script], { stdio: "ignore" });
  await until(() => fs.existsSync(pidFile) && sessions(dir).length === 1, "held session");
  const [orphan] = sessions(dir);
  const claudePid = Number(fs.readFileSync(pidFile, "utf8"));
  await until(() => JSON.parse(fs.readFileSync(path.join(dir, "pi-provider-manager-runs", orphan, "owner.json"), "utf8")).claudePid === claudePid, "owner record names claude");
  // Task Manager's End task: no handler runs.
  execFileSync("taskkill", ["/PID", String(launcher.pid), "/F"]);
  t.after(() => { try { execFileSync("taskkill", ["/PID", String(claudePid), "/F"], { stdio: "ignore" }); } catch {} });
  await until(() => processGone(launcher.pid), "launcher gone");
  await until(() => processGone(claudePid), "Claude ends with its launcher (kill-on-close job object)");
  assert.deepEqual(sessions(dir), [orphan], "no handler ran: the snapshot is still on disk");
  const quick = path.join(dir, "quick-claude.mjs"); fs.writeFileSync(quick, "process.exit(0);");
  assert.equal(await runClaude({ dir, providerId: "one" }, { binary: quick, stdio: "ignore" }), 0);
  assert.deepEqual(sessions(dir), []);
});
