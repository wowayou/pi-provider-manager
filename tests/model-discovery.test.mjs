import assert from "node:assert/strict";
import test from "node:test";
import { describeDiscoveryStatus, discoveryRequest, parseModelList } from "../lib/model-discovery.mjs";

test("asks the URL Pi itself would derive from the same baseUrl", () => {
  // Pi hands an Anthropic baseUrl to a client that appends /v1/…; the OpenAI and
  // Google clients treat the baseUrl as already versioned.
  const anthropic = discoveryRequest("anthropic-messages", "https://gw.example/", "sk-key");
  assert.equal(anthropic.url, "https://gw.example/v1/models?limit=1000");
  assert.deepEqual(anthropic.headers, { "x-api-key": "sk-key", "anthropic-version": "2023-06-01", accept: "application/json" });
  const oauth = discoveryRequest("anthropic-messages", "https://gw.example", "sk-ant-oat01-token");
  assert.equal(oauth.headers.authorization, "Bearer sk-ant-oat01-token");
  assert.equal(oauth.headers["x-api-key"], undefined);
  for (const api of ["openai-responses", "openai-completions"]) {
    const openai = discoveryRequest(api, "https://gw.example/v1", "sk-key");
    assert.equal(openai.url, "https://gw.example/v1/models");
    assert.equal(openai.headers.authorization, "Bearer sk-key");
  }
  const google = discoveryRequest("google-generative-ai", "https://gw.example/v1beta", "g-key");
  assert.equal(google.url, "https://gw.example/v1beta/models?pageSize=1000");
  assert.equal(google.headers["x-goog-api-key"], "g-key");
  assert.equal(google.url.includes("g-key"), false, "the key travels in a header, never in the URL");
});

test("refuses what the save endpoint would refuse", () => {
  assert.throws(() => discoveryRequest("openai-completions", "http://remote.example/v1", "k"), /HTTPS/);
  assert.throws(() => discoveryRequest("openai-completions", "api.example.com/v1", "k"), /完整地址/);
  assert.throws(() => discoveryRequest("openai-completions", "https://gw.example/v1", ""), /API Key/);
  assert.throws(() => discoveryRequest("something-else", "https://gw.example/v1", "k"), /协议/);
});

test("reads the three list shapes and reduces each entry to id and name", () => {
  assert.deepEqual(parseModelList({ object: "list", data: [{ id: "gpt-5.6-sol", object: "model", owned_by: "x" }, { id: "gpt-5.6-sol" }, { id: " spaced " }] }), [{ id: "gpt-5.6-sol" }, { id: "spaced" }]);
  assert.deepEqual(parseModelList({ data: [{ id: "claude-opus-4-1", display_name: "Claude Opus 4.1", type: "model" }] }), [{ id: "claude-opus-4-1", name: "Claude Opus 4.1" }]);
  assert.deepEqual(parseModelList({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }, { name: "models/gemini-2.5-pro" }] }), [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }]);
  assert.deepEqual(parseModelList([{ id: "bare" }, "string-id", 42, null]), [{ id: "bare" }, { id: "string-id" }]);
  assert.deepEqual(parseModelList({ data: [{ id: "anthropic/claude-opus-4[1M]" }] }), [{ id: "anthropic/claude-opus-4[1M]" }]);
});

test("drops what cannot be a model id and never relays other body content", () => {
  const parsed = parseModelList({ data: [
    { id: "ok", display_name: "line\nbreakbell" },
    { id: "has space" },
    { id: "ctrlchar" },
    { id: "中文" },
    { id: "x".repeat(257) },
    { id: "" },
    { display_name: "no id" },
  ], secret: "must-not-appear" });
  assert.deepEqual(parsed, [{ id: "ok", name: "line break bell" }]);
  assert.throws(() => parseModelList({ error: { message: "nope" } }), /不是模型列表/);
  assert.throws(() => parseModelList("text"), /不是模型列表/);
  const many = parseModelList({ data: Array.from({ length: 2500 }, (_, index) => ({ id: `m-${index}` })) });
  assert.equal(many.length, 2000);
});

test("explains a gateway status without the key or the body", () => {
  assert.match(describeDiscoveryStatus(401), /拒绝了这个凭据/);
  assert.match(describeDiscoveryStatus(403), /403/);
  assert.match(describeDiscoveryStatus(404), /手动填写/);
  assert.match(describeDiscoveryStatus(302), /重定向/);
  assert.match(describeDiscoveryStatus(502), /HTTP 502/);
});
