import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_API_PORT: String(port),
      PI_PROVIDER_MANAGER_SERVE_UI: "1",
    },
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
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
