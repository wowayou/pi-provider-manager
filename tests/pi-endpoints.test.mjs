import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelBaseUrl, readModelBaseUrl, piRequestUrl } from "../lib/pi-endpoints.mjs";
import { draftSignature, duplicatePiForm, modelBaseUrlSaveIntent, piConfigJsonToForm, piFormToConfigJson } from "../src/model-draft.mjs";

test("endpoint preview matches SDK path appending without guessing /v1 or discarding a prefix", () => {
  assert.equal(piRequestUrl("openai-completions", "https://gateway.example/v1/"), "https://gateway.example/v1/chat/completions");
  assert.equal(piRequestUrl("openai-responses", "https://gateway.example/openai/v1"), "https://gateway.example/openai/v1/responses");
  assert.equal(piRequestUrl("anthropic-messages", "https://gateway.example/anthropic"), "https://gateway.example/anthropic/v1/messages");
  assert.equal(piRequestUrl("anthropic-messages", "https://gateway.example/v1"), "https://gateway.example/v1/v1/messages");
  assert.equal(piRequestUrl("openai-completions", "https://gateway.example"), "https://gateway.example/chat/completions");
  assert.equal(piRequestUrl("openai-responses", "not a URL"), "");
});

test("model URLs allow native path overrides and loopback, while private or malformed values stay external", () => {
  for (const value of ["https://gateway.example/anthropic", "http://127.0.0.1:8888/v1"]) {
    assert.equal(normalizeModelBaseUrl(` ${value}/ `), value);
    assert.deepEqual(readModelBaseUrl({ baseUrl: value }), { kind: "literal", value });
  }
  assert.equal(normalizeModelBaseUrl(" "), "");
  assert.deepEqual(readModelBaseUrl({}), { kind: "none" });
  for (const baseUrl of [null, 3, {}, "", "https://user:secret@gateway.example", "https://gateway.example?key=secret", "https://gateway.example/#secret", "http://remote.example", "!echo secret"]) {
    assert.deepEqual(readModelBaseUrl({ baseUrl }), { kind: "external" });
    if (baseUrl !== "") assert.throws(() => normalizeModelBaseUrl(baseUrl));
  }
});

test("model address survives JSON, duplicate and rename with explicit clear and omission semantics", () => {
  const row = { rowId: "row", persistedId: "claude", id: "claude", name: "claude", api: "anthropic-messages", baseUrl: "https://gateway.example/anthropic", baseUrlKind: "literal", baseUrlEdited: false, contextWindow: 200000, maxTokens: 16000, maximumThinking: "on", supportsImages: true, forceAdaptiveThinking: false, anthropicBeta: "", anthropicBetaKind: "none", anthropicBetaEdited: false, limitsAuto: false };
  const form = { providerId: "router", baseUrl: "https://gateway.example/v1", api: "openai-completions", compat: {}, models: [row], defaultRowId: "row" };
  const json = JSON.parse(piFormToConfigJson(form));
  assert.equal(json.models[0].baseUrl, row.baseUrl);
  assert.deepEqual(JSON.parse(draftSignature(piConfigJsonToForm(json, form))), JSON.parse(draftSignature(form)));
  assert.deepEqual(modelBaseUrlSaveIntent(row, "router", "router"), {});
  assert.deepEqual(modelBaseUrlSaveIntent(row, "renamed", "renamed"), {});
  const copy = duplicatePiForm(form, ["router"]);
  assert.equal(copy.apiKey, "");
  assert.equal(copy.models[0].persistedId, "");
  assert.deepEqual(modelBaseUrlSaveIntent(copy.models[0], "", copy.providerId), { baseUrl: row.baseUrl });
  json.models[0].baseUrl = "";
  const cleared = piConfigJsonToForm(json, form).models[0];
  assert.deepEqual(modelBaseUrlSaveIntent(cleared, "router", "router"), { baseUrl: "" });
  delete json.models[0].baseUrl;
  assert.equal(piConfigJsonToForm(json, form).models[0].baseUrl, row.baseUrl);
  const external = { ...row, baseUrl: "", baseUrlKind: "external" };
  assert.deepEqual(modelBaseUrlSaveIntent(external, "router", "router"), {});
  assert.equal(Object.hasOwn(JSON.parse(piFormToConfigJson({ ...form, models: [external] })).models[0], "baseUrl"), false);
  json.models[0].baseUrl = "";
  assert.deepEqual(modelBaseUrlSaveIntent(piConfigJsonToForm(json, { ...form, models: [external] }).models[0], "router", "router"), { baseUrl: "" });
  const externalCopy = duplicatePiForm({ ...form, models: [external] }, ["router"]);
  assert.deepEqual(modelBaseUrlSaveIntent(externalCopy.models[0], "", externalCopy.providerId), { baseUrl: "" });
  json.models[0].baseUrl = {};
  assert.throws(() => piConfigJsonToForm(json, form), /地址必须是文本/);
});
