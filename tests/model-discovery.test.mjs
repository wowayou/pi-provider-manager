import assert from "node:assert/strict";
import test from "node:test";
import { defaultDiscoveryPath, describeDiscoveryStatus, discoveryRequest, parseModelList, resolveDiscoveryUrl } from "../lib/model-discovery.mjs";

test("asks the URL Pi itself would derive from the same baseUrl", () => {
  // Pi hands an Anthropic baseUrl to a client that appends /v1/…; the OpenAI and
  // Google clients treat the baseUrl as already versioned.
  const anthropic = discoveryRequest("anthropic-messages", "https://gw.example/", "sk-key");
  assert.equal(anthropic.url, "https://gw.example/v1/models?limit=1000");
  // Bearer for every Anthropic-shaped key: relays reject `x-api-key` on the
  // listing endpoint (Anyrouter answers it with 401 "未提供令牌").
  assert.deepEqual(anthropic.headers, { authorization: "Bearer sk-key", "anthropic-version": "2023-06-01", accept: "application/json" });
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

test("a custom path is resolved against the gateway root, keeping the protocol's auth", () => {
  // The point of the override: a relay whose catalogue is not where Pi would look.
  const custom = discoveryRequest("anthropic-messages", "https://gw.example", "sk-key", "/v1/models?limit=50");
  assert.equal(custom.url, "https://gw.example/v1/models?limit=50");
  assert.equal(custom.headers.authorization, "Bearer sk-key");
  assert.equal(custom.headers["anthropic-version"], "2023-06-01");
  // Written without a leading slash, and relative to a versioned baseUrl.
  assert.equal(discoveryRequest("openai-completions", "https://gw.example/v1", "k", "models").url, "https://gw.example/v1/models");
  // The layout the prefix rule used to refuse: chat under a path, catalogue at the
  // root. A real provider on `https://api.deepseek.com/anthropic` is shaped this way.
  assert.equal(discoveryRequest("anthropic-messages", "https://gw.example/anthropic", "k", "/v1/models").url, "https://gw.example/v1/models");
  assert.equal(discoveryRequest("google-generative-ai", "https://gw.example/v1beta", "g", "/models?pageSize=5").url, "https://gw.example/models?pageSize=5");
  // An empty or whitespace override is not an override.
  assert.equal(discoveryRequest("openai-completions", "https://gw.example/v1", "k", "   ").url, "https://gw.example/v1/models");
  assert.equal(discoveryRequest("openai-completions", "https://gw.example/v1", "k").url, "https://gw.example/v1/models");
  // An unsupported protocol is refused before a path is even considered.
  assert.throws(() => discoveryRequest("something-else", "https://gw.example/v1", "k", "/models"), /协议/);
});

test("a custom path can never move the credential off the gateway", () => {
  const root = "https://gw.example/v1";
  // Origin is the whole boundary, so every way of changing it is refused:
  // an absolute URL, a protocol-relative host, a different scheme or port, and
  // userinfo that makes a foreign host look like a path.
  for (const path of [
    "https://evil.example/models",
    "http://gw.example/v1/models",
    "//evil.example/models",
    "https://gw.example:8443/v1/models",
    "https://user@evil.example/models",
  ]) {
    assert.throws(() => resolveDiscoveryUrl(root, path), /同源/, `escaped via ${path}`);
  }
  // Control characters are refused rather than silently stripped: a header
  // splitting attempt must not be answered as though it were a typo.
  for (const path of ["/v1/ models", "/v1/models\u0000", "/v1\u000d\u000aX: y"]) {
    assert.throws(() => resolveDiscoveryUrl(root, path), /空白或控制字符/, `accepted ${JSON.stringify(path)}`);
  }
  assert.throws(() => resolveDiscoveryUrl(root, ""), /不能为空/);
  // A trailing newline is what pasting from documentation produces, so it is
  // absorbed rather than reported.
  assert.equal(resolveDiscoveryUrl(root, "/v1/models\n"), "https://gw.example/v1/models");
  // Same origin, so allowed even though it leaves the versioned prefix: this is
  // a gateway layout, not an escape.
  assert.equal(resolveDiscoveryUrl(root, "/models"), "https://gw.example/models");
  assert.equal(resolveDiscoveryUrl(root, "../models"), "https://gw.example/models");
  // What must keep working: deeper paths and queries under the same root.
  assert.equal(resolveDiscoveryUrl(root, "/v1/models"), "https://gw.example/v1/models");
  assert.equal(resolveDiscoveryUrl(root, "models?page=2"), "https://gw.example/v1/models?page=2");
  assert.equal(resolveDiscoveryUrl("https://gw.example", "/models"), "https://gw.example/models");
});

test("the default path is stated once, for the browser to show as a placeholder", () => {
  assert.equal(defaultDiscoveryPath("anthropic-messages"), "/v1/models?limit=1000");
  assert.equal(defaultDiscoveryPath("openai-responses"), "/models");
  assert.equal(defaultDiscoveryPath("google-generative-ai"), "/models?pageSize=1000");
  assert.throws(() => defaultDiscoveryPath("nope"), /协议/);
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
    { id: "ok", display_name: "line\nbreak\x07bell" },
    { id: "has space" },
    { id: "ctrl\x01char" },
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
