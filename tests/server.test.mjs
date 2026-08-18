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
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ futureSetting: "keep-setting" }));
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
    const createResponse = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
            baseUrl: "https://router.example",
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
      }),
    });
    assert.equal(createResponse.status, 200);
    const createBody = await createResponse.json();
    assert.equal(JSON.stringify(createBody).includes("test-secret-not-real"), false);
    assert.equal(createBody.state.compatibility.configDirSource, "PI_CODING_AGENT_DIR");
    assert.equal(createBody.state.compatibility.servicePort, port);
    assert.equal(createBody.state.providers[0].models.length, 2);
    assert.equal(createBody.state.providers[0].credentialConfigured, true);

    const unsafeModelUrlResponse = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "any-router",
        baseUrl: "https://router.example/v1",
        api: "openai-completions",
        credential: { mode: "keep" },
        models: [{
          id: "unsafe-model",
          contextWindow: 128000,
          maxTokens: 16000,
          api: "anthropic-messages",
          baseUrl: "http://gateway.example",
        }],
        setDefault: false,
      }),
    });
    assert.equal(unsafeModelUrlResponse.status, 400);
    assert.match((await unsafeModelUrlResponse.json()).error, /HTTPS/);

    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(auth["any-router"].key, "test-secret-not-real");
    assert.equal(models.providers["any-router"].models.length, 2);
    assert.equal(models.providers["any-router"].models[0].api, "anthropic-messages");
    assert.equal(models.providers["any-router"].models[0].baseUrl, "https://router.example");
    assert.equal(createBody.state.providers[0].models[0].baseUrl, "https://router.example");
    assert.equal(models.providers["any-router"].futureProviderField, "keep-provider");
    assert.equal(models.providers["any-router"].models[0].futureModelField, "keep-model");
    assert.deepEqual(models.providers["any-router"].models[0].cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    assert.equal(settings.defaultProvider, "any-router");
    assert.equal(settings.defaultModel, "anthropic/claude-opus");

    const migrateResponse = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
    });
    assert.equal(migrateResponse.status, 200);
    const migratedAuth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(migratedAuth["any-router"], undefined);
    assert.equal(migratedAuth["new-router"].key, "test-secret-not-real");
    assert.equal(JSON.stringify(await migrateResponse.json()).includes("test-secret-not-real"), false);

    const settingsResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultProvider: "new-router",
        defaultModel: "gpt-5.6-sol",
        defaultThinkingLevel: "xhigh",
        hideThinkingBlock: true,
        transport: "websocket",
      }),
    });
    assert.equal(settingsResponse.status, 200);
    const updatedSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(updatedSettings.defaultProvider, "new-router");
    assert.equal(updatedSettings.defaultModel, "gpt-5.6-sol");
    assert.equal(updatedSettings.defaultThinkingLevel, "xhigh");
    assert.equal(updatedSettings.hideThinkingBlock, true);
    assert.equal(updatedSettings.transport, "websocket");
    assert.equal(updatedSettings.futureSetting, "keep-setting");

    const deleteDefaultResponse = await fetch(`${baseUrl}/api/providers/new-router`, { method: "DELETE" });
    assert.equal(deleteDefaultResponse.status, 200);
    const afterDefaultDelete = await deleteDefaultResponse.json();
    assert.equal(afterDefaultDelete.state.providers.some((provider) => provider.id === "new-router"), false);
    assert.equal(afterDefaultDelete.state.providers.some((provider) => provider.id === "any-router"), true);
    const fallbackSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(fallbackSettings.defaultProvider, "any-router");
    assert.equal(fallbackSettings.defaultModel, "anthropic/claude-opus");
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["new-router"], undefined);

    const deleteLastResponse = await fetch(`${baseUrl}/api/providers/any-router`, { method: "DELETE" });
    assert.equal(deleteLastResponse.status, 200);
    const finalSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(finalSettings.defaultProvider, undefined);
    assert.equal(finalSettings.defaultModel, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["any-router"], undefined);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("discovers remote model catalogs only on explicit requests without mutating config", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-discovery-"));
  const authPath = path.join(agentDir, "auth.json");
  const modelsPath = path.join(agentDir, "models.json");
  const settingsPath = path.join(agentDir, "settings.json");
  fs.writeFileSync(authPath, JSON.stringify({ router: { type: "api_key", key: "stored-catalog-secret" } }));
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: { router: { api: "openai-responses", baseUrl: "https://gateway.invalid/v1", models: [] } } }));
  fs.writeFileSync(settingsPath, JSON.stringify({ futureSetting: "keep" }));
  const originals = new Map([
    [authPath, fs.readFileSync(authPath, "utf8")],
    [modelsPath, fs.readFileSync(modelsPath, "utf8")],
    [settingsPath, fs.readFileSync(settingsPath, "utf8")],
  ]);
  const gatewayPort = await freePort();
  const gatewayRequests = [];
  const gateway = http.createServer((request, response) => {
    gatewayRequests.push({ url: request.url, headers: request.headers });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "gpt-one" }, { id: "gpt-two" }, { id: "gpt-one" }] }));
      return;
    }
    if (request.url === "/v1beta/models") {
      response.end(JSON.stringify({ models: [{ name: "models/gemini-pro", displayName: "Gemini Pro" }] }));
      return;
    }
    if (request.url === "/redirect/models") {
      response.statusCode = 302;
      response.setHeader("Location", `http://127.0.0.1:${gatewayPort}/redirect-target`);
      response.end(JSON.stringify({ redirected: true }));
      return;
    }
    if (request.url === "/huge/models") {
      response.end(JSON.stringify({ data: [{ id: "x".repeat(2_100_000) }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "missing" }));
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(gatewayPort, "127.0.0.1", resolve);
  });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: serverEnv({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_API_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
    const openAiResponse = await fetch(`${baseUrl}/api/providers/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "router",
        api: "openai-responses",
        baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
        credential: { mode: "keep" },
      }),
    });
    assert.equal(openAiResponse.status, 200);
    const openAiBody = await openAiResponse.json();
    assert.deepEqual(openAiBody.models.map((model) => model.id), ["gpt-one", "gpt-two"]);
    assert.equal(JSON.stringify(openAiBody).includes("stored-catalog-secret"), false);
    assert.equal(gatewayRequests[0].url, "/v1/models");
    assert.equal(gatewayRequests[0].headers.authorization, "Bearer stored-catalog-secret");

    const googleResponse = await fetch(`${baseUrl}/api/providers/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "router",
        api: "google-generative-ai",
        baseUrl: `http://127.0.0.1:${gatewayPort}`,
        credential: { mode: "keep" },
      }),
    });
    assert.equal(googleResponse.status, 200);
    const googleBody = await googleResponse.json();
    assert.deepEqual(googleBody.models, [{ id: "gemini-pro", name: "Gemini Pro" }]);
    assert.equal(gatewayRequests[1].url, "/v1beta/models");
    assert.equal(gatewayRequests[1].headers["x-goog-api-key"], "stored-catalog-secret");

    const redirectResponse = await fetch(`${baseUrl}/api/providers/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "router",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${gatewayPort}/redirect`,
        credential: { mode: "keep" },
      }),
    });
    assert.equal(redirectResponse.status, 400);
    assert.match((await redirectResponse.json()).error, /重定向/);
    assert.equal(gatewayRequests.length, 3);

    const oversizedResponse = await fetch(`${baseUrl}/api/providers/discover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "router",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${gatewayPort}/huge`,
        credential: { mode: "keep" },
      }),
    });
    assert.equal(oversizedResponse.status, 400);
    assert.match((await oversizedResponse.json()).error, /2 MB/);

    for (const [filePath, original] of originals) {
      assert.equal(fs.readFileSync(filePath, "utf8"), original);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => gateway.close(resolve));
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
      const response = await fetch(`${baseUrl}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...provider, providerId: "acme", credential: { mode: "migrate", fromProvider } }),
      });
      assert.equal(response.status, 400, `${fromProvider} must be rejected`);
    }
    const afterProto = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(afterProto.acme.key, "real-key-not-a-secret");

    const settingsProto = await fetch(`${baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultProvider: "__proto__", defaultModel: "m" }),
    });
    assert.equal(settingsProto.status, 400);

    // The app's own requests still work.
    const legitimate = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...provider, providerId: "mirror", credential: { mode: "migrate", fromProvider: "acme", move: false } }),
    });
    assert.equal(legitimate.status, 200);
    const finalAuth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(finalAuth.mirror.key, "real-key-not-a-secret");
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("reports settings presence, allows the theme bootstrap, and stops cleanly", async () => {
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

    const exited = new Promise((resolve) => child.once("exit", resolve));
    const stopResult = spawnSync("bash", [path.join(projectRoot, "bin", "pi-provider-manager-ui"), "stop"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: serverEnv({ PI_PROVIDER_MANAGER_PORT: String(port) }),
    });
    assert.equal(stopResult.status, 0, stopResult.stderr);
    assert.match(stopResult.stdout, new RegExp(`Stopped Pi Provider Manager on port ${port}`));
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Server did not stop.")), 3000)),
    ]);
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
