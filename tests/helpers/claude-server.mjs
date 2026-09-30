import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export async function withClaudeServer(run, settings, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-claude-server-"));
  const claudeDir = path.join(dir, "claude"); fs.mkdirSync(claudeDir);
  const settingsPath = path.join(claudeDir, "settings.json");
  if (settings) fs.writeFileSync(settingsPath, JSON.stringify(settings));
  prepare?.(claudeDir);
  const port = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  const url = "http://127.0.0.1:" + port;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_PROVIDER_MANAGER_")) delete env[key];
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], { cwd: root, env: { ...env, PI_CODING_AGENT_DIR: path.join(dir, "pi"), PI_PROVIDER_MANAGER_CODEX_DIR: path.join(dir, "codex"), PI_PROVIDER_MANAGER_CLAUDE_DIR: claudeDir, PI_PROVIDER_MANAGER_PORT: String(port), PI_PROVIDER_MANAGER_SERVE_UI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stderr.on("data", (chunk) => { output += chunk; }); child.stdout.on("data", (chunk) => { output += chunk; });
  const api = { dir, claudeDir, settingsPath, url, async state() { const response = await fetch(url + "/api/state"); assert.equal(response.status, 200); return response.json(); }, async post(route, body, revision, headers = {}) { const current = revision === undefined ? (await api.state()).claude.revision : revision; return fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ ...body, revision: current }) }); } };
  try {
    const until = Date.now() + 15000;
    for (;;) {
      try { await api.state(); break; } catch { if (Date.now() > until) throw new Error("Claude test server did not start: " + output); await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    await run(api);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
