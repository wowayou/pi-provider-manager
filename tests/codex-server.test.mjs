import assert from "node:assert/strict";
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

const INHERITED_OVERRIDES = [
  "PI_PROVIDER_MANAGER_PORT",
  "PI_PROVIDER_MANAGER_API_PORT",
  "PI_PROVIDER_MANAGER_SERVE_UI",
  "PI_PROVIDER_MANAGER_AGENT_DIR_SOURCE",
  "PI_PROVIDER_MANAGER_CODEX_DIR",
  "PI_CODING_AGENT_DIR",
  "CODEX_HOME",
];

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
  // detectPiVersion/detectCodexVersion both run before listen() and fall back to
  // `bash -lic` with an 8s timeout when neither CLI is installed.
  const deadline = Date.now() + 30_000;
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

// Spawns the production-shaped server against throwaway Pi and Codex directories
// and hands the body back to the caller, tearing everything down afterwards.
async function withServer(configToml, run) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-codex-"));
  if (configToml !== null) fs.writeFileSync(path.join(codexDir, "config.toml"), configToml);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of INHERITED_OVERRIDES) delete env[key];
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: {
      ...env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_PROVIDER_MANAGER_CODEX_DIR: codexDir,
      PI_PROVIDER_MANAGER_API_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const api = {
    baseUrl,
    codexDir,
    configPath: path.join(codexDir, "config.toml"),
    authPath: path.join(codexDir, "auth.json"),
    storePath: path.join(codexDir, "pi-provider-manager-store.json"),
    async state() {
      const response = await fetch(`${baseUrl}/api/state`, { cache: "no-store" });
      assert.equal(response.status, 200);
      return response.json();
    },
    async post(route, body, revision) {
      const expected = revision === undefined ? (await api.state()).codex.revision : revision;
      return fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expected === null ? body : { ...body, revision: expected }),
      });
    },
    config() {
      return fs.readFileSync(api.configPath, "utf8");
    },
    auth() {
      return JSON.parse(fs.readFileSync(api.authPath, "utf8"));
    },
  };
  try {
    await waitForServer(`${baseUrl}/api/state`);
    await run(api);
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
}

const SECRET = "sk-codex-not-a-real-key";
const OTHER_SECRET = "sk-codex-second-not-real";

const HAND_WRITTEN = `# my own note, keep it
model_provider = "custom"
model = "gpt-5.6-sol"

[model_providers.custom]
name = "现成的供应商"
base_url = "https://existing.example/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.myown]
# a table this manager does not own
base_url = "https://hand-written.example/v1"
wire_api = "responses"

[profiles.custom-hand-written]
model = "kept"

[tui]
notifications = true
`;

function newProvider(overrides = {}) {
  return {
    providerId: "packy",
    name: "PackyCode",
    baseUrl: "https://packy.example/v1",
    upstream: "direct",
    requiresAuth: true,
    credential: { mode: "new", apiKey: SECRET },
    models: [{ id: "gpt-5.6-sol", reasoningEffort: "high" }],
    defaultModelId: "gpt-5.6-sol",
    setActive: true,
    ...overrides,
  };
}

test("adopts an existing config.toml without writing to it", async () => {
  await withServer(HAND_WRITTEN, async (api) => {
    const before = fs.statSync(api.configPath).mtimeMs;
    const { codex } = await api.state();
    assert.equal(codex.available, true);
    assert.equal(codex.ownedProviderId, "custom");
    const active = codex.providers.find((provider) => provider.isActive);
    assert.equal(active.name, "现成的供应商");
    assert.equal(active.baseUrl, "https://existing.example/v1");
    assert.equal(active.adopted, true);
    // The adopted provider shows the model config.toml really points at.
    assert.deepEqual(active.models.map((model) => model.id), ["gpt-5.6-sol"]);
    // Reading state must not rewrite the user's files.
    assert.equal(fs.statSync(api.configPath).mtimeMs, before);
    assert.equal(fs.existsSync(api.storePath), false);
    assert.equal(api.config(), HAND_WRITTEN);
  });
});

test("writes the vendor-shaped table and never returns the key", async () => {
  await withServer(null, async (api) => {
    const response = await api.post("/api/codex/providers", newProvider());
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(SECRET), false);

    const config = api.config();
    assert.match(config, /^model_provider = "custom"$/m);
    assert.match(config, /^model = "gpt-5\.6-sol"$/m);
    assert.match(config, /^model_reasoning_effort = "high"$/m);
    assert.match(config, /^\[model_providers\.custom\]$/m);
    assert.match(config, /^name = "PackyCode"$/m);
    assert.match(config, /^base_url = "https:\/\/packy\.example\/v1"$/m);
    assert.match(config, /^wire_api = "responses"$/m);
    assert.match(config, /^requires_openai_auth = true$/m);
    // env_key would make Codex demand an environment variable and fail hard
    // when it is unset, which defeats storing the key in auth.json.
    assert.equal(/env_key/.test(config), false);

    assert.deepEqual(api.auth(), { auth_mode: "apikey", OPENAI_API_KEY: SECRET });
    const { codex } = await api.state();
    assert.equal(codex.activeProviderId, "packy");
    assert.equal(codex.providers[0].credentialConfigured, true);
    assert.equal(JSON.stringify(codex).includes(SECRET), false);
  });
});

test("keeps the store and auth files private", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions only");
  await withServer(null, async (api) => {
    await api.post("/api/codex/providers", newProvider());
    assert.equal(fs.statSync(api.storePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(api.authPath).mode & 0o777, 0o600);
  });
});

test("switching providers replaces the owned table with no residue", async () => {
  await withServer(null, async (api) => {
    // A bridge that needs no key writes requires_openai_auth = false.
    let response = await api.post("/api/codex/providers", newProvider({
      providerId: "bridge",
      name: "Local bridge",
      baseUrl: "http://127.0.0.1:4000/v1",
      upstream: "bridge",
      requiresAuth: false,
      credential: { mode: "keep" },
      models: [{ id: "deepseek-chat", reasoningEffort: "medium" }],
      defaultModelId: "deepseek-chat",
    }));
    assert.equal(response.status, 200);
    assert.match(api.config(), /^requires_openai_auth = false$/m);
    // A provider Codex will not authenticate must not touch auth.json, which
    // may hold a ChatGPT login.
    assert.equal(fs.existsSync(api.authPath), false);

    response = await api.post("/api/codex/providers", newProvider());
    assert.equal(response.status, 200);
    const config = api.config();
    assert.equal(/requires_openai_auth = false/.test(config), false);
    assert.equal(/127\.0\.0\.1:4000/.test(config), false);
    assert.equal((config.match(/\[model_providers\./g) || []).length, 1);

    response = await api.post("/api/codex/activate", { providerId: "bridge" });
    assert.equal(response.status, 200);
    assert.match(api.config(), /^base_url = "http:\/\/127\.0\.0\.1:4000\/v1"$/m);
    // The previous provider's key is still remembered, so switching back does
    // not ask for it again.
    const { codex } = await api.state();
    assert.equal(codex.providers.find((provider) => provider.id === "packy").credentialConfigured, true);
  });
});

test("leaves hand-written tables, comments and profiles alone", async () => {
  await withServer(HAND_WRITTEN, async (api) => {
    let response = await api.post("/api/codex/providers", newProvider());
    assert.equal(response.status, 200);
    response = await api.post("/api/codex/providers", newProvider({
      providerId: "kimi",
      name: "Kimi",
      baseUrl: "https://kimi.example/v1",
      credential: { mode: "new", apiKey: OTHER_SECRET },
      models: [{ id: "kimi-k2.6", reasoningEffort: "medium" }],
      defaultModelId: "kimi-k2.6",
    }));
    assert.equal(response.status, 200);

    const config = api.config();
    assert.match(config, /^# my own note, keep it$/m);
    assert.match(config, /^\[model_providers\.myown\]$/m);
    assert.match(config, /^# a table this manager does not own$/m);
    assert.match(config, /^base_url = "https:\/\/hand-written\.example\/v1"$/m);
    assert.match(config, /^\[tui\]$/m);
    assert.match(config, /^notifications = true$/m);
    // A profile sharing the generated prefix but written by hand survives:
    // cleanup deletes the recorded list, not everything matching a prefix.
    assert.match(config, /^\[profiles\.custom-hand-written\]$/m);
    assert.match(config, /^model = "kept"$/m);
  });
});

test("generates one profile per model and cleans up the previous set", async () => {
  await withServer(null, async (api) => {
    let response = await api.post("/api/codex/providers", newProvider({
      models: [
        { id: "gpt-5.6-sol", reasoningEffort: "high" },
        { id: "gpt-5.1-codex", reasoningEffort: "medium" },
      ],
    }));
    assert.equal(response.status, 200);
    let config = api.config();
    assert.match(config, /^\[profiles\.custom\]$/m);
    assert.match(config, /^\[profiles\.custom-gpt-5-1-codex\]$/m);
    assert.match(config, /^model_provider = "custom"$/m);

    // Dropping a model must drop the profile it generated.
    response = await api.post("/api/codex/providers", newProvider());
    assert.equal(response.status, 200);
    config = api.config();
    assert.match(config, /^\[profiles\.custom\]$/m);
    assert.equal(/profiles\.custom-gpt-5-1-codex/.test(config), false);
  });
});

test("rejects a stale revision without touching disk", async () => {
  await withServer(null, async (api) => {
    await api.post("/api/codex/providers", newProvider());
    const before = api.config();
    const stale = "0".repeat(64);
    const response = await api.post("/api/codex/providers", newProvider({ name: "Renamed" }), stale);
    assert.equal(response.status, 409);
    assert.equal(api.config(), before);
  });
});

test("refuses Codex's built-in provider ids for the owned table", async () => {
  await withServer(null, async (api) => {
    await api.post("/api/codex/providers", newProvider());
    for (const ownedProviderId of ["openai", "ollama", "lmstudio"]) {
      const response = await api.post("/api/codex/settings", { ownedProviderId });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /保留/);
    }
  });
});

test("refuses to delete the active provider without a replacement", async () => {
  await withServer(null, async (api) => {
    await api.post("/api/codex/providers", newProvider());
    await api.post("/api/codex/providers", newProvider({
      providerId: "kimi",
      name: "Kimi",
      baseUrl: "https://kimi.example/v1",
      credential: { mode: "new", apiKey: OTHER_SECRET },
      models: [{ id: "kimi-k2.6", reasoningEffort: "medium" }],
      defaultModelId: "kimi-k2.6",
      setActive: false,
    }));

    let response = await api.post("/api/codex/providers/delete", { providerId: "packy" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /接替/);

    response = await api.post("/api/codex/providers/delete", {
      providerId: "packy",
      replacementProviderId: "kimi",
    });
    assert.equal(response.status, 200);
    assert.match(api.config(), /^base_url = "https:\/\/kimi\.example\/v1"$/m);
    assert.equal(api.auth().OPENAI_API_KEY, OTHER_SECRET);
    const { codex } = await api.state();
    assert.deepEqual(codex.providers.map((provider) => provider.id), ["kimi"]);
    assert.equal(fs.readFileSync(api.storePath, "utf8").includes(SECRET), false);
  });
});

test("bridge-check only ever probes the local machine", async () => {
  await withServer(null, async (api) => {
    const bridge = http.createServer((_request, response) => {
      response.writeHead(401);
      response.end();
    });
    await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
    const bridgePort = bridge.address().port;
    try {
      let response = await api.post("/api/codex/bridge-check", {
        baseUrl: `http://127.0.0.1:${bridgePort}/v1`,
      }, null);
      assert.equal(response.status, 200);
      // Any answer, 401 included, means something is listening. It does not
      // mean the bridge is the right one.
      assert.deepEqual(await response.json(), { status: "listening", httpStatus: 401 });

      for (const baseUrl of [
        "https://example.com/v1",
        // The prefix is the trap: a substring match on "127.0.0.1" would send
        // the probe to an attacker-controlled host.
        "https://127.0.0.1.attacker.example/v1",
        // http to anywhere but loopback is refused before the probe stage.
        "http://example.com/v1",
      ]) {
        response = await api.post("/api/codex/bridge-check", { baseUrl }, null);
        assert.equal(response.status, 400, `expected ${baseUrl} to be refused`);
      }

      // The decimal spelling of 127.0.0.1 really is loopback, and URL parsing
      // normalizes it before the guard sees it — so it is allowed, and the
      // probe stays on this machine.
      response = await api.post("/api/codex/bridge-check", { baseUrl: "https://2130706433/v1" }, null);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "refused");
    } finally {
      bridge.close();
    }

    const refused = await api.post("/api/codex/bridge-check", {
      baseUrl: `http://127.0.0.1:${bridgePort}/v1`,
    }, null);
    assert.equal(refused.status, 200);
    assert.equal((await refused.json()).status, "refused");
  });
});
