#!/usr/bin/env node
// One terminal, one gateway. This process only launches the installed Claude;
// all inference traffic still travels directly from Claude to its gateway.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClaudeConfig } from "../lib/claude-config.mjs";
import { OWNER, privateRuntimeDir, processGone, sweepStaleRuns } from "../lib/claude-runs.mjs";

export { processGone, sweepStaleRuns };
// After a hangup the session has no terminal left. Claude normally exits on the
// forwarded SIGHUP; this bounds how long a client that ignores it keeps its key.
const HANGUP_GRACE_MS = 10 * 1000;

export function parseArguments(args) {
  let dir = "", providerId = "", extra = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--") { extra = args.slice(i + 1); break; }
    if (flag !== "--config-dir" && flag !== "--provider") throw new Error("用法：node claude-with-provider.mjs --config-dir <目录> --provider <ID> [-- Claude 参数]");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("缺少 " + flag + " 的值。");
    if (flag === "--config-dir") dir = value; else providerId = value;
  }
  if (!dir || !providerId) throw new Error("必须指定 --config-dir 和 --provider。");
  // A second settings source would undo the selected gateway. Model and resume
  // options still belong to Claude, but --settings belongs to this launcher.
  if (extra.some((arg) => arg === "--settings" || arg.startsWith("--settings="))) throw new Error("专属启动命令已固定 --settings，不能重复指定它。");
  return { dir: path.resolve(dir), providerId, extra };
}

export function resolveClaudeCommand(binary, env = process.env, platform = process.platform) {
  if (/\.[cm]?js$/i.test(binary)) return { file: process.execPath, args: [binary] };
  if (platform !== "win32") return { file: binary, args: [] };
  const directories = path.dirname(binary) !== "." ? [path.dirname(binary)] : String(env.Path || env.PATH || "").split(";");
  const name = path.basename(binary);
  const names = path.extname(name) ? [name] : [name + ".exe", name + ".cmd"];
  for (const directory of directories) for (const name of names) {
    const candidate = path.join(directory, name);
    if (!fs.existsSync(candidate)) continue;
    if (/\.exe$/i.test(candidate)) return { file: candidate, args: [] };
    // npm's .cmd shim cannot be spawned without cmd.exe. Resolve its package
    // entry instead, avoiding shell expansion of project paths and arguments.
    const packageDir = path.join(directory, "node_modules", "@anthropic-ai", "claude-code");
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.claude;
      const target = entry && path.join(packageDir, entry);
      // Since 2.1.283 the npm package's bin is the native bin/claude.exe that
      // its postinstall copies in; older packages point at a JavaScript entry.
      if (target && fs.existsSync(target)) return /\.exe$/i.test(target) ? { file: target, args: [] } : { file: process.execPath, args: [target] };
    } catch { /* try the next native or npm entry */ }
  }
  throw new Error("无法找到可启动的 Claude Code。请确认此终端 PATH 中有官方原生或 npm 安装的 claude。");
}

const warnToStderr = (message) => { try { process.stderr.write(message + "\n"); } catch { /* terminal gone */ } };

export async function runClaude({ dir, providerId, extra = [] }, { binary = "claude", env = process.env, stdio = "inherit", onSpawn, interactive = Boolean(process.stdin.isTTY), warn = warnToStderr } = {}) {
  const config = createClaudeConfig({ dir, revisionKey: crypto.randomBytes(32) });
  const settings = config.launchSettings(providerId);
  const runtimeDir = privateRuntimeDir(dir);
  sweepStaleRuns(runtimeDir);
  const runDir = fs.mkdtempSync(path.join(runtimeDir, "session-"));
  const ownerFile = path.join(runDir, OWNER);
  const settingsFile = path.join(runDir, "settings.json");
  const owner = { launcherPid: process.pid, startedAt: new Date().toISOString() };
  let child, hangupTimer;
  const forward = (signal) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Windows has no SIGHUP to deliver; its kill is always forceful anyway.
    try { child.kill(process.platform === "win32" && signal === "SIGHUP" ? "SIGTERM" : signal); } catch { /* already exiting */ }
  };
  const handlers = {
    // In a terminal, Ctrl+C already reaches every process in the foreground
    // group, Claude included; forwarding would make one press count as two.
    // Outside a terminal only this process receives it, so pass it on.
    SIGINT: () => { if (!interactive) forward("SIGINT"); },
    SIGTERM: () => forward("SIGTERM"),
    // Closing the terminal window. Without a handler Node exits at once and the
    // credential snapshot outlives the session.
    SIGHUP: () => {
      forward("SIGHUP");
      hangupTimer ??= setTimeout(() => forward("SIGKILL"), HANGUP_GRACE_MS);
      hangupTimer.unref();
    },
  };
  try {
    // The owner record goes first: a directory whose settings exist always
    // names the launcher that wrote them, so a later sweep can judge it.
    fs.writeFileSync(ownerFile, JSON.stringify(owner) + "\n", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(settingsFile, JSON.stringify(settings) + "\n", { flag: "wx", mode: 0o600 });
    // No shell interpolation. The launcher is invoked in the terminal where
    // Claude should work, so cwd, interactive stdio and project policies stay.
    const command = resolveClaudeCommand(binary, env);
    child = spawn(command.file, [...command.args, "--settings", settingsFile, ...extra], { env: { ...env, CLAUDE_CONFIG_DIR: dir }, stdio });
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    const exited = new Promise((resolve, reject) => {
      child.once("error", (error) => reject(new Error(`无法启动 Claude Code（${error.code || error.message}），请确认 claude 已安装且在此终端的 PATH 中。`)));
      child.once("exit", (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] || 1)));
    });
    if (child.pid) {
      try { fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, claudePid: child.pid }) + "\n", { mode: 0o600 }); }
      catch { /* the sweep still has the launcher id */ }
    }
    onSpawn?.(child, settingsFile);
    return await exited;
  } finally {
    clearTimeout(hangupTimer);
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    try { fs.rmSync(runDir, { recursive: true, force: true }); }
    catch (error) { warn(`无法删除临时凭据快照 ${runDir}（${error.code || error.message}），请在 Claude 退出后手动删除；下次启动也会重试。`); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // After a hangup the terminal is gone and writes to it fail with EIO; that
  // must not become an uncaught error that skips cleanup.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  try { process.exitCode = await runClaude(parseArguments(process.argv.slice(2))); }
  catch (error) { warnToStderr(error.message); process.exitCode = 1; }
}
