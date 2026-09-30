import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeConfig } from "../lib/claude-config.mjs";

const KEY = "dummy-claude-secret-never-returned";
const payload = (extra = {}) => ({ providerId: "gateway", name: "Gateway", baseUrl: "https://gateway.example", authType: "token", model: "sonnet", aliases: { sonnet: "relay-sonnet" }, credential: { mode: "new", value: KEY }, setActive: true, ...extra });
function fixture(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-claude-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createClaudeConfig({ dir, revisionKey: crypto.randomBytes(32) });
  if (settings) fs.writeFileSync(config.settingsPath, JSON.stringify(settings));
  const read = (file = config.settingsPath) => JSON.parse(fs.readFileSync(file, "utf8"));
  const write = (method, value) => config[method]({ revision: config.publicState().revision, ...value });
  return { dir, config, read, write };
}

test("Claude reads/adopts native configuration without disk writes or credential disclosure", (t) => {
  const settings = { model: "opus", env: { ANTHROPIC_BASE_URL: "https://original.example", ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: "relay-opus" }, permissions: { allow: ["Read"] } };
  const { config } = fixture(t, settings);
  const original = fs.readFileSync(config.settingsPath);
  const state = config.publicState();
  assert.equal(state.providers[0].adopted, true);
  assert.equal(state.providers[0].model, "opus");
  assert.equal(state.providers[0].aliases.opus, "relay-opus");
  assert.equal(state.providers[0].credentialConfigured, true);
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.deepEqual(fs.readFileSync(config.settingsPath), original);
  assert.equal(fs.existsSync(config.storePath), false);
});

test("Claude activation owns both auth slots and model mappings, preserving unrelated settings", (t) => {
  const unrelated = { permissions: { deny: ["Bash(rm *)"] }, hooks: { SessionStart: [] }, modelSettings: { custom: { effort: "high" } }, future: { v: 1 } };
  const { config, read, write } = fixture(t, { ...unrelated, env: { ANTHROPIC_BASE_URL: "https://old.example", ANTHROPIC_AUTH_TOKEN: "old-token", ANTHROPIC_API_KEY: "old-key", ANTHROPIC_MODEL: "old-model", ANTHROPIC_DEFAULT_MODEL: "old-default", ANTHROPIC_DEFAULT_OPUS_MODEL: "old-opus", KEEP_ME: "yes" } });
  write("saveProvider", payload({ authType: "api-key" }));
  const saved = read();
  assert.equal(saved.env.ANTHROPIC_API_KEY, KEY);
  assert.equal(saved.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(saved.env.ANTHROPIC_MODEL, undefined);
  assert.equal(saved.env.ANTHROPIC_DEFAULT_MODEL, undefined);
  assert.equal(saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(saved.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "relay-sonnet");
  assert.equal(saved.env.KEEP_ME, "yes");
  assert.equal(saved.model, "sonnet");
  for (const [key, value] of Object.entries(unrelated)) assert.deepEqual(saved[key], value);
  assert.ok(!JSON.stringify(config.publicState()).includes(KEY));
  if (process.platform !== "win32") for (const file of [config.storePath, config.settingsPath]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("Claude standby saves leave native settings intact, and external edits win over the store", (t) => {
  const { config, read, write } = fixture(t);
  write("saveProvider", payload({ setActive: false }));
  assert.equal(fs.existsSync(config.settingsPath), false);
  assert.equal(config.publicState().activeProviderId, "");
  write("activate", { providerId: "gateway" });
  assert.equal(config.publicState().activeProviderId, "gateway");
  const settings = read(); settings.model = "external-model";
  fs.writeFileSync(config.settingsPath, JSON.stringify(settings));
  const view = config.publicState();
  assert.equal(view.providers.find((entry) => entry.isActive).model, "external-model");
  assert.equal(view.providers.find((entry) => entry.id === "gateway").isActive, false);
  const bytes = fs.readFileSync(config.settingsPath);
  write("saveProvider", payload({ providerId: "standby", setActive: false }));
  assert.deepEqual(fs.readFileSync(config.settingsPath), bytes);
  assert.equal(read(config.storePath).providers[view.activeProviderId].model, "external-model");
});

test("Claude rename retains the source credential and rejects occupied provider/auth IDs", (t) => {
  const { config, read, write } = fixture(t);
  write("saveProvider", payload());
  write("saveProvider", payload({ providerId: "other", setActive: false }));
  write("deleteProvider", { providerId: "other", keepCredential: true });
  assert.throws(() => write("saveProvider", payload({ providerId: "other", renameFrom: "gateway", credential: { mode: "keep" } })), /占用/);
  write("saveProvider", payload({ providerId: "renamed", renameFrom: "gateway", credential: { mode: "keep" } }));
  assert.equal(config.publicState().activeProviderId, "renamed");
  assert.equal(read().env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(read(config.storePath).providers.gateway, undefined);
  assert.equal(read(config.storePath).credentials.gateway, undefined);
});

test("Claude active deletion requires a valid replacement and keeps auth only when requested", (t) => {
  const { config, read, write } = fixture(t);
  write("saveProvider", payload());
  assert.throws(() => write("deleteProvider", { providerId: "gateway" }), /替代/);
  write("saveProvider", payload({ providerId: "backup", setActive: false, credential: { mode: "new", value: "backup-key" } }));
  assert.throws(() => write("deleteProvider", { providerId: "gateway", replacementProviderId: "gateway" }), /替代/);
  write("deleteProvider", { providerId: "gateway", replacementProviderId: "backup" });
  assert.equal(read().env.ANTHROPIC_AUTH_TOKEN, "backup-key");
  assert.equal(config.publicState().activeProviderId, "backup");
  assert.equal(read(config.storePath).credentials.gateway, undefined);
});

test("every Claude mutation rejects stale revisions without changing bytes", (t) => {
  const { config, write } = fixture(t);
  write("saveProvider", payload());
  const stale = config.publicState().revision;
  fs.appendFileSync(config.settingsPath, "\n");
  const settings = fs.readFileSync(config.settingsPath), store = fs.readFileSync(config.storePath);
  for (const [method, body] of [["saveProvider", payload()], ["activate", { providerId: "gateway" }], ["deleteProvider", { providerId: "gateway" }], ["saveSettings", { language: "Chinese" }]]) {
    assert.throws(() => config[method]({ ...body, revision: stale }), (error) => error.statusCode === 409);
    assert.deepEqual(fs.readFileSync(config.settingsPath), settings);
    assert.deepEqual(fs.readFileSync(config.storePath), store);
  }
});

test("Claude failed second-file write rolls back the native settings", (t) => {
  const { config, write } = fixture(t);
  write("saveProvider", payload());
  const before = [config.settingsPath, config.storePath].map((file) => fs.readFileSync(file));
  const original = fs.renameSync;
  let failed = false;
  fs.renameSync = (source, destination) => {
    if (!failed && destination === config.storePath && source.endsWith(".tmp")) { failed = true; throw new Error("simulated store write failure"); }
    return original(source, destination);
  };
  try { assert.throws(() => write("saveProvider", payload({ model: "other-model" })), /simulated/); }
  finally { fs.renameSync = original; }
  assert.equal(failed, true);
  [config.settingsPath, config.storePath].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});

test("Claude settings preserve unwritten state and unknown effort values; null removes a managed key", (t) => {
  const { config, read, write } = fixture(t, { future: 42, effortLevel: "future-effort" });
  assert.deepEqual(config.publicState().settings, { effortLevel: "future-effort" });
  write("saveSettings", { effortLevel: "future-effort", language: "简体中文", alwaysThinkingEnabled: false });
  assert.equal(read().future, 42);
  assert.throws(() => write("saveSettings", { effortLevel: "made-up" }), /思考/);
  assert.throws(() => write("saveSettings", { alwaysThinkingEnabled: "false" }), /布尔/);
  write("saveSettings", { effortLevel: null, language: null, alwaysThinkingEnabled: null });
  assert.deepEqual(read(), { future: 42 });
});

test("Claude malformed files never quote a credential in diagnostics", (t) => {
  const { config } = fixture(t);
  fs.writeFileSync(config.settingsPath, '{"env":{"ANTHROPIC_AUTH_TOKEN":"' + KEY + '"},oops}');
  assert.throws(() => config.publicState(), (error) => !error.message.includes(KEY) && /JSON/.test(error.message));
});

test("Claude refuses cloud/helper takeover, but permits saving an inactive gateway", (t) => {
  const { config, read, write } = fixture(t, { apiKeyHelper: "do-not-execute", env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
  assert.deepEqual(config.publicState().blockers, ["CLAUDE_CODE_USE_BEDROCK", "apiKeyHelper"]);
  assert.throws(() => write("saveProvider", payload()), /apiKeyHelper/);
  assert.equal(fs.existsSync(config.storePath), false);
  write("saveProvider", payload({ setActive: false }));
  assert.equal(read().apiKeyHelper, "do-not-execute");
  assert.throws(() => write("activate", { providerId: "gateway" }), /apiKeyHelper/);
});

test("Claude rejects unsafe URLs, invalid credentials and malformed model IDs before disk", (t) => {
  const { config, write } = fixture(t);
  for (const extra of [{ baseUrl: "https://user:password@example.com" }, { baseUrl: "https://example.com?key=secret" }, { credential: { mode: "new", value: "https://example.com/key" } }, { model: "bad model" }, { aliases: { sonnet: "bad\nmodel" } }, { providerId: "../outside" }]) assert.throws(() => write("saveProvider", payload(extra)));
  assert.equal(fs.existsSync(config.settingsPath), false);
  assert.equal(fs.existsSync(config.storePath), false);
});

test("Claude native URL credentials never return in browser state", (t) => {
  const { config } = fixture(t, { env: { ANTHROPIC_BASE_URL: "https://user:secret-in-url@gateway.example", ANTHROPIC_AUTH_TOKEN: KEY } });
  assert.throws(() => config.publicState(), (error) => !error.message.includes("secret-in-url") && /网关地址/.test(error.message));
});
