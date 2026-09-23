import assert from "node:assert/strict";
import test from "node:test";

import { codexConfigJsonToForm, codexFormToConfigJson } from "../lib/codex-shared.mjs";

function directForm() {
  return {
    providerId: "packy",
    name: "PackyCode",
    baseUrl: "https://api.packycode.com/v1",
    upstream: "direct",
    requiresAuth: true,
    credentialMode: "keep",
    apiKey: "",
    bridgeUpstreamUrl: "",
    bridgeApiKey: "",
    models: [
      { rowId: "row-a", id: "gpt-5.6-sol", reasoningEffort: "high" },
      { rowId: "row-b", id: "gpt-5.1-codex", reasoningEffort: "xhigh" },
    ],
    defaultRowId: "row-a",
  };
}

function bridgeForm() {
  return {
    ...directForm(),
    upstream: "bridge",
    baseUrl: "http://127.0.0.1:4000/v1",
    bridgeUpstreamUrl: "https://upstream.example/v1",
    bridgeApiKey: "held-key",
  };
}

test("the Codex config JSON renders the credential-free draft and never a key", () => {
  const json = codexFormToConfigJson(directForm());
  const parsed = JSON.parse(json);
  assert.equal(parsed.name, "PackyCode");
  assert.equal(parsed.baseUrl, "https://api.packycode.com/v1");
  assert.equal(parsed.requiresAuth, true);
  assert.equal(parsed.models.length, 2);
  assert.equal(parsed.models[1].reasoningEffort, "xhigh");
  assert.equal(/apiKey|api_key|credential|held-key/i.test(json), false);
});

test("a bridge draft shows the upstream address, not the local one or the key", () => {
  const json = codexFormToConfigJson(bridgeForm());
  const parsed = JSON.parse(json);
  assert.equal(parsed.upstreamBaseUrl, "https://upstream.example/v1");
  assert.equal(Object.hasOwn(parsed, "baseUrl"), false);
  assert.equal(Object.hasOwn(parsed, "requiresAuth"), false);
  assert.equal(/held-key|bridgeApiKey/i.test(json), false);
});

test("applying edited Codex config JSON keeps the rowId for surviving model IDs", () => {
  const form = directForm();
  const parsed = JSON.parse(codexFormToConfigJson(form));
  parsed.baseUrl = "https://api.packycode.com/v2";
  parsed.models[0].reasoningEffort = "medium";
  const next = codexConfigJsonToForm(parsed, form);
  assert.equal(next.baseUrl, "https://api.packycode.com/v2");
  assert.equal(next.models[0].rowId, "row-a");
  assert.equal(next.models[0].reasoningEffort, "medium");
  // The default follows its model ID across the round trip.
  assert.equal(next.defaultRowId, next.models.find((model) => model.id === "gpt-5.6-sol").rowId);
});

test("a bridge draft maps upstreamBaseUrl back to the bridge field", () => {
  const form = bridgeForm();
  const parsed = JSON.parse(codexFormToConfigJson(form));
  parsed.upstreamBaseUrl = "https://upstream.example/v2";
  const next = codexConfigJsonToForm(parsed, form);
  assert.equal(next.bridgeUpstreamUrl, "https://upstream.example/v2");
  // The bridge key is untouched by the editor.
  assert.equal(next.bridgeApiKey, "held-key");
});

test("the Codex config JSON refuses a non-object, empty models, and duplicate IDs", () => {
  const form = directForm();
  assert.throws(() => codexConfigJsonToForm([], form), /JSON 对象/);
  assert.throws(() => codexConfigJsonToForm({ models: [] }, form), /至少/);
  assert.throws(() => codexConfigJsonToForm({ models: [{ id: "x" }, { id: "x" }] }, form), /重复/);
  assert.throws(() => codexConfigJsonToForm({ models: [{ reasoningEffort: "high" }] }, form), /缺少 id/);
});

test("an unknown reasoning effort in the JSON falls back rather than sticking", () => {
  const form = directForm();
  const next = codexConfigJsonToForm({ models: [{ id: "gpt-5.6-sol", reasoningEffort: "banana" }] }, form);
  // "banana" is not a known effort, so the prior row's value is kept.
  assert.equal(next.models[0].reasoningEffort, "high");
});
