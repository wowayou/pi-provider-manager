import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
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
