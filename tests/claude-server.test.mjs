import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { withClaudeServer } from "./helpers/claude-server.mjs";
const body = { providerId: "router", name: "Router", baseUrl: "https://router.example", authType: "token", model: "sonnet", aliases: {}, credential: { mode: "new", value: "dummy-http-secret" }, setActive: true };

test("Claude API save/switch/delete/settings and prompts use independent revisions without returning keys", async () => {
  await withClaudeServer(async (api) => {
    const initial = await api.state();
    const response = await api.post("/api/claude/providers", body);
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.result.activated, true);
    assert.equal(saved.state.claude.activeProviderId, "router");
    assert.equal(saved.state.revision, initial.revision);
    assert.equal(saved.state.codex.revision, initial.codex.revision);
    assert.ok(!JSON.stringify(saved).includes("dummy-http-secret"));
    assert.equal(JSON.parse(fs.readFileSync(api.settingsPath)).env.ANTHROPIC_AUTH_TOKEN, "dummy-http-secret");
    const prompt = await api.post("/api/prompts", { target: "claude", slot: "claude", name: "日常", text: "Always use Chinese.", setActive: true }, saved.state.prompts.claude.revision);
    assert.equal(prompt.status, 200, await prompt.text());
    assert.equal(fs.readFileSync(path.join(api.claudeDir, "CLAUDE.md"), "utf8"), "Always use Chinese.");
    assert.equal((await api.state()).claude.revision, saved.state.claude.revision);
    assert.equal((await api.post("/api/claude/settings", { language: "Chinese", effortLevel: "high" })).status, 200);
    assert.equal((await api.post("/api/claude/providers", { ...body, providerId: "backup", setActive: false })).status, 200);
    assert.equal((await api.post("/api/claude/activate", { providerId: "backup" })).status, 200);
    assert.equal((await api.post("/api/claude/providers/delete", { providerId: "backup", replacementProviderId: "router" })).status, 200);
    assert.equal((await api.state()).claude.activeProviderId, "router");
  });
});

test("Claude API rejects cross-origin and stale writes before disk", async () => {
  await withClaudeServer(async (api) => {
    const initial = await api.state();
    const crossOrigin = await api.post("/api/claude/providers", body, initial.claude.revision, { Origin: "https://attacker.example", "Content-Type": "text/plain;charset=UTF-8" });
    assert.equal(crossOrigin.status, 415);
    const preflight = await fetch(api.url + "/api/claude/providers", { method: "OPTIONS", headers: { Origin: "https://attacker.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal(fs.existsSync(api.settingsPath), false);
    assert.equal((await api.post("/api/claude/providers", body)).status, 200);
    const snapshot = fs.readFileSync(api.settingsPath);
    for (const [route, payload] of [["providers", body], ["activate", { providerId: "router" }], ["settings", { language: "English" }], ["providers/delete", { providerId: "router" }]]) {
      assert.equal((await api.post("/api/claude/" + route, payload, initial.claude.revision)).status, 409);
      assert.deepEqual(fs.readFileSync(api.settingsPath), snapshot);
    }
  });
});

test("Claude invalid JSON disables only its target and never includes source text", async () => {
  await withClaudeServer(async (api) => {
    fs.writeFileSync(api.settingsPath, '{"ANTHROPIC_API_KEY":"do-not-echo-this-secret", bad}');
    const state = await api.state();
    assert.equal(state.claude.available, false);
    assert.ok(!JSON.stringify(state).includes("do-not-echo-this-secret"));
    assert.equal(state.codex.available, true);
    assert.deepEqual(state.providers, []);
  });
});

// A forced kill leaves a credential snapshot behind. Starting the manager
// removes the ones whose recorded processes are gone, keeps a live one, and
// never follows a symlinked runtime directory.
test("manager startup sweeps snapshots left by a forced kill and keeps live sessions", async () => {
  const { spawnSync } = await import("node:child_process");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  const session = (claudeDir, name, owner) => {
    const runDir = path.join(claudeDir, "pi-provider-manager-runs", name);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "settings.json"), '{"env":{"ANTHROPIC_API_KEY":"dummy-orphan"}}');
    fs.writeFileSync(path.join(runDir, "owner.json"), JSON.stringify(owner));
  };
  await withClaudeServer(async (api) => {
    const runs = path.join(api.claudeDir, "pi-provider-manager-runs");
    assert.deepEqual(fs.readdirSync(runs), ["session-live"]);
  }, undefined, (claudeDir) => {
    session(claudeDir, "session-orphan", { launcherPid: gone, claudePid: gone });
    session(claudeDir, "session-live", { launcherPid: gone, claudePid: process.pid });
  });
});

test("manager startup never follows a symlinked runtime directory", { skip: process.platform === "win32" ? "symlink creation needs privileges on Windows" : false }, async () => {
  const os = await import("node:os");
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-claude-sweep-elsewhere-"));
  try {
    fs.mkdirSync(path.join(elsewhere, "session-bait"));
    fs.writeFileSync(path.join(elsewhere, "session-bait", "owner.json"), JSON.stringify({ launcherPid: 999999999 }));
    await withClaudeServer(async () => {
      assert.deepEqual(fs.readdirSync(elsewhere), ["session-bait"]);
    }, undefined, (claudeDir) => fs.symlinkSync(elsewhere, path.join(claudeDir, "pi-provider-manager-runs")));
  } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
});
