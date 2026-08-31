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
name = "Hand written"
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

test("writes no profile tables at all", async () => {
  // Codex 0.149.0 demoted `[profiles.*]` in config.toml to legacy and refuses
  // `--profile <name>` outright while a matching table is present, so a table
  // written here breaks the very command it exists to enable.
  await withServer(null, async (api) => {
    const response = await api.post("/api/codex/providers", newProvider({
      models: [
        { id: "gpt-5.6-sol", reasoningEffort: "high" },
        { id: "gpt-5.1-codex", reasoningEffort: "medium" },
      ],
    }));
    assert.equal(response.status, 200);
    const config = api.config();
    assert.match(config, /^model_provider = "custom"$/m);
    assert.equal(/^\[profiles\./m.test(config), false, "no profile table may be written");
  });
});

test("removes the profile tables older versions wrote, and only those", async () => {
  // Anyone who used v0.2.0 or v0.2.1 has these in their config.toml already.
  // Leaving them there keeps `codex --profile custom` failing forever, so the
  // next save has to clear them — without touching one the user wrote.
  const legacy = `model_provider = "custom"

[model_providers.custom]
name = "Existing"
base_url = "https://existing.example/v1"
wire_api = "responses"
requires_openai_auth = true

[profiles.custom]
model = "gpt-5.6-sol"
model_provider = "custom"

[profiles.custom-gpt-5-1-codex]
model = "gpt-5.1-codex"
model_provider = "custom"

[profiles.custom-hand-written]
model = "kept"
`;
  await withServer(legacy, async (api) => {
    // The ledger an older release left behind, naming what it generated.
    fs.writeFileSync(api.storePath, JSON.stringify({
      version: 1,
      ownedProviderId: "custom",
      activeProviderId: "",
      generatedProfiles: ["custom", "custom-gpt-5-1-codex"],
      providers: {},
    }));

    const response = await api.post("/api/codex/providers", newProvider());
    assert.equal(response.status, 200);

    const config = api.config();
    assert.equal(/^\[profiles\.custom\]$/m.test(config), false, "the generated profile must go");
    assert.equal(/^\[profiles\.custom-gpt-5-1-codex\]$/m.test(config), false);
    // Not in the ledger, so not ours to delete — even sharing the prefix.
    assert.match(config, /^\[profiles\.custom-hand-written\]$/m);
    assert.match(config, /^model = "kept"$/m);

    const store = JSON.parse(fs.readFileSync(api.storePath, "utf8"));
    assert.deepEqual(store.generatedProfiles, [], "the ledger is emptied once acted on");
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
      // The probe is a TCP connect, so a server that answers 401 — or that has
      // no /v1/models at all — still counts as listening. It does not mean the
      // bridge is the right one.
      assert.deepEqual(await response.json(), { status: "listening" });

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
      assert.equal((await response.json()).status, "no-answer");
    } finally {
      bridge.close();
    }

    const gone = await api.post("/api/codex/bridge-check", {
      baseUrl: `http://127.0.0.1:${bridgePort}/v1`,
    }, null);
    assert.equal(gone.status, 200);
    // Refused and timed out collapse to one answer: nothing replied.
    assert.equal((await gone.json()).status, "no-answer");
  });
});

test("settings keep the reasoning effort the user just chose", async () => {
  await withServer(null, async (api) => {
    await api.post("/api/codex/providers", newProvider());
    assert.match(api.config(), /^model_reasoning_effort = "high"$/m);

    // The active model owns model_reasoning_effort, so a settings change has to
    // reach it too; otherwise rewriting the provider table reverts the key and
    // the control silently does nothing.
    const response = await api.post("/api/codex/settings", {
      reasoningEffort: "xhigh",
      planModeReasoningEffort: "medium",
      verbosity: "low",
    });
    assert.equal(response.status, 200);
    const config = api.config();
    assert.match(config, /^model_reasoning_effort = "xhigh"$/m);
    assert.match(config, /^plan_mode_reasoning_effort = "medium"$/m);
    assert.match(config, /^model_verbosity = "low"$/m);
    // The effort the user just chose, rather than the value stored earlier.
    assert.equal(/model_reasoning_effort = "high"/.test(config), false);

    const { codex } = await api.state();
    assert.equal(codex.settings.reasoningEffort, "xhigh");
    assert.equal(codex.providers.find((provider) => provider.id === "packy").models[0].reasoningEffort, "xhigh");
  });
});

test("editing settings does not demand a key for the provider already in use", async () => {
  // The adopted provider has no stored credential, because config.toml cannot
  // carry one. Changing an unrelated setting must not be blocked by that.
  await withServer(HAND_WRITTEN, async (api) => {
    const before = await api.state();
    assert.equal(before.codex.providers[0].credentialConfigured, false);

    const response = await api.post("/api/codex/settings", { reasoningEffort: "low" });
    assert.equal(response.status, 200);
    assert.match(api.config(), /^model_reasoning_effort = "low"$/m);
    // auth.json belongs to Codex's own login state; a settings edit never
    // invents one.
    assert.equal(fs.existsSync(api.authPath), false);
  });
});

test("switching to a provider whose key is missing is still refused", async () => {
  await withServer(HAND_WRITTEN, async (api) => {
    const adoptedId = (await api.state()).codex.providers[0].id;
    await api.post("/api/codex/providers", newProvider());
    const response = await api.post("/api/codex/activate", { providerId: adoptedId });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /需要 API Key/);
    // The refusal left the working provider in place.
    assert.match(api.config(), /^base_url = "https:\/\/packy\.example\/v1"$/m);
    assert.equal(api.auth().OPENAI_API_KEY, SECRET);
  });
});

test("adopting a loopback provider does not claim it is a bridge", async () => {
  const local = HAND_WRITTEN.replace("https://existing.example/v1", "http://127.0.0.1:15721/v1");
  await withServer(local, async (api) => {
    const active = (await api.state()).codex.providers.find((provider) => provider.isActive);
    assert.equal(active.baseUrl, "http://127.0.0.1:15721/v1");
    // It may be a bridge, another local proxy, or a local model server. The
    // manager has no way to tell, so it stores no upstream shape at all and
    // claims no bridge: a bridge exists only when the user configured one here.
    assert.equal(Object.hasOwn(active, "upstream"), false);
    assert.equal(active.bridge, null);
  });
});

test("a bridged provider points Codex at the local proxy and keeps the upstream key out of reach", async () => {
  await withServer(null, async (api) => {
    const upstreamSecret = "sk-upstream-not-a-real-key";
    const response = await api.post("/api/codex/providers", newProvider({
      providerId: "chatonly",
      name: "Chat-only gateway",
      baseUrl: "https://ignored.example/v1",
      credential: { mode: "keep" },
      bridge: { upstreamBaseUrl: "https://chatonly.example/v1", apiKey: upstreamSecret },
      models: [{ id: "deepseek-chat", reasoningEffort: "medium" }],
      defaultModelId: "deepseek-chat",
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(upstreamSecret), false);

    const config = api.config();
    // Codex talks to the proxy on this machine, not to the upstream, and needs
    // no credential of its own.
    assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:43210\/v1"$/m);
    assert.match(config, /^requires_openai_auth = false$/m);
    assert.equal(config.includes("chatonly.example"), false);
    // A provider Codex will not authenticate must not touch auth.json.
    assert.equal(fs.existsSync(api.authPath), false);

    // LiteLLM's config is generated, and the upstream key is referenced through
    // the environment rather than written into it.
    const yaml = fs.readFileSync(path.join(api.codexDir, "pi-provider-manager-litellm.yaml"), "utf8");
    assert.match(yaml, /^ {6}api_base: "https:\/\/chatonly\.example\/v1"$/m);
    assert.match(yaml, /^ {6}use_chat_completions_api: true$/m);
    assert.equal(yaml.includes(upstreamSecret), false);

    const { codex } = await api.state();
    const provider = codex.providers.find((item) => item.id === "chatonly");
    assert.equal(provider.bridge.upstreamBaseUrl, "https://chatonly.example/v1");
    assert.equal(provider.bridge.credentialConfigured, true);
    assert.equal(JSON.stringify(codex).includes(upstreamSecret), false);
    assert.equal(codex.bridge.running, false);
  });
});

test("refuses a bridge with no upstream key", async () => {
  await withServer(null, async (api) => {
    const response = await api.post("/api/codex/providers", newProvider({
      providerId: "chatonly",
      credential: { mode: "keep" },
      bridge: { upstreamBaseUrl: "https://chatonly.example/v1" },
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /上游的 API Key/);
  });
});

test("refuses an upstream address submitted as the upstream key", async () => {
  // The two bridge fields sit next to each other in the form. Every layer below
  // this one accepts a URL in the key slot: LiteLLM starts, Codex connects, and
  // the only symptom is a 401 from the upstream — nowhere near the cause.
  await withServer(null, async (api) => {
    const response = await api.post("/api/codex/providers", newProvider({
      providerId: "chatonly",
      credential: { mode: "keep" },
      bridge: {
        upstreamBaseUrl: "https://chatonly.example/v1",
        apiKey: "https://chatonly.example/v1",
      },
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /看起来是一个网址/);
  });
});

test("a legacy store that saved a URL as the upstream key asks for a real one", async () => {
  // Versions before 0.3.0 could persist this, and it stays invisible: the proxy
  // authenticates with an address forever. Reporting the key as absent is what
  // makes the UI ask for one, which is the only thing that fixes it.
  await withServer(null, async (api) => {
    const upstream = "https://chatonly.example/v1";
    fs.writeFileSync(api.storePath, JSON.stringify({
      version: 1,
      ownedProviderId: "custom",
      activeProviderId: "chatonly",
      providers: {
        chatonly: {
          name: "Chat-only gateway",
          baseUrl: "http://127.0.0.1:43210/v1",
          requiresAuth: false,
          models: [{ id: "deepseek-chat", reasoningEffort: "medium" }],
          defaultModelId: "deepseek-chat",
          credential: null,
          bridge: {
            upstreamBaseUrl: upstream,
            port: 43210,
            credential: { type: "api_key", key: upstream },
            models: {},
          },
        },
      },
    }));

    const { codex } = await api.state();
    const provider = codex.providers.find((item) => item.id === "chatonly");
    // The provider survives — only the unusable credential is disowned.
    assert.equal(provider.bridge.upstreamBaseUrl, upstream);
    assert.equal(provider.bridge.credentialConfigured, false);

    // And a save must not be able to launder the bad value back in by leaving
    // the key blank, which normally means "keep the stored one".
    const response = await api.post("/api/codex/providers", newProvider({
      providerId: "chatonly",
      name: "Chat-only gateway",
      credential: { mode: "keep" },
      bridge: { upstreamBaseUrl: upstream, apiKey: "" },
      models: [{ id: "deepseek-chat", reasoningEffort: "medium" }],
      defaultModelId: "deepseek-chat",
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /上游的 API Key/);
  });
});

test("names the hand-written provider tables that would stop Codex loading", async () => {
  // Verified against codex-cli 0.149.0: a [model_providers.*] table without
  // `name` makes Codex reject the entire config, not just that provider. This
  // manager preserves such tables rather than repairing them, so the least it
  // can do is say which one is at fault.
  const broken = `model_provider = "custom"
model = "gpt-5.6-sol"

[model_providers.custom]
name = "Fine"
base_url = "https://fine.example/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.nameless]
base_url = "https://nameless.example/v1"
wire_api = "responses"
`;
  await withServer(broken, async (api) => {
    const { codex } = await api.state();
    assert.deepEqual(codex.providerTablesMissingName, ["nameless"]);
    // The manager must not repair it: that table is the user's.
    assert.equal(api.config(), broken);
  });
});

test("a provider needing no credential reports that auth.json was left alone", async () => {
  await withServer(null, async (api) => {
    // Save a keyed provider first, so auth.json holds something worth not
    // clobbering.
    await api.post("/api/codex/providers", newProvider());
    assert.equal(api.auth().OPENAI_API_KEY, SECRET);

    // Then switch to one Codex will not authenticate.
    const response = await api.post("/api/codex/providers", newProvider({
      providerId: "chatonly",
      name: "Chat-only gateway",
      credential: { mode: "keep" },
      bridge: { upstreamBaseUrl: "https://chatonly.example/v1", apiKey: "sk-upstream-not-real" },
      models: [{ id: "deepseek-chat", reasoningEffort: "medium" }],
      defaultModelId: "deepseek-chat",
    }));
    assert.equal(response.status, 200);

    // auth.json keeps the previous key: the active provider sends no
    // Authorization at all, and clobbering it could destroy a ChatGPT login
    // this manager never created.
    assert.equal(api.auth().OPENAI_API_KEY, SECRET);
    assert.match(api.config(), /^requires_openai_auth = false$/m);

    // The state has to carry enough for the UI to say so rather than claim a
    // credential swap that did not happen.
    const { codex } = await api.state();
    const active = codex.providers.find((provider) => provider.isActive);
    assert.equal(active.id, "chatonly");
    assert.equal(active.requiresAuth, false);
    assert.equal(active.bridge.upstreamBaseUrl, "https://chatonly.example/v1");
  });
});

// Codex 0.151.0's ReasoningEffort gained `persistent`, and carries a
// Custom(String) variant for efforts a model defines that the client has never
// heard of. Both are values Codex accepts and this manager must not correct: it
// owns the key, but not the vocabulary.
const CUSTOM_EFFORT = `model_provider = "custom"
model = "gpt-5.6-sol"
model_reasoning_effort = "turbo"
plan_mode_reasoning_effort = "persistent"

[model_providers.custom]
name = "现成的供应商"
base_url = "https://existing.example/v1"
wire_api = "responses"
requires_openai_auth = true
`;

test("an effort Codex accepts and this manager does not know survives a save", async () => {
  await withServer(CUSTOM_EFFORT, async (api) => {
    const before = await api.state();
    // Reported as itself, not silently reduced to a value the select happens to
    // carry: the browser cannot keep what it was never shown.
    assert.equal(before.codex.settings.reasoningEffort, "turbo");
    assert.equal(before.codex.settings.planModeReasoningEffort, "persistent");
    assert.equal(before.codex.reasoningEfforts.includes("persistent"), true);
    assert.equal(before.codex.reasoningEfforts.includes("turbo"), true);

    // Echoing back what was shown is not a request to change anything.
    const kept = await api.post("/api/codex/settings", {
      reasoningEffort: "turbo",
      planModeReasoningEffort: "persistent",
      verbosity: "medium",
    });
    assert.equal(kept.status, 200);
    assert.match(api.config(), /^model_reasoning_effort = "turbo"$/m);
    assert.match(api.config(), /^plan_mode_reasoning_effort = "persistent"$/m);

    // A value neither known nor on disk leaves the file's own value alone,
    // rather than replacing an effort Codex accepts with our default.
    const nonsense = await api.post("/api/codex/settings", {
      reasoningEffort: "Not A Value",
      planModeReasoningEffort: "persistent",
      verbosity: "medium",
    });
    assert.equal(nonsense.status, 200);
    assert.match(api.config(), /^model_reasoning_effort = "turbo"$/m);

    // And a known one still wins when it is actually chosen.
    const chosen = await api.post("/api/codex/settings", {
      reasoningEffort: "persistent",
      planModeReasoningEffort: "medium",
      verbosity: "medium",
    });
    assert.equal(chosen.status, 200);
    assert.match(api.config(), /^model_reasoning_effort = "persistent"$/m);
    assert.equal(/model_reasoning_effort = "turbo"/.test(api.config()), false);
  });
});
