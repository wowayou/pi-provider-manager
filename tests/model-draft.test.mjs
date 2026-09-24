import assert from "node:assert/strict";
import test from "node:test";
import { changedPersistedModel, draftSignature, duplicateCodexForm, duplicatePiForm, selectedNamedModel, suggestCopyId, userAgentSaveIntent, anthropicBetaSaveIntent, piFormToConfigJson, piConfigJsonToForm } from "../src/model-draft.mjs";

test("draftSignature ignores rowId churn but tracks real edits", () => {
  const form = {
    providerId: "router",
    baseUrl: "https://router.example/v1",
    api: "openai-responses",
    userAgent: "",
    models: [
      { rowId: "a", id: "opus", contextWindow: 200000, maxTokens: 8192 },
      { rowId: "b", id: "haiku", contextWindow: 200000, maxTokens: 8192 },
    ],
    defaultRowId: "a",
  };
  // Fresh row keys, same values and same default model -> identical signature.
  const reloaded = {
    ...form,
    models: [
      { rowId: "x", id: "opus", contextWindow: 200000, maxTokens: 8192 },
      { rowId: "y", id: "haiku", contextWindow: 200000, maxTokens: 8192 },
    ],
    defaultRowId: "x",
  };
  assert.equal(draftSignature(form), draftSignature(reloaded));

  // Changing a token count changes the signature.
  const editedTokens = { ...form, models: [{ ...form.models[0], contextWindow: 100000 }, form.models[1]] };
  assert.notEqual(draftSignature(form), draftSignature(editedTokens));

  // Moving the default to a different model changes the signature, even though
  // the rows are untouched.
  const editedDefault = { ...form, defaultRowId: "b" };
  assert.notEqual(draftSignature(form), draftSignature(editedDefault));

  // A scalar field edit changes the signature.
  assert.notEqual(draftSignature(form), draftSignature({ ...form, userAgent: "custom/1.0" }));
});

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
      { rowId: "r2", persistedId: "claude-3-5-haiku", id: "claude-3-5-haiku", name: "claude-3-5-haiku", contextWindow: 200000, maxTokens: 8192, supportsImages: false, reasoning: true, maximumThinking: "on", api: "inherit", forceAdaptiveThinking: false },
    ],
    defaultRowId: "r2",
    defaultThinkingLevel: "high",
    compat: { supportsStrictTools: true },
    userAgent: "claude-cli/2.1.197 (external, cli)",
    userAgentKind: "literal",
    userAgentEdited: false,
    hasModelUserAgentOverride: false,
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
  assert.equal(copy.models[1].maximumThinking, "on");
  assert.equal(copy.defaultRowId, copy.models[1].rowId);
  assert.deepEqual(copy.compat, { supportsStrictTools: true });
  assert.equal(copy.userAgent, form.userAgent);
  assert.equal(copy.userAgentKind, "literal");
  assert.equal(copy.userAgentEdited, true);
  // Nothing in a copy exists on disk yet, so no row may claim a storage
  // identity: carrying persistedId over would lock the IDs as read-only and
  // make the identity-drift check refuse the draft.
  assert.deepEqual(copy.models.map((model) => model.persistedId), ["", ""]);
  assert.equal(changedPersistedModel(copy.models), null);
  // Reusing an existing credential must not move it away from the source,
  // which is still configured and still needs its key.
  assert.equal(copy.moveCredential, false);
  // The source draft must be untouched: rows are copied, not aliased.
  assert.equal(form.models[0].rowId, "r1");
  assert.equal(form.defaultRowId, "r2");
  assert.equal(form.models[0].persistedId, "claude-3-5-sonnet");
  assert.equal(form.moveCredential, true);
});

test("a duplicated Pi draft clears external model Beta values explicitly", () => {
  const copy = duplicatePiForm({ providerId: "router", models: [{ rowId: "r1", persistedId: "m", id: "m", anthropicBeta: "", anthropicBetaKind: "external", anthropicBetaEdited: false }], defaultRowId: "r1", userAgentKind: "none", userAgent: "", hasModelUserAgentOverride: false }, []);
  assert.equal(copy.models[0].anthropicBeta, "");
  assert.equal(copy.models[0].anthropicBetaKind, "none");
  assert.equal(copy.models[0].anthropicBetaEdited, true);
  assert.equal(copy.copiedExternalBeta, true);
});
test("a duplicated Pi draft does not copy an external User-Agent expression", () => {
  const copy = duplicatePiForm({
    providerId: "router",
    baseUrl: "https://router.example/v1",
    api: "openai-responses",
    credentialMode: "keep",
    apiKey: "",
    models: [{ rowId: "r1", persistedId: "model", id: "model" }],
    defaultRowId: "r1",
    userAgent: "",
    userAgentKind: "external",
    userAgentEdited: false,
    hasModelUserAgentOverride: true,
  }, []);

  assert.equal(copy.userAgent, "");
  assert.equal(copy.userAgentKind, "none");
  assert.equal(copy.userAgentEdited, false);
  assert.equal(copy.copiedExternalUserAgent, true);
  assert.equal(copy.hasModelUserAgentOverride, true);
});

test("a changed provider ID re-evaluates untouched User-Agent write intent", () => {
  const literal = { providerId: "renamed", userAgent: "client/1.0", userAgentKind: "literal", userAgentEdited: false };
  assert.deepEqual(userAgentSaveIntent(literal, "source", false), { write: true, value: "client/1.0" });
  const none = { providerId: "renamed", userAgent: "", userAgentKind: "none", userAgentEdited: false };
  assert.deepEqual(userAgentSaveIntent(none, "source", false), { write: true, value: "" });
  const external = { providerId: "renamed", userAgent: "", userAgentKind: "external", userAgentEdited: false };
  assert.deepEqual(userAgentSaveIntent(external, "source", true), { write: false });
  assert.deepEqual(userAgentSaveIntent(external, "source", false), { write: true, value: "" });
  assert.deepEqual(userAgentSaveIntent({ ...literal, providerId: "source" }, "source", false), { write: false });
  assert.deepEqual(userAgentSaveIntent({ providerId: "existing", userAgent: "", userAgentKind: "none", userAgentEdited: false }, "", true), { write: true, value: "" });
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
test("model beta save intent preserves external target and clears new targets", () => {
  const external = { persistedId: "m", anthropicBeta: "", anthropicBetaKind: "external", anthropicBetaEdited: false };
  assert.deepEqual(anthropicBetaSaveIntent(external, "source", "source", true), { write: false });
  assert.deepEqual(anthropicBetaSaveIntent(external, "source", "other", false), { write: true, value: "" });
  const literal = { persistedId: "m", anthropicBeta: "context-1m-2025-08-07", anthropicBetaKind: "literal", anthropicBetaEdited: false };
  assert.deepEqual(anthropicBetaSaveIntent(literal, "source", "other", false), { write: true, value: "context-1m-2025-08-07" });
  const edited = { ...external, anthropicBeta: "beta-a, beta-b", anthropicBetaEdited: true };
  assert.deepEqual(anthropicBetaSaveIntent(edited, "source", "source", true), { write: true, value: "beta-a, beta-b" });
});

function jsonEditorForm() {
  return {
    providerId: "any-claude",
    baseUrl: "https://api.any-claude.com/v1",
    api: "anthropic-messages",
    credentialMode: "keep",
    apiKey: "",
    compat: { foo: true },
    models: [
      { rowId: "row-a", persistedId: "claude-opus", id: "claude-opus", name: "Opus", contextWindow: 200000, maxTokens: 8192, supportsImages: true, maximumThinking: "on", api: "inherit", forceAdaptiveThinking: false, anthropicBeta: "context-1m-2025-08-07", anthropicBetaKind: "literal", anthropicBetaEdited: false },
      { rowId: "row-b", persistedId: "claude-haiku", id: "claude-haiku", name: "Haiku", contextWindow: 200000, maxTokens: 8192, supportsImages: false, maximumThinking: "off", api: "openai-completions", forceAdaptiveThinking: false, anthropicBeta: "", anthropicBetaKind: "none", anthropicBetaEdited: false },
    ],
    defaultRowId: "row-a",
    userAgent: "",
    userAgentKind: "none",
    userAgentEdited: false,
  };
}

test("the config JSON editor renders the credential-free draft and never the credential", () => {
  const json = piFormToConfigJson(jsonEditorForm());
  const parsed = JSON.parse(json);
  assert.equal(parsed.baseUrl, "https://api.any-claude.com/v1");
  assert.equal(parsed.api, "anthropic-messages");
  assert.deepEqual(parsed.compat, { foo: true });
  assert.equal(parsed.models.length, 2);
  assert.equal(parsed.models[0].thinking, "on");
  assert.equal(parsed.models[0].anthropicBeta, "context-1m-2025-08-07");
  // Nothing about a key ever appears.
  assert.equal(/apiKey|api_key|credential|providerId/i.test(json), false);
});

test("applying edited config JSON keeps persistedId for surviving model IDs", () => {
  const form = jsonEditorForm();
  const json = piFormToConfigJson(form);
  const parsed = JSON.parse(json);
  parsed.baseUrl = "https://api.any-claude.com/v2";
  parsed.models[0].maxTokens = 4096;
  const next = piConfigJsonToForm(parsed, form);
  assert.equal(next.baseUrl, "https://api.any-claude.com/v2");
  assert.equal(next.models[0].persistedId, "claude-opus");
  assert.equal(next.models[0].rowId, "row-a");
  assert.equal(next.models[0].maxTokens, 4096);
  // The default follows its model ID across the round trip.
  assert.equal(next.defaultRowId, next.models.find((model) => model.id === "claude-opus").rowId);
});

test("a model ID renamed through the JSON editor becomes a fresh row with no persisted identity", () => {
  const form = jsonEditorForm();
  const parsed = JSON.parse(piFormToConfigJson(form));
  parsed.models[0].id = "claude-opus-4";
  const next = piConfigJsonToForm(parsed, form);
  const renamed = next.models.find((model) => model.id === "claude-opus-4");
  assert.equal(renamed.persistedId, "");
  assert.notEqual(renamed.rowId, "row-a");
});

test("the config JSON editor refuses a non-object, empty models, and duplicate IDs", () => {
  const form = jsonEditorForm();
  assert.throws(() => piConfigJsonToForm([], form), /JSON 对象/);
  assert.throws(() => piConfigJsonToForm({ models: [] }, form), /至少/);
  assert.throws(() => piConfigJsonToForm({ models: [{ id: "x" }, { id: "x" }] }, form), /重复/);
  assert.throws(() => piConfigJsonToForm({ models: [{ name: "no id" }] }, form), /缺少 id/);
});
