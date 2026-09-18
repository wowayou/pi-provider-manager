import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readJson, readText, writeJsonAtomic } from "../lib/atomic-files.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Deriving the port from the pid collides whenever two runs land on pids that are
// congruent mod 1000, or when something else already holds that port. Ask the OS
// for a free one instead.
// fetch() refuses to set Host, which is a forbidden header name, so rebinding
// has to be simulated with a raw request.
function rawStatus({ port, method, requestPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

// server.mjs resolves PI_PROVIDER_MANAGER_PORT before PI_PROVIDER_MANAGER_API_PORT,
// so a developer who exported the former, as the README suggests, would make the
// child ignore the port the test just picked. AGENT_DIR_SOURCE would likewise
// break the configDirSource assertion.
const INHERITED_OVERRIDES = [
  "PI_PROVIDER_MANAGER_PORT",
  "PI_PROVIDER_MANAGER_API_PORT",
  "PI_PROVIDER_MANAGER_SERVE_UI",
  "PI_PROVIDER_MANAGER_AGENT_DIR_SOURCE",
  "PI_PROVIDER_MANAGER_CODEX_DIR",
  "PI_CODING_AGENT_DIR",
];

function serverEnv(overrides) {
  const env = { ...process.env };
  for (const key of INHERITED_OVERRIDES) delete env[key];
  return { ...env, ...overrides };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url) {
  // detectPiVersion() runs before listen() and, with no nvm-installed pi, falls
  // back to `bash -lic "pi --version"` with an 8s timeout. A budget shorter than
  // that fails on any machine with a heavy shell profile.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start.");
}

// Removing a directory that is a live process's working directory fails on
// Windows with EBUSY, and kill() only asks — it returns long before the process
// is gone. The four tests that spawn a server with cwd inside a temp directory
// have to wait for the exit before they can clean up.
async function stopAndClean(child, dirs, extraPids = []) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  // A restart hands the directory to a process this suite never spawned, so it
  // can only be signalled by pid and then waited out by probing.
  for (const pid of extraPids) {
    if (!(pid > 0)) continue;
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  for (const dir of dirs) {
    // A handle can outlive the process by a few milliseconds, so a single
    // EBUSY is retried rather than failing a test whose assertions all passed.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

async function currentRevision(baseUrl) {
  const response = await fetch(`${baseUrl}/api/state`, { cache: "no-store" });
  assert.equal(response.status, 200);
  return (await response.json()).revision;
}

async function postJson(baseUrl, route, body, revision) {
  const expected = revision === undefined ? await currentRevision(baseUrl) : revision;
  const payload = expected === null ? body : { ...body, revision: expected };
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("writes router-style providers without exposing credentials", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-manager-"));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "any-router": {
        baseUrl: "https://old.example/v1",
        api: "openai-completions",
        futureProviderField: "keep-provider",
        models: [
          {
            id: "anthropic/claude-opus",
            name: "Old Claude",
            reasoning: true,
            input: ["text"],
            contextWindow: 100000,
            maxTokens: 8000,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            futureModelField: "keep-model",
          },
        ],
      },
    },
  }));
  // Shaped like a settings.json a current Pi actually writes: `futureSetting`
  // stands in for a key this manager will never know, and the three beside it
  // are real keys Pi 0.84.4 added — per-model startup thinking levels and two
  // JSON-only terminal overrides. This manager owns none of them, so a save
  // that dropped one would silently undo a Pi setting.
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    futureSetting: "keep-setting",
    modelThinkingLevels: { "any-router/anthropic/claude-opus": "high" },
    fullscreenCopyOnSelect: false,
    terminal: { hyperlinks: "auto", trueColor: true },
  }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_API_PORT: String(port),
      PI_PROVIDER_MANAGER_SERVE_UI: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const uiResponse = await fetch(`${baseUrl}/`);
    assert.equal(uiResponse.status, 200);
    assert.match(uiResponse.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await uiResponse.text(), /<div id="root"><\/div>/);
    const createResponse = await postJson(baseUrl, "/api/providers", {
        providerId: "any-router",
        baseUrl: "https://router.example/v1",
        api: "openai-completions",
        credential: { mode: "new", apiKey: "test-secret-not-real" },
        models: [
          {
            id: "anthropic/claude-opus",
            name: "Claude Opus",
            contextWindow: 200000,
            maxTokens: 16000,
            supportsImages: true,
            reasoning: true,
            maximumThinking: "max",
            api: "anthropic-messages",
          },
          {
            id: "openai/gpt-router",
            name: "GPT Router",
            contextWindow: 128000,
            maxTokens: 16000,
            supportsImages: true,
            reasoning: true,
            maximumThinking: "high",
          },
        ],
        setDefault: true,
        defaultModelId: "anthropic/claude-opus",
        defaultThinkingLevel: "high",
      });
    assert.equal(createResponse.status, 200);
    const createBody = await createResponse.json();
    assert.equal(JSON.stringify(createBody).includes("test-secret-not-real"), false);
    assert.equal(createBody.state.compatibility.configDirSource, "PI_CODING_AGENT_DIR");
    assert.equal(createBody.state.compatibility.servicePort, port);
    assert.equal(createBody.state.providers[0].models.length, 2);
    assert.equal(createBody.state.providers[0].credentialConfigured, true);

    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(auth["any-router"].key, "test-secret-not-real");
    assert.equal(models.providers["any-router"].models.length, 2);
    assert.equal(models.providers["any-router"].models[0].api, "anthropic-messages");
    assert.equal(models.providers["any-router"].futureProviderField, "keep-provider");
    assert.equal(models.providers["any-router"].models[0].futureModelField, "keep-model");
    assert.deepEqual(models.providers["any-router"].models[0].cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    assert.equal(settings.defaultProvider, "any-router");
    assert.equal(settings.defaultModel, "anthropic/claude-opus");

    const migrateResponse = await postJson(baseUrl, "/api/providers", {
        providerId: "new-router",
        baseUrl: "https://new-router.example/v1",
        api: "openai-responses",
        credential: { mode: "migrate", fromProvider: "any-router", move: true },
        models: [
          {
            id: "gpt-5.6-sol",
            contextWindow: 1050000,
            maxTokens: 128000,
            supportsImages: true,
            reasoning: true,
            maximumThinking: "max",
          },
        ],
        setDefault: false,
      });
    assert.equal(migrateResponse.status, 200);
    const migratedAuth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(migratedAuth["any-router"], undefined);
    assert.equal(migratedAuth["new-router"].key, "test-secret-not-real");
    assert.equal(JSON.stringify(await migrateResponse.json()).includes("test-secret-not-real"), false);

    const settingsResponse = await postJson(baseUrl, "/api/settings", {
        defaultProvider: "new-router",
        defaultModel: "gpt-5.6-sol",
        defaultThinkingLevel: "xhigh",
        hideThinkingBlock: true,
        transport: "websocket",
      });
    assert.equal(settingsResponse.status, 200);
    const updatedSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(updatedSettings.defaultProvider, "new-router");
    assert.equal(updatedSettings.defaultModel, "gpt-5.6-sol");
    assert.equal(updatedSettings.defaultThinkingLevel, "xhigh");
    assert.equal(updatedSettings.hideThinkingBlock, true);
    assert.equal(updatedSettings.transport, "websocket");
    assert.equal(updatedSettings.futureSetting, "keep-setting");
    assert.deepEqual(updatedSettings.modelThinkingLevels, { "any-router/anthropic/claude-opus": "high" });
    assert.equal(updatedSettings.fullscreenCopyOnSelect, false);
    assert.deepEqual(updatedSettings.terminal, { hyperlinks: "auto", trueColor: true });
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("handles model Anthropic Beta through the real HTTP boundary", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-manager-beta-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const models = {
    providers: {
      "anthropic-router": { baseUrl: "https://router.example/v1", api: "anthropic-messages", futureProviderField: "keep-provider", models: [
        { id: "claude-one", name: "Claude One", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000, headers: { "anthropic-beta": "context-1m-2025-08-07", "X-Secret": "do-not-return" }, futureModelField: "keep-model" },
        { id: "claude-two", name: "Claude Two", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000, headers: { "ANTHROPIC-BETA": "!external-secret", "X-Secret": "also-hidden" } },
      ] },
      "openai-router": { baseUrl: "https://openai.example/v1", api: "openai-responses", models: [{ id: "gpt", name: "GPT", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }] },
    },
  };
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic-router", defaultModel: "claude-one" }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "anthropic-router": { type: "api_key", key: "beta-key-hidden" }, "openai-router": { type: "api_key", key: "openai-key" } }));
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_CODEX_DIR: path.join(agentDir, "codex") }), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForServer(`${baseUrl}/api/state`);
    const initialResponse = await fetch(`${baseUrl}/api/state`);
    const initial = await initialResponse.json();
    const ant = initial.providers.find((provider) => provider.id === "anthropic-router");
    assert.deepEqual(ant.models[0].anthropicBeta, { kind: "literal", value: "context-1m-2025-08-07" });
    assert.deepEqual(ant.models[1].anthropicBeta, { kind: "external" });
    assert.equal(JSON.stringify(initial).includes("do-not-return"), false);
    const omitted = await postJson(baseUrl, "/api/providers", { providerId: "anthropic-router", baseUrl: ant.baseUrl, api: ant.api, credential: { mode: "keep" }, models: ant.models.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, supportsImages: false, reasoning: true, maximumThinking: "high" })), setDefault: false, defaultModelId: "claude-one" }, initial.revision);
    assert.equal(omitted.status, 200);
    const preserved = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(preserved.providers["anthropic-router"].models[0].headers["anthropic-beta"], "context-1m-2025-08-07");
    assert.equal(preserved.providers["anthropic-router"].models[1].headers["ANTHROPIC-BETA"], "!external-secret");
    const clearState = await (await fetch(`${baseUrl}/api/state`)).json();
    const cleared = await postJson(baseUrl, "/api/providers", { providerId: "anthropic-router", baseUrl: ant.baseUrl, api: ant.api, credential: { mode: "keep" }, models: [{ id: "claude-one", name: "Claude One", contextWindow: 200000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high", anthropicBeta: "" }, { id: "claude-two", name: "Claude Two", contextWindow: 200000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high" }], setDefault: false, defaultModelId: "claude-one" }, clearState.revision);
    assert.equal(cleared.status, 200);
    const afterClear = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(Object.hasOwn(afterClear.providers["anthropic-router"].models[0].headers, "anthropic-beta"), false);
    assert.equal(afterClear.providers["anthropic-router"].models[0].headers["X-Secret"], "do-not-return");
    assert.equal(afterClear.providers["anthropic-router"].models[1].headers["ANTHROPIC-BETA"], "!external-secret");
    // Not gated on protocol. Pi merges model.headers into every API's request,
    // so the header reaches the wire on an OpenAI-protocol model too; a gateway
    // that ignores it is the gateway's business. The gate this used to assert
    // refused a real draft — a gpt model added to an Anthropic-protocol relay.
    const openaiState = await (await fetch(`${baseUrl}/api/state`)).json();
    const onOpenai = await postJson(baseUrl, "/api/providers", { providerId: "openai-router", baseUrl: "https://openai.example/v1", api: "openai-responses", credential: { mode: "keep" }, models: [{ id: "gpt", name: "GPT", contextWindow: 128000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high", anthropicBeta: "context-1m-2025-08-07" }], setDefault: false, defaultModelId: "gpt" }, openaiState.revision);
    assert.equal(onOpenai.status, 200, await onOpenai.text());
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["openai-router"].models[0].headers["anthropic-beta"], "context-1m-2025-08-07");
    const mixedState = await (await fetch(`${baseUrl}/api/state`)).json();
    const allowedMixed = await postJson(baseUrl, "/api/providers", { providerId: "openai-router", baseUrl: "https://openai.example/v1", api: "openai-responses", credential: { mode: "keep" }, models: [{ id: "gpt", name: "GPT", contextWindow: 128000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high", api: "anthropic-messages", anthropicBeta: "beta-a" }], setDefault: false, defaultModelId: "gpt" }, mixedState.revision);
    assert.equal(allowedMixed.status, 200);
    // The shape the report came from: an Anthropic-protocol provider, one model
    // switched to an OpenAI protocol by the per-model override, beta on it.
    const reverseState = await (await fetch(`${baseUrl}/api/state`)).json();
    const overriddenMixed = await postJson(baseUrl, "/api/providers", { providerId: "anthropic-router", baseUrl: "https://router.example/v1", api: "anthropic-messages", credential: { mode: "keep" }, models: [{ id: "claude-one", name: "Claude One", contextWindow: 200000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high", api: "openai-responses", anthropicBeta: "beta-a" }, { id: "claude-two", name: "Claude Two", contextWindow: 200000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high" }], setDefault: false, defaultModelId: "claude-one" }, reverseState.revision);
    assert.equal(overriddenMixed.status, 200, await overriddenMixed.text());
    const afterOverride = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["anthropic-router"].models[0];
    assert.equal(afterOverride.api, "openai-responses");
    assert.equal(afterOverride.headers["anthropic-beta"], "beta-a");
    // Shape is still validated whatever the protocol.
    const badState = await (await fetch(`${baseUrl}/api/state`)).json();
    const beforeBad = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
    const badShape = await postJson(baseUrl, "/api/providers", { providerId: "openai-router", baseUrl: "https://openai.example/v1", api: "openai-responses", credential: { mode: "keep" }, models: [{ id: "gpt", name: "GPT", contextWindow: 128000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high", anthropicBeta: "$BETA" }], setDefault: false, defaultModelId: "gpt" }, badState.revision);
    assert.equal(badShape.status, 400);
    assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), beforeBad);
    const stale = await postJson(baseUrl, "/api/providers", { providerId: "anthropic-router", baseUrl: ant.baseUrl, api: ant.api, credential: { mode: "keep" }, models: [{ id: "claude-one", name: "Claude One", contextWindow: 200000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high", anthropicBeta: "beta-a" }], setDefault: false, defaultModelId: "claude-one" }, "0".repeat(64));
    assert.equal(stale.status, 409);
  } finally { await stopAndClean(child, [agentDir]); }
});
test("discovers a gateway's models with the credential a save would use, and never returns it", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-manager-discover-"));
  const STORED_KEY = "stored-key-not-real";
  const TYPED_KEY = "typed-key-not-real";
  // A stand-in gateway on loopback: OpenAI-shaped under /v1, Anthropic-shaped
  // under /anthropic, plus the answers a wrong address produces.
  const seen = [];
  const gateway = http.createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    const json = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.url === "/v1/models") {
      if (![`Bearer ${STORED_KEY}`, `Bearer ${TYPED_KEY}`].includes(request.headers.authorization)) return json(401, { error: { message: "bad key" } });
      return json(200, { object: "list", data: [{ id: "gw/alpha", object: "model" }, { id: "gw/beta", display_name: "Beta" }, { id: "bad id" }], secret: "gateway-secret-not-real" });
    }
    if (request.url === "/anthropic/v1/models?limit=1000") {
      if (request.headers.authorization !== `Bearer ${TYPED_KEY}` || request.headers["anthropic-version"] !== "2023-06-01") return json(403, { type: "error" });
      return json(200, { data: [{ id: "claude-x", display_name: "Claude X", type: "model" }], has_more: false });
    }
    if (request.url === "/redirect/models") { response.writeHead(302, { Location: `http://127.0.0.1:${gatewayPort}/v1/models` }); response.end(); return; }
    if (request.url === "/html/models") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<html>login</html>"); return; }
    return json(404, { error: "not found" });
  });
  const gatewayPort = await freePort();
  await new Promise((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    "stored-router": { baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", models: [{ id: "gw/alpha", name: "Alpha", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }] },
  } }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stored-router", defaultModel: "gw/alpha" }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    "stored-router": { type: "api_key", key: STORED_KEY },
    "oauth-router": { type: "oauth", access: "oauth-token-not-real" },
  }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port), PI_PROVIDER_MANAGER_CODEX_DIR: path.join(agentDir, "codex") }), stdio: ["ignore", "pipe", "pipe"] });
  const discover = async (body) => {
    const response = await fetch(`${baseUrl}/api/providers/discover-models`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
  const requestsTo = (url) => seen.filter((entry) => entry.url === url).length;
  try {
    await waitForServer(`${baseUrl}/api/state`);
    const kept = await discover({ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" } });
    assert.equal(kept.status, 200, kept.text);
    assert.deepEqual(JSON.parse(kept.text).models, [{ id: "gw/alpha" }, { id: "gw/beta", name: "Beta" }]);
    assert.equal(kept.text.includes(STORED_KEY), false, "the stored key came back to the browser");
    assert.equal(kept.text.includes("gateway-secret"), false, "the gateway body was relayed");
    assert.equal(seen.at(-1).headers.authorization, `Bearer ${STORED_KEY}`, "the stored key was not the one sent");

    const typed = await discover({ baseUrl: `${gatewayUrl}/anthropic`, api: "anthropic-messages", credential: { mode: "new", apiKey: TYPED_KEY } });
    assert.equal(typed.status, 200, typed.text);
    assert.deepEqual(JSON.parse(typed.text).models, [{ id: "claude-x", name: "Claude X" }]);
    assert.equal(seen.at(-1).url, "/anthropic/v1/models?limit=1000", "an Anthropic baseUrl gets /v1 appended, as Pi's client does");
    assert.equal(typed.text.includes(TYPED_KEY), false);

    const migrated = await discover({ baseUrl: `${gatewayUrl}/v1`, api: "openai-responses", credential: { mode: "migrate", fromProvider: "stored-router" } });
    assert.equal(migrated.status, 200, migrated.text);

    // A custom path. This is the deepseek shape, measured against the real
    // gateway: the chat endpoint lives under /anthropic while the catalogue sits
    // at the root, so the default path 404s and only an override reaches it.
    // Deliberately allowed to leave the baseUrl's own path — a prefix rule would
    // refuse a layout that exists — because same origin is what decides who
    // receives the credential, and that host already holds it for every turn.
    const custom = await discover({ baseUrl: `${gatewayUrl}/anthropic`, api: "anthropic-messages", credential: { mode: "new", apiKey: TYPED_KEY }, path: "/v1/models" });
    assert.equal(custom.status, 200, custom.text);
    assert.deepEqual(JSON.parse(custom.text).models, [{ id: "gw/alpha" }, { id: "gw/beta", name: "Beta" }]);
    assert.equal(seen.at(-1).url, "/v1/models", "the override was not the URL asked for");
    assert.equal(JSON.parse(custom.text).endpoint, `${gatewayUrl}/v1/models`, "the dialog is told the full URL that answered");
    assert.equal(custom.text.includes(TYPED_KEY), false);
    // Written without a leading slash, and resolved under the versioned baseUrl.
    const relative = await discover({ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" }, path: "models" });
    assert.equal(relative.status, 200, relative.text);
    assert.equal(seen.at(-1).url, "/v1/models");
    // Blank is not an override: the protocol default still applies.
    const blank = await discover({ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" }, path: "   " });
    assert.equal(blank.status, 200, blank.text);
    assert.equal(seen.at(-1).url, "/v1/models");

    // Refusals happen before any request leaves the machine.
    const before = seen.length;
    for (const [body, pattern] of [
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "nobody" } }, /还没有保存凭据/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "__proto__" } }, /还没有保存凭据/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "migrate", fromProvider: "constructor" } }, /不存在/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "oauth-router" } }, /不是 API Key/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "new", apiKey: "  " } }, /API Key/],
      [{ baseUrl: "http://remote.example/v1", api: "openai-completions", credential: { mode: "new", apiKey: TYPED_KEY } }, /HTTPS/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "not-an-api", credential: { mode: "new", apiKey: TYPED_KEY } }, /协议/],
      // A path is the one field that could aim a stored key at another host.
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" }, path: "https://evil.example/models" }, /同源/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" }, path: "//evil.example/models" }, /同源/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" }, path: "https://user@evil.example/models" }, /同源/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" }, path: "http://127.0.0.1:1/v1/models" }, /同源/],
      [{ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "keep", providerId: "stored-router" }, path: "/v1/ models" }, /空白或控制字符/],
    ]) {
      const refused = await discover(body);
      assert.equal(refused.status, 400, refused.text);
      assert.match(JSON.parse(refused.text).error, pattern);
    }
    assert.equal(seen.length, before, "a refused request still reached the gateway");

    // What the gateway answers is explained, not relayed.
    const rejected = await discover({ baseUrl: `${gatewayUrl}/v1`, api: "openai-completions", credential: { mode: "new", apiKey: "wrong-key" } });
    assert.equal(rejected.status, 400);
    assert.match(JSON.parse(rejected.text).error, /拒绝了这个凭据（HTTP 401）/);
    assert.equal(rejected.text.includes("bad key"), false);
    const listed = requestsTo("/v1/models");
    const redirected = await discover({ baseUrl: `${gatewayUrl}/redirect`, api: "openai-completions", credential: { mode: "new", apiKey: TYPED_KEY } });
    assert.equal(redirected.status, 400);
    assert.match(JSON.parse(redirected.text).error, /重定向/);
    assert.equal(requestsTo("/v1/models"), listed, "the redirect was followed with the credential");
    const html = await discover({ baseUrl: `${gatewayUrl}/html`, api: "openai-completions", credential: { mode: "new", apiKey: TYPED_KEY } });
    assert.equal(html.status, 400);
    assert.match(JSON.parse(html.text).error, /不是 JSON/);
    const missing = await discover({ baseUrl: `${gatewayUrl}/nowhere`, api: "openai-completions", credential: { mode: "new", apiKey: TYPED_KEY } });
    assert.equal(missing.status, 400);
    assert.match(JSON.parse(missing.text).error, /手动填写/);
    const closedPort = await freePort();
    const unreachable = await discover({ baseUrl: `http://127.0.0.1:${closedPort}/v1`, api: "openai-completions", credential: { mode: "new", apiKey: TYPED_KEY } });
    assert.equal(unreachable.status, 400);
    assert.match(JSON.parse(unreachable.text).error, /无法连接网关/);
    assert.equal(unreachable.text.includes(TYPED_KEY), false);

    // The same cross-origin guards as every other write.
    assert.equal(await rawStatus({ port, method: "POST", requestPath: "/api/providers/discover-models", headers: { host: "attacker.example", "content-type": "application/json" }, body: "{}" }), 403);
    assert.equal(await rawStatus({ port, method: "POST", requestPath: "/api/providers/discover-models", headers: { host: `127.0.0.1:${port}`, "content-type": "text/plain" }, body: "{}" }), 415);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await stopAndClean(child, [agentDir]);
  }
});

test("keeps provider UA three-state semantics and never exposes model headers", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-user-agent-"));
  const providerSecret = "provider-header-secret-not-a-secret";
  const modelSecret = "model-header-secret-not-a-secret";
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    "ua-router": { type: "api_key", key: "ua-router-key-not-a-secret" },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "ua-router": {
        baseUrl: "https://router.example/v1",
        api: "openai-completions",
        headers: { "User-Agent": "$UA_FROM_ENV", "X-Provider-Secret": providerSecret },
        modelOverrides: {
          "model/one": { headers: { "User-Agent": "!secret-command", "X-Override-Secret": "override-secret" } },
        },
        models: [{
          id: "model/one",
          name: "model/one",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 16000,
          headers: { "User-Agent": "!secret-command", "X-Model-Secret": modelSecret },
          futureModelField: "keep-model",
        }],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "ua-router",
    defaultModel: "model/one",
  }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_CODEX_DIR: path.join(agentDir, "codex"),
      PI_PROVIDER_MANAGER_API_PORT: String(port),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const readFile = (name) => JSON.parse(fs.readFileSync(path.join(agentDir, name), "utf8"));
  const submittedModel = {
    id: "model/one",
    name: "model/one",
    contextWindow: 200000,
    maxTokens: 16000,
    supportsImages: false,
    reasoning: true,
    maximumThinking: "high",
  };
  const submit = (body) => postJson(baseUrl, "/api/providers", {
    providerId: "ua-router",
    baseUrl: "https://router.example/v1",
    api: "openai-completions",
    credential: { mode: "keep" },
    models: [submittedModel],
    setDefault: false,
    ...body,
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const initialResponse = await fetch(`${baseUrl}/api/state`);
    const initial = await initialResponse.json();
    const initialText = JSON.stringify(initial);
    assert.equal(initialText.includes(providerSecret), false);
    assert.equal(initialText.includes(modelSecret), false);
    assert.equal(initialText.includes("secret-command"), false);
    assert.deepEqual(initial.providers[0].userAgent, { kind: "external" });
    assert.equal(initial.providers[0].hasModelUserAgentOverride, true);
    assert.equal("headers" in initial.providers[0].models[0], false);
    assert.equal("futureModelField" in initial.providers[0].models[0], false);

    const setResponse = await submit({ userAgent: "  manager/1.0  " });
    assert.equal(setResponse.status, 200);
    const setBody = await setResponse.json();
    assert.deepEqual(setBody.state.providers[0].userAgent, { kind: "literal", value: "manager/1.0" });
    assert.equal(JSON.stringify(setBody).includes(modelSecret), false);
    const setHeaders = readFile("models.json").providers["ua-router"].headers;
    assert.deepEqual(setHeaders, { "X-Provider-Secret": providerSecret, "User-Agent": "manager/1.0" });
    assert.equal(readFile("models.json").providers["ua-router"].models[0].futureModelField, "keep-model");

    const clearResponse = await submit({ userAgent: "" });
    assert.equal(clearResponse.status, 200);
    assert.deepEqual((await clearResponse.json()).state.providers[0].userAgent, { kind: "none" });
    assert.deepEqual(readFile("models.json").providers["ua-router"].headers, { "X-Provider-Secret": providerSecret });

    const externallyEdited = readFile("models.json");
    externallyEdited.providers["ua-router"].headers["User-Agent"] = "$RETAIN_ME";
    fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(externallyEdited, null, 2)}\n`);
    const preservedResponse = await submit({});
    assert.equal(preservedResponse.status, 200);
    assert.equal(readFile("models.json").providers["ua-router"].headers["User-Agent"], "$RETAIN_ME");
    assert.deepEqual((await preservedResponse.json()).state.providers[0].userAgent, { kind: "external" });

    const beforeInvalid = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
    const invalidResponse = await submit({ userAgent: "bad\nvalue" });
    assert.equal(invalidResponse.status, 400);
    assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), beforeInvalid);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("rejects stale writes after another process changes Pi configuration", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-revision-"));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    router: { type: "api_key", key: "revision-test-key" },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      router: {
        baseUrl: "https://router.example/v1",
        api: "openai-completions",
        models: [{ id: "model/one", name: "model/one", contextWindow: 128000, maxTokens: 16000 }],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "router",
    defaultModel: "model/one",
  }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const provider = {
    providerId: "router",
    baseUrl: "https://stale.example/v1",
    api: "openai-completions",
    credential: { mode: "keep" },
    models: [{
      id: "model/one",
      name: "model/one",
      contextWindow: 128000,
      maxTokens: 16000,
      supportsImages: false,
      reasoning: true,
      maximumThinking: "high",
    }],
    setDefault: false,
  };

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const initialState = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    assert.match(initialState.revision, /^[a-f0-9]{64}$/);

    const missingRevision = await postJson(baseUrl, "/api/providers", provider, null);
    assert.equal(missingRevision.status, 409);
    assert.match((await missingRevision.json()).error, /重新读取配置/);

    const externallyEdited = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    externallyEdited.providers.router.baseUrl = "https://cc-switch.example/v1";
    externallyEdited.providers.router.externalEditorField = "keep-external-change";
    fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(externallyEdited, null, 2)}\n`);
    const externalBytes = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");

    const stale = await postJson(baseUrl, "/api/providers", provider, initialState.revision);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /其他程序或标签页/);
    assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), externalBytes);
    assert.equal(JSON.parse(externalBytes).providers.router.externalEditorField, "keep-external-change");

    const freshState = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    assert.notEqual(freshState.revision, initialState.revision);
    const freshSave = await postJson(baseUrl, "/api/providers", {
      ...provider,
      baseUrl: "https://fresh.example/v1",
    }, freshState.revision);
    assert.equal(freshSave.status, 200);
    const savedBody = await freshSave.json();
    assert.notEqual(savedBody.state.revision, freshState.revision);
    const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(saved.providers.router.baseUrl, "https://fresh.example/v1");
    assert.equal(saved.providers.router.externalEditorField, "keep-external-change");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});


test("refuses to drop the model settings.json points at unless a new default is named", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-default-guard-"));
  const model = (id, extra = {}) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 16000,
    ...extra,
  });
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    "any-router": { type: "api_key", key: "router-key-not-a-secret" },
    "side-router": { type: "api_key", key: "side-key-not-a-secret" },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "any-router": {
        baseUrl: "https://router.example/v1",
        api: "openai-completions",
        models: [
          model("anthropic/claude-opus", { futureModelField: "keep-model" }),
          model("openai/gpt-router"),
          model("google/gemini-router"),
        ],
      },
      "side-router": {
        baseUrl: "https://side.example/v1",
        api: "openai-completions",
        models: [model("side/one")],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "any-router",
    defaultModel: "anthropic/claude-opus",
    defaultThinkingLevel: "high",
  }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const submit = (body) => postJson(baseUrl, "/api/providers", body);
  const submitted = (id, extra = {}) => ({
    id,
    name: id,
    contextWindow: 200000,
    maxTokens: 16000,
    supportsImages: false,
    reasoning: true,
    maximumThinking: "high",
    ...extra,
  });
  const readAgentFile = (name) => JSON.parse(fs.readFileSync(path.join(agentDir, name), "utf8"));

  try {
    await waitForServer(`${baseUrl}/api/state`);

    // The list no longer carries settings.defaultModel, and setDefault is false,
    // so nothing would rewrite settings.json: this has to be refused outright.
    const droppedDefault = await submit({
      providerId: "any-router",
      baseUrl: "https://router.example/v1",
      api: "openai-completions",
      credential: { mode: "keep" },
      models: [submitted("openai/gpt-router"), submitted("google/gemini-router")],
      setDefault: false,
    });
    assert.equal(droppedDefault.status, 400);
    assert.match((await droppedDefault.json()).error, /anthropic\/claude-opus/);
    assert.equal(readAgentFile("models.json").providers["any-router"].models.length, 3);
    assert.equal(readAgentFile("settings.json").defaultModel, "anthropic/claude-opus");

    // Dropping a model the default does not point at is ordinary editing.
    const droppedOther = await submit({
      providerId: "any-router",
      baseUrl: "https://router.example/v1",
      api: "openai-completions",
      credential: { mode: "keep" },
      models: [submitted("anthropic/claude-opus"), submitted("openai/gpt-router")],
      setDefault: false,
    });
    assert.equal(droppedOther.status, 200);
    assert.equal(readAgentFile("models.json").providers["any-router"].models.length, 2);
    assert.equal(readAgentFile("models.json").providers["any-router"].models[0].futureModelField, "keep-model");
    assert.equal(readAgentFile("settings.json").defaultModel, "anthropic/claude-opus");

    // Same shape on a provider settings.json does not point at: also fine.
    const droppedElsewhere = await submit({
      providerId: "side-router",
      baseUrl: "https://side.example/v1",
      api: "openai-completions",
      credential: { mode: "keep" },
      models: [submitted("side/two")],
      setDefault: false,
    });
    assert.equal(droppedElsewhere.status, 200);
    assert.equal(readAgentFile("settings.json").defaultProvider, "any-router");

    // Naming the replacement is what makes the removal legal.
    const withNewDefault = await submit({
      providerId: "any-router",
      baseUrl: "https://router.example/v1",
      api: "openai-completions",
      credential: { mode: "keep" },
      models: [submitted("openai/gpt-router")],
      setDefault: true,
      defaultModelId: "openai/gpt-router",
      defaultThinkingLevel: "high",
    });
    assert.equal(withNewDefault.status, 200);
    const settings = readAgentFile("settings.json");
    assert.equal(settings.defaultProvider, "any-router");
    assert.equal(settings.defaultModel, "openai/gpt-router");
    assert.equal(readAgentFile("models.json").providers["any-router"].models.length, 1);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("deletes providers transactionally and can retain credentials", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-provider-delete-"));
  const model = (id, extra = {}) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 16000,
    ...extra,
  });
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    "default-router": { type: "api_key", key: "default-key-not-a-secret", futureAuthField: "keep-auth" },
    "replacement-router": { type: "api_key", key: "replacement-key-not-a-secret" },
    "disposable-router": { type: "api_key", key: "disposable-key-not-a-secret" },
    "credential-only": { type: "api_key", key: "orphan-key-not-a-secret" },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    futureRootField: "keep-root",
    providers: {
      "default-router": {
        baseUrl: "https://default.example/v1",
        api: "openai-completions",
        models: [model("default/model")],
      },
      "replacement-router": {
        baseUrl: "https://replacement.example/v1",
        api: "openai-completions",
        futureProviderField: "keep-provider",
        models: [model("replacement/model", { futureModelField: "keep-model" })],
      },
      "disposable-router": {
        baseUrl: "https://disposable.example/v1",
        api: "openai-completions",
        models: [model("disposable/model")],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "default-router",
    defaultModel: "default/model",
    defaultThinkingLevel: "high",
    futureSetting: "keep-setting",
  }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const submit = (body) => postJson(baseUrl, "/api/providers/delete", body);
  const readAgentFile = (name) => JSON.parse(fs.readFileSync(path.join(agentDir, name), "utf8"));
  const submittedModel = (id) => ({
    id,
    name: id,
    contextWindow: 200000,
    maxTokens: 16000,
    supportsImages: false,
    reasoning: true,
    maximumThinking: "high",
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const initialState = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
    assert.deepEqual(initialState.providers.map((provider) => provider.id), [
      "default-router",
      "disposable-router",
      "replacement-router",
    ]);
    assert.equal(initialState.authProviders.includes("credential-only"), true);

    const originals = new Map([
      ["auth.json", fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")],
      ["models.json", fs.readFileSync(path.join(agentDir, "models.json"), "utf8")],
      ["settings.json", fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")],
    ]);
    const missingReplacement = await submit({ providerId: "default-router", keepCredential: true });
    assert.equal(missingReplacement.status, 400);
    assert.match((await missingReplacement.json()).error, /另一个有效供应商/);
    const wrongReplacement = await submit({
      providerId: "default-router",
      keepCredential: true,
      replacementProviderId: "replacement-router",
      replacementModelId: "not/there",
    });
    assert.equal(wrongReplacement.status, 400);
    assert.match((await wrongReplacement.json()).error, /替代模型不属于/);
    for (const [name, contents] of originals) {
      assert.equal(fs.readFileSync(path.join(agentDir, name), "utf8"), contents);
    }

    for (const providerId of ["constructor", "toString", "__proto__", "missing-router"]) {
      const invalid = await submit({ providerId });
      assert.equal(invalid.status, 400);
    }

    const retained = await submit({
      providerId: "default-router",
      keepCredential: true,
      replacementProviderId: "replacement-router",
      replacementModelId: "replacement/model",
    });
    assert.equal(retained.status, 200);
    const retainedBody = await retained.json();
    assert.equal(JSON.stringify(retainedBody).includes("default-key-not-a-secret"), false);
    assert.equal(retainedBody.state.providers.some((provider) => provider.id === "default-router"), false);
    assert.equal(retainedBody.state.authProviders.includes("default-router"), true);
    assert.equal(retainedBody.state.settings.defaultProvider, "replacement-router");
    assert.equal(retainedBody.state.settings.defaultModel, "replacement/model");

    const retainedAuth = readAgentFile("auth.json");
    const retainedModels = readAgentFile("models.json");
    const retainedSettings = readAgentFile("settings.json");
    assert.equal(retainedAuth["default-router"].futureAuthField, "keep-auth");
    assert.equal(retainedModels.providers["default-router"], undefined);
    assert.equal(retainedModels.futureRootField, "keep-root");
    assert.equal(retainedModels.providers["replacement-router"].futureProviderField, "keep-provider");
    assert.equal(retainedModels.providers["replacement-router"].models[0].futureModelField, "keep-model");
    assert.equal(retainedSettings.futureSetting, "keep-setting");

    // The retained entry is useful only if a later save can reuse it without
    // asking the user to paste the key again.
    const reconfigured = await postJson(baseUrl, "/api/providers", {
        providerId: "default-router",
        baseUrl: "https://reconfigured.example/v1",
        api: "openai-completions",
        credential: { mode: "keep" },
        models: [submittedModel("reconfigured/model")],
        setDefault: false,
      });
    assert.equal(reconfigured.status, 200);
    assert.equal(JSON.stringify(await reconfigured.json()).includes("default-key-not-a-secret"), false);
    assert.equal(readAgentFile("models.json").providers["default-router"].models[0].id, "reconfigured/model");
    assert.equal(readAgentFile("auth.json")["default-router"].key, "default-key-not-a-secret");

    // Only the JSON boolean true retains a credential; truthy strings from a
    // direct API call must not weaken the default-delete contract.
    const removed = await submit({ providerId: "disposable-router", keepCredential: "false" });
    assert.equal(removed.status, 200);
    const removedBody = await removed.json();
    assert.equal(removedBody.state.providers.some((provider) => provider.id === "disposable-router"), false);
    assert.equal(removedBody.state.authProviders.includes("disposable-router"), false);
    assert.equal(readAgentFile("auth.json")["disposable-router"], undefined);
    assert.equal(readAgentFile("models.json").providers["disposable-router"], undefined);
    assert.equal(readAgentFile("settings.json").defaultProvider, "replacement-router");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("rejects cross-origin and rebound requests, and bogus credential sources", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-security-"));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ acme: { type: "api_key", key: "real-key-not-a-secret" } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({}));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const provider = {
    providerId: "attacker",
    baseUrl: "https://gateway.attacker.example/v1",
    api: "openai-responses",
    models: [{ id: "m", name: "m", contextWindow: 128000, maxTokens: 8192 }],
    setDefault: true,
    defaultModelId: "m",
  };

  try {
    await waitForServer(`${baseUrl}/api/state`);

    // A form-style cross-origin POST stays a "simple request" only without
    // application/json, which is exactly what must not be accepted.
    const simpleRequest = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: "https://evil.example" },
      body: JSON.stringify({ ...provider, credential: { mode: "migrate", fromProvider: "acme" } }),
    });
    assert.equal(simpleRequest.status, 415);

    // DNS rebinding makes the attacker same-origin, so only the Host header is left to catch it.
    const reboundBody = JSON.stringify({ ...provider, credential: { mode: "migrate", fromProvider: "acme" } });
    const rebound = await rawStatus({
      port,
      method: "POST",
      requestPath: "/api/providers",
      headers: { Host: "evil.example", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reboundBody) },
      body: reboundBody,
    });
    assert.equal(rebound, 403);
    assert.equal(await rawStatus({ port, method: "GET", requestPath: "/api/state", headers: { Host: "evil.example" } }), 403);
    // The allowlisted names must still work.
    assert.equal(await rawStatus({ port, method: "GET", requestPath: "/api/state", headers: { Host: `localhost:${port}` } }), 200);

    // Neither attempt may have touched the stored credential.
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.deepEqual(Object.keys(auth), ["acme"]);
    assert.equal(auth.acme.key, "real-key-not-a-secret");

    // A prototype-chain name must not pass as a migration source and blank the real key.
    for (const fromProvider of ["__proto__", "constructor", "toString"]) {
      const response = await postJson(baseUrl, "/api/providers", {
        ...provider,
        providerId: "acme",
        credential: { mode: "migrate", fromProvider },
      });
      assert.equal(response.status, 400, `${fromProvider} must be rejected`);
    }
    const afterProto = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(afterProto.acme.key, "real-key-not-a-secret");

    const settingsProto = await postJson(baseUrl, "/api/settings", { defaultProvider: "__proto__", defaultModel: "m" });
    assert.equal(settingsProto.status, 400);

    // The app's own requests still work.
    const legitimate = await postJson(baseUrl, "/api/providers", {
      ...provider,
      providerId: "mirror",
      credential: { mode: "migrate", fromProvider: "acme", move: false },
    });
    assert.equal(legitimate.status, 200);
    const finalAuth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(finalAuth.mirror.key, "real-key-not-a-secret");
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("reports which settings keys exist and allows the theme bootstrap through CSP", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-state-"));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({}));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  // Only one of the five keys this screen owns is actually stored.
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "only-this-one" }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_API_PORT: String(port),
      PI_PROVIDER_MANAGER_SERVE_UI: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    // Every value is normalized, so presence cannot be inferred from the values.
    assert.equal(state.settings.transport, "auto");
    assert.equal(state.settings.defaultThinkingLevel, "medium");
    assert.deepEqual(state.settingsPresent, ["defaultModel"]);

    // The validated Pi version has exactly one home; the payload must quote it
    // rather than carry a copy that can drift from package.json.
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    assert.ok(manifest.piValidatedVersion, "package.json must declare piValidatedVersion");
    assert.equal(state.compatibility.validatedPiVersion, manifest.piValidatedVersion);

    // The theme bootstrap must run before first paint, so it is inline and the
    // policy has to name it by hash rather than block it.
    const uiResponse = await fetch(`${baseUrl}/`);
    const policy = uiResponse.headers.get("content-security-policy");
    const html = await uiResponse.text();
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(inline.length > 0, "index.html should still carry the inline theme bootstrap");
    for (const [, source] of inline) {
      const digest = crypto.createHash("sha256").update(source, "utf8").digest("base64");
      assert.ok(policy.includes(`'sha256-${digest}'`), "CSP must allow the inline bootstrap by hash");
    }
    assert.ok(!policy.includes("unsafe-inline") || !/script-src[^;]*unsafe-inline/.test(policy));
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// Pi 0.84.3 made its own auth.json reader tolerate a UTF-8 BOM (auth-storage.js
// gained stripBom). Found by diffing 0.84.2 against 0.84.3 and then running both
// against a config this manager generated: 0.84.3 read a BOM'd auth.json that
// 0.84.2 and this manager both refused. A file Pi accepts must not be a file this
// manager rejects — and the byte is invisible in an editor, so the error names
// something the reader cannot see. Notepad writes one, and Windows is supported.
test("a UTF-8 BOM does not stop this manager reading what Pi reads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-bom-"));
  try {
    const models = path.join(dir, "models.json");
    fs.writeFileSync(models, "﻿" + JSON.stringify({ providers: { gw: { name: "GW" } } }));
    assert.deepEqual(readJson(models), { providers: { gw: { name: "GW" } } });

    // Prompt bodies do not fail to parse, so the BOM would instead travel into
    // the prompt text and back out to the next save.
    const prompt = path.join(dir, "AGENTS.md");
    fs.writeFileSync(prompt, "﻿# Rules\n");
    assert.equal(readText(prompt), "# Rules\n");

    // Stripped on read only: nothing here writes one back.
    writeJsonAtomic(models, { providers: {} });
    assert.equal(fs.readFileSync(models, "utf8").charCodeAt(0), "{".charCodeAt(0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A manager is upgraded by updating the checkout, but the process already
// running keeps serving the code it loaded — so every number on the
// compatibility card stays at the old release until someone restarts it. That
// read as an upgrade that had silently failed. The panel has to be able to say
// which version is running and which one is waiting on disk.
test("reports a checkout that has moved ahead of the running process", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-upgrade-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-upgrade-agent-"));
  const manifestPath = path.join(projectDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  fs.copyFileSync(path.join(projectRoot, "server.mjs"), path.join(projectDir, "server.mjs"));
  fs.cpSync(path.join(projectRoot, "lib"), path.join(projectDir, "lib"), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const started = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(started.compatibility.appVersion, manifest.version);
    // Nothing to announce while the two agree: the note has to stay absent
    // during the state everyone is normally in.
    assert.equal(started.compatibility.pendingAppVersion, "");

    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "9.9.9" }));
    const upgraded = await (await fetch(`${baseUrl}/api/state`)).json();
    // The running version must not follow the file: it names the code in
    // memory, and claiming the new one would hide exactly the problem.
    assert.equal(upgraded.compatibility.appVersion, manifest.version);
    assert.equal(upgraded.compatibility.pendingAppVersion, "9.9.9");

    fs.rmSync(manifestPath);
    // An unreadable manifest is not evidence of an upgrade.
    const removed = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(removed.compatibility.appVersion, manifest.version);
    assert.equal(removed.compatibility.pendingAppVersion, "");
  } finally {
    await stopAndClean(child, [projectDir, agentDir]);
  }
});

// Applying an upgrade means running the code now on disk, which no process can do
// to itself. The panel offers the restart, so this endpoint has to do the handover
// — and the whole point of doing it here rather than telling someone to `kill` a
// pid is that the manager can guarantee the outcome either way.
test("a restart hands the port to a manager started from the files on disk", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-restart-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-restart-agent-"));
  const manifestPath = path.join(projectDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  fs.copyFileSync(path.join(projectRoot, "server.mjs"), path.join(projectDir, "server.mjs"));
  fs.cpSync(path.join(projectRoot, "lib"), path.join(projectDir, "lib"), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    // No pipes. This is how the launcher's WSL branch starts the manager, and it is
    // the configuration that exposes a handoff depending on the event loop: with a
    // pipe on stdout the handle keeps the loop alive and the settle window runs by
    // accident, which is how an unref'd retry timer hid here while a detached
    // instance exited in the middle of the window and never reclaimed.
    stdio: ["ignore", "ignore", "ignore"],
  });
  let replacementPid = 0;

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const before = (await (await fetch(`${baseUrl}/api/state`)).json()).compatibility;

    // The upgrade: the same manager, a later version, waiting on disk.
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "9.9.9" }));

    const accepted = await postJson(baseUrl, "/api/restart", {}, null);
    // Answered before the handover, and it names the process being replaced:
    // waiting for "a different pid" is the only reliable readiness signal.
    assert.equal(accepted.status, 202);
    const acknowledged = await accepted.json();
    assert.equal(acknowledged.pid, before.servicePid);
    assert.equal(acknowledged.pendingAppVersion, "9.9.9");

    const deadline = Date.now() + 30_000;
    let after;
    while (Date.now() < deadline) {
      try {
        const state = await (await fetch(`${baseUrl}/api/state`)).json();
        if (state.compatibility.servicePid !== before.servicePid) {
          after = state;
          break;
        }
      } catch {
        // The port is unowned for a moment between the two processes.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(after, "no replacement took the port");
    replacementPid = after.compatibility.servicePid;
    // The manager on the port is the upgraded one, and it has nothing left to
    // announce: the version it runs is the version on disk.
    assert.equal(after.compatibility.appVersion, "9.9.9");
    assert.equal(after.compatibility.pendingAppVersion, "");
    assert.equal(after.restartError, "");
    assert.equal(after.agentDir, agentDir, "the replacement kept the directories it was given");
    // The handoff writes its own account to a file, because the only other one was
    // a `process.stdout` line the launcher's WSL branch discarded entirely. This
    // is the record that did not exist when a handoff left nothing on the port.
    const handoff = fs.readFileSync(path.join(agentDir, "pi-provider-manager-restart.log"), "utf8");
    assert.match(handoff, new RegExp(`handoff requested old=${before.servicePid} version=`));
    assert.match(handoff, new RegExp(`spawned replacement pid=\\d+ old=${before.servicePid}`));
    assert.match(handoff, new RegExp(`handoff complete replaced-by=${replacementPid} old=${before.servicePid}`));
    // And the replacement announces itself, naming the process it replaced: a start
    // that bound the port and then died is otherwise two pids with no relation.
    assert.match(handoff, new RegExp(`listening pid=${replacementPid} port=${port} version=9\\.9\\.9 replacing=${before.servicePid}`));
  } finally {
    await stopAndClean(child, [projectDir, agentDir], [replacementPid]);
  }
});

// The launcher's WSL branch used to run the manager with its output going to a
// hidden console, so a server that died on startup left a refused connection and
// no message anywhere — the state this whole log exists to end. The Windows path
// cannot redirect it either (Start-Process refuses one file for both streams), so
// the manager is told where to write and tees its own output there.
test("a manager that dies on startup says why in its own log", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-log-agent-"));
  const port = await freePort();
  const holderLog = path.join(agentDir, "holder.log");
  const crashLog = path.join(agentDir, "crash.log");
  const restartLog = path.join(agentDir, "pi-provider-manager-restart.log");
  const holder = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_PORT: String(port),
      PI_PROVIDER_MANAGER_LOG: holderLog,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`http://127.0.0.1:${port}/api/state`);
    assert.match(fs.readFileSync(holderLog, "utf8"), /Pi Provider Manager API listening/);

    // A second manager on the same port cannot bind. Node's report for that goes
    // straight to the descriptor, past process.stdout and process.stderr, so the
    // tee alone would miss it — this asserts it is captured anyway.
    const crash = spawnSync(process.execPath, [path.join(projectRoot, "server.mjs")], {
      cwd: projectRoot,
      env: serverEnv({
        PI_CODING_AGENT_DIR: agentDir,
        PI_PROVIDER_MANAGER_PORT: String(port),
        PI_PROVIDER_MANAGER_LOG: crashLog,
      }),
      encoding: "utf8",
    });
    assert.notEqual(crash.status, 0, "binding a used port has to fail");
    // A bind failure is a reported failure, not a crash: `server.listen` raises an
    // 'error' event, and an unhandled one kills the process where it stands with
    // nothing but a refused connection left behind.
    assert.match(fs.readFileSync(crashLog, "utf8"), /EADDRINUSE/);
    assert.match(fs.readFileSync(crashLog, "utf8"), /端口已被占用/);
    assert.match(fs.readFileSync(restartLog, "utf8"), /listen failed: EADDRINUSE/);
  } finally {
    await stopAndClean(holder, [agentDir]);
  }
});

// The handoff that had no witness. A replacement that binds the port, answers the
// readiness probe and then dies left the old process already gone, nothing on the
// port, and — because `restartError` is a variable in the memory of the process
// that just exited — nothing anywhere. Answering once is not taking over, so the
// port is only surrendered once the replacement is still answering at the end of a
// settle window.
test("a replacement that answers and then dies is taken back", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-restart-late-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-restart-late-agent-"));
  const serverPath = path.join(projectDir, "server.mjs");
  fs.copyFileSync(path.join(projectRoot, "server.mjs"), serverPath);
  fs.cpSync(path.join(projectRoot, "lib"), path.join(projectDir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, "package.json"), path.join(projectDir, "package.json"));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_PORT: String(port) }),
    // Console-less, like the launcher: the settle window has to run with nothing
    // else holding the event loop, which is the only configuration where the
    // reclaim this test asserts actually happens.
    stdio: ["ignore", "ignore", "ignore"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const before = (await (await fetch(`${baseUrl}/api/state`)).json()).compatibility;

    // The half-written upgrade: the replacement starts, binds the port, answers,
    // and only then dies on something that happens after it is up. Timed off the
    // port rather than off startup, because the version detection before listen
    // can take seconds — a fixed delay from module evaluation would kill it before
    // it ever bound, which is the *other* failure, already covered below.
    const original = fs.readFileSync(serverPath, "utf8");
    fs.writeFileSync(serverPath, `${original}\n{
  const port = Number(process.env.PI_PROVIDER_MANAGER_PORT);
  const giveUpAt = Date.now() + 30_000;
  const look = setInterval(() => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      clearInterval(look);
      setTimeout(() => process.exit(7), 1_500);
    });
    socket.on("error", () => { if (Date.now() > giveUpAt) clearInterval(look); });
  }, 100);
}\n`);

    assert.equal((await postJson(baseUrl, "/api/restart", {}, null)).status, 202);

    const deadline = Date.now() + 40_000;
    let recovered;
    while (Date.now() < deadline) {
      try {
        const state = await (await fetch(`${baseUrl}/api/state`)).json();
        if (state.restartError) {
          recovered = state;
          break;
        }
      } catch {
        // The port is unowned while the handover is attempted.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(recovered, "the old manager never came back");
    // The same process is serving again: the replacement is gone, and the port was
    // reclaimed rather than left unowned.
    assert.equal(recovered.compatibility.servicePid, before.servicePid);
    assert.match(recovered.restartError, /新进程接管端口后立刻退出/);
    const handoff = fs.readFileSync(path.join(agentDir, "pi-provider-manager-restart.log"), "utf8");
    // The account says it answered first, which is what makes this a different
    // failure from a replacement that never came up.
    assert.match(handoff, /replacement answered pid=\d+; watching it for \d+ms/);
    assert.match(handoff, /handoff failed: 重启没有成功：新进程接管端口后立刻退出/);
    // And it is not claiming a handoff that did not happen.
    assert.equal(/handoff complete/.test(handoff), false);
  } finally {
    await stopAndClean(child, [projectDir, agentDir]);
  }
});

// The launcher's WSL branch starts the manager on a console that dies with the
// session that opened it, and the next write to it arrives as an 'error' event on
// the stream — which, unhandled, is an uncaught exception. Measured on a real
// instance: that is what killed a replacement milliseconds after it had bound the
// port, and what left the reported incident with nothing on the port and nothing
// written down. The reader going away is modelled with a destroyed pipe, which
// fails the same way (`write EPIPE`, same unhandled 'error').
test("a manager whose output reader goes away keeps serving", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-output-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-output-agent-"));
  const serverPath = path.join(projectDir, "server.mjs");
  fs.copyFileSync(path.join(projectRoot, "server.mjs"), serverPath);
  fs.cpSync(path.join(projectRoot, "lib"), path.join(projectDir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, "package.json"), path.join(projectDir, "package.json"));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = path.join(agentDir, "output.log");
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env: serverEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_PORT: String(port),
      PI_PROVIDER_MANAGER_LOG: logPath,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const before = (await (await fetch(`${baseUrl}/api/state`)).json()).compatibility;

    // The console goes away. Nothing is left to read what the manager writes.
    child.stdout.destroy();
    child.stderr.destroy();

    // A replacement that cannot start, so the manager has a reason to write to
    // its console — the failure path reports `restartError` on stdout.
    fs.writeFileSync(serverPath, 'throw new Error("this upgrade is broken");\n');
    assert.equal((await postJson(baseUrl, "/api/restart", {}, null)).status, 202);

    const deadline = Date.now() + 30_000;
    let recovered;
    while (Date.now() < deadline) {
      try {
        const state = await (await fetch(`${baseUrl}/api/state`)).json();
        if (state.restartError) {
          recovered = state;
          break;
        }
      } catch {
        // The port is unowned while the handover is attempted.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(recovered, "the manager died with its console instead of reporting the failure");
    assert.equal(recovered.compatibility.servicePid, before.servicePid);
    assert.match(recovered.restartError, /新进程启动后立刻退出/);
    // The failed write is recorded rather than fatal, and recorded once.
    const handoff = fs.readFileSync(path.join(agentDir, "pi-provider-manager-restart.log"), "utf8");
    assert.match(handoff, /output stream failed; further writes to it are dropped rather than fatal: EPIPE/);
    assert.equal(handoff.match(/output stream failed/g).length, 1);
  } finally {
    await stopAndClean(child, [projectDir, agentDir]);
  }
});

// The failure that matters is a replacement that cannot start — a bad upgrade, a
// half-written file. Left unhandled it would take the working manager down with
// it: nothing on the port, and no page left to say why.
test("a replacement that cannot start leaves the old manager serving, and says why", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-restart-fail-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-restart-fail-agent-"));
  const serverPath = path.join(projectDir, "server.mjs");
  fs.copyFileSync(path.join(projectRoot, "server.mjs"), serverPath);
  fs.cpSync(path.join(projectRoot, "lib"), path.join(projectDir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(projectRoot, "package.json"), path.join(projectDir, "package.json"));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const before = (await (await fetch(`${baseUrl}/api/state`)).json()).compatibility;

    // This process is already running its own copy of the code, so replacing the
    // file underneath it only breaks the process started from it next.
    fs.writeFileSync(serverPath, 'throw new Error("this upgrade is broken");\n');

    assert.equal((await postJson(baseUrl, "/api/restart", {}, null)).status, 202);

    const deadline = Date.now() + 30_000;
    let recovered;
    while (Date.now() < deadline) {
      try {
        const state = await (await fetch(`${baseUrl}/api/state`)).json();
        if (state.restartError) {
          recovered = state;
          break;
        }
      } catch {
        // The listening socket is closed while the handover is attempted.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(recovered, "the old manager never came back");
    // Same process, still serving, and the reason is on the state everyone reads.
    assert.equal(recovered.compatibility.servicePid, before.servicePid);
    assert.match(recovered.restartError, /新进程启动后立刻退出/);
    // The failure is also on disk. `restartError` lives in the memory of a process
    // that a later handoff may replace, so it cannot be the only account.
    const handoff = fs.readFileSync(path.join(agentDir, "pi-provider-manager-restart.log"), "utf8");
    assert.match(handoff, new RegExp(`handoff requested old=${before.servicePid} version=`));
    assert.match(handoff, /handoff failed: 重启没有成功：新进程启动后立刻退出/);
    // Not stuck: a second attempt is accepted rather than refused as in-flight.
    assert.equal((await postJson(baseUrl, "/api/restart", {}, null)).status, 202);
  } finally {
    await stopAndClean(child, [projectDir, agentDir]);
  }
});

// The update endpoints reach GitHub, so what is tested here is everything around
// that: no test in this suite makes an upstream request, for the same reason the
// application makes none on startup or on a page load. The lookup, the install
// detection and the two apply shapes are covered against injected commands and
// responses in tests/self-update.test.mjs.
test("updating refuses in order: unchecked, then unapplicable", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-update-agent-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    // Nothing has been asked for, so nothing has been looked up: a page load that
    // reported a latest version would mean a page load had reached the network.
    assert.deepEqual(
      {
        checkedAt: state.update.checkedAt,
        latestVersion: state.update.latestVersion,
        running: state.update.running,
        error: state.update.error,
      },
      { checkedAt: "", latestVersion: "", running: false, error: "" },
    );
    assert.deepEqual(state.update.steps, []);

    // Applying before checking has nothing to apply, and says that rather than
    // reaching for a release on its own.
    const early = await postJson(baseUrl, "/api/update/apply", {}, null);
    assert.equal(early.status, 400);
    assert.match((await early.json()).error, /先检查更新/);

    // Still nothing running after a refusal.
    assert.equal((await (await fetch(`${baseUrl}/api/state`)).json()).update.running, false);

  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// An upgrade that pulls and then fails to build leaves the source tree newer than
// the bundle being served. Restarting there is the one outcome of a half-finished
// upgrade that looks like it worked: a new server behind the previous page. The
// panel has to say so, and the endpoint has to refuse even if the page asking is
// older than this rule.
test("a bundle older than its sources blocks the restart, and says which", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-stale-bundle-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-stale-agent-"));
  fs.copyFileSync(path.join(projectRoot, "server.mjs"), path.join(projectDir, "server.mjs"));
  fs.copyFileSync(path.join(projectRoot, "package.json"), path.join(projectDir, "package.json"));
  fs.cpSync(path.join(projectRoot, "lib"), path.join(projectDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "dist", "client"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "dist", "client", "index.html"), "<!doctype html>");
  fs.mkdirSync(path.join(projectDir, "src"));
  fs.writeFileSync(path.join(projectDir, "src", "App.jsx"), "// older than the bundle\n");
  // The bundle is built from the sources, so an equal-or-newer bundle is the
  // ordinary state. Set every mtime explicitly, in whole seconds: the rule takes
  // the newest of a directory *and* its entries, so leaving src/'s own mtime at
  // "just now" makes the fixture stale before the test has done anything — which
  // is how this first ran green here and red on a CI runner.
  const built = Math.floor(Date.now() / 1000);
  for (const target of [path.join(projectDir, "src", "App.jsx"), path.join(projectDir, "src")]) {
    fs.utimesSync(target, built - 120, built - 120);
  }
  fs.utimesSync(path.join(projectDir, "dist", "client", "index.html"), built, built);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectDir, "server.mjs")], {
    cwd: projectDir,
    env: serverEnv({
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_PORT: String(port),
      PI_PROVIDER_MANAGER_SERVE_UI: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const fresh = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(fresh.compatibility.bundleProblem, "");

    // A pull is what does this: every file it changes gets a current mtime.
    fs.utimesSync(path.join(projectDir, "src", "App.jsx"), built + 60, built + 60);
    assert.equal(fs.statSync(path.join(projectDir, "src", "App.jsx")).mtimeMs > fs.statSync(path.join(projectDir, "dist", "client", "index.html")).mtimeMs, true);
    const stale = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.match(stale.compatibility.bundleProblem, /dist\/client 比 src\/ 旧/);

    const refused = await postJson(baseUrl, "/api/restart", {}, null);
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /dist\/client 比 src\/ 旧/);
    // Still the same process: the refusal happened before any handover.
    const after = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.equal(after.compatibility.servicePid, fresh.compatibility.servicePid);

    // Building is what clears it, and the state says so without a restart.
    fs.utimesSync(path.join(projectDir, "dist", "client", "index.html"), built + 180, built + 180);
    assert.equal((await (await fetch(`${baseUrl}/api/state`)).json()).compatibility.bundleProblem, "");
  } finally {
    await stopAndClean(child, [projectDir, agentDir]);
  }
});
