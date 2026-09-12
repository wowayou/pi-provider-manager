import assert from "node:assert/strict";
import test from "node:test";
import { changedPersistedModel, duplicateCodexForm, duplicatePiForm, selectedNamedModel, suggestCopyId } from "../src/model-draft.mjs";

test("persisted model identities cannot be renamed or cleared in a draft", () => {
  const unchanged = { rowId: "stored", persistedId: "anthropic/claude-opus", id: "anthropic/claude-opus" };
  const created = { rowId: "new", persistedId: "", id: "openai/gpt-router" };

  assert.equal(changedPersistedModel([unchanged, created]), null);
  assert.equal(
    changedPersistedModel([{ ...unchanged, id: "anthropic/claude-opus-new" }, created])?.persistedId,
    "anthropic/claude-opus",
  );
  assert.equal(
    changedPersistedModel([{ ...unchanged, id: "" }, created])?.persistedId,
    "anthropic/claude-opus",
  );
  assert.equal(changedPersistedModel([created]), null);
});

test("default selection never falls back to a different named row", () => {
  const models = [
    { rowId: "cleared", id: "" },
    { rowId: "named", id: "openai/gpt-router" },
  ];

  assert.equal(selectedNamedModel(models, "cleared"), null);
  assert.equal(selectedNamedModel(models, "missing"), null);
  assert.equal(selectedNamedModel(models, "named"), models[1]);
});

test("a duplicate gets a free copy id, counting up when -copy is taken", () => {
  assert.equal(suggestCopyId("any-claude", ["openai", "deepseek"]), "any-claude-copy");
  assert.equal(suggestCopyId("any-claude", ["any-claude", "any-claude-copy"]), "any-claude-copy-2");
  assert.equal(suggestCopyId("any-claude", ["any-claude-copy", "any-claude-copy-2", "any-claude-copy-3"]), "any-claude-copy-4");
});

test("a duplicated Pi draft carries the models but never the credential", () => {
  const form = {
    providerId: "any-claude",
    baseUrl: "https://api.any-claude.com/v1",
    api: "anthropic-messages",
    credentialMode: "keep",
    apiKey: "",
    migrateFrom: "openai",
    moveCredential: true,
    models: [
      { rowId: "r1", persistedId: "claude-3-5-sonnet", id: "claude-3-5-sonnet", name: "claude-3-5-sonnet", contextWindow: 200000, maxTokens: 8192, supportsImages: true, reasoning: true, maximumThinking: "high", api: "inherit", forceAdaptiveThinking: false },
      { rowId: "r2", persistedId: "claude-3-5-haiku", id: "claude-3-5-haiku", name: "claude-3-5-haiku", contextWindow: 200000, maxTokens: 8192, supportsImages: false, reasoning: true, maximumThinking: "medium", api: "inherit", forceAdaptiveThinking: false },
    ],
    defaultRowId: "r2",
    defaultThinkingLevel: "high",
    compat: { supportsStrictTools: true },
  };

  const copy = duplicatePiForm(form, ["any-claude", "openai"]);
  assert.equal(copy.providerId, "any-claude-copy");
  assert.equal(copy.baseUrl, form.baseUrl);
  assert.equal(copy.api, form.api);
  // The stored key never returns to the browser, so a copy is born asking
  // for a new one rather than silently keeping the source's credential mode.
  assert.equal(copy.credentialMode, "new");
  assert.equal(copy.apiKey, "");
  assert.notEqual(copy.models[0].rowId, "r1");
  assert.notEqual(copy.models[1].rowId, "r2");
  assert.deepEqual(copy.models.map((model) => model.id), ["claude-3-5-sonnet", "claude-3-5-haiku"]);
  assert.equal(copy.models[1].maximumThinking, "medium");
  assert.equal(copy.defaultRowId, copy.models[1].rowId);
  assert.deepEqual(copy.compat, { supportsStrictTools: true });
  // The source draft must be untouched: rows are copied, not aliased.
  assert.equal(form.models[0].rowId, "r1");
  assert.equal(form.defaultRowId, "r2");
});

test("a duplicated Codex draft keeps the bridge address but not the bridge key", () => {
  const form = {
    providerId: "packy",
    name: "PackyCode",
    baseUrl: "https://api.packycode.com/v1",
    upstream: "direct",
    requiresAuth: true,
    credentialMode: "keep",
    apiKey: "",
    migrateFrom: "",
    bridgeUpstreamUrl: "",
    bridgeApiKey: "stale-bridge-key",
    models: [
      { rowId: "m1", id: "gpt-5.6-sol", reasoningEffort: "high" },
      { rowId: "m2", id: "gpt-5.1-codex", reasoningEffort: "xhigh" },
    ],
    defaultRowId: "m1",
  };

  const copy = duplicateCodexForm(form, ["packy", "kimi", "packy-copy"]);
  assert.equal(copy.providerId, "packy-copy-2");
  assert.equal(copy.name, "PackyCode");
  assert.equal(copy.baseUrl, form.baseUrl);
  assert.equal(copy.upstream, "direct");
  assert.equal(copy.requiresAuth, true);
  assert.equal(copy.credentialMode, "new");
  assert.equal(copy.apiKey, "");
  assert.equal(copy.models.map((model) => model.id).join(","), "gpt-5.6-sol,gpt-5.1-codex");
  assert.equal(copy.models[1].reasoningEffort, "xhigh");
  assert.equal(copy.defaultRowId, copy.models[0].rowId);

  const bridge = duplicateCodexForm({ ...form, upstream: "bridge", bridgeUpstreamUrl: "https://up.example/v1", bridgeApiKey: "held-key" }, []);
  assert.equal(bridge.upstream, "bridge");
  assert.equal(bridge.bridgeUpstreamUrl, "https://up.example/v1");
  assert.equal(bridge.bridgeApiKey, "");
});
