import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  const port = 44000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_API_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(`${baseUrl}/api/state`);
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
    assert.equal(createBody.state.providers[0].models.length, 2);
    assert.equal(createBody.state.providers[0].credentialConfigured, true);

    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(auth["any-router"].key, "test-secret-not-real");
    assert.equal(models.providers["any-router"].models.length, 2);
    assert.equal(models.providers["any-router"].models[0].api, "anthropic-messages");
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
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
