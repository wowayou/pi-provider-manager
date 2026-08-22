// Runs the real `codex` binary against configuration this manager generated.
//
// Everything else about Codex is checked against its documented schema, which
// cannot tell us whether Codex actually accepts what we write. `codex doctor`
// loads the full config and reports whether it parsed, so it is the one check
// that answers that question. Skipped when Codex is not installed, so the suite
// still runs on a machine without it.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findLitellm } from "../lib/litellm-bridge.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function codexVersion() {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
  } catch {
    return "";
  }
}

// `codex doctor --json` reports whether the full config parsed. It exits
// non-zero whenever any check fails — including checks we do not care about,
// such as free disk space — so the exit code is ignored and the machine
// readable result is used instead.
function doctorConfigStatus(codexHome) {
  let stdout;
  try {
    stdout = execFileSync("codex", ["doctor", "--json"], {
      encoding: "utf8",
      timeout: 120_000,
      // Somewhere without a .codex/ of its own, so a project-local config
      // cannot colour the result.
      cwd: os.tmpdir(),
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stdout = error.stdout;
  }
  const report = JSON.parse(stdout);
  return report.checks["config.load"].status;
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

async function saveThroughServer(codexDir, payload, options = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-pi-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of ["PI_PROVIDER_MANAGER_PORT", "PI_PROVIDER_MANAGER_API_PORT", "PI_CODING_AGENT_DIR", "PI_PROVIDER_MANAGER_CODEX_DIR", "CODEX_HOME"]) delete env[key];
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: codexDir, PI_PROVIDER_MANAGER_API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const deadline = Date.now() + 30_000;
    let state;
    for (;;) {
      try {
        state = await (await fetch(`${baseUrl}/api/state`, { cache: "no-store" })).json();
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Test server did not start.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const response = await fetch(`${baseUrl}/api/codex/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, revision: state.codex.revision }),
    });
    assert.equal(response.status, 200, await response.text());
    if (options.start) {
      const started = await fetch(`${baseUrl}/api/codex/bridge/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: options.start }),
      });
      assert.equal(started.status, 200, await started.text());
    }
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

const installed = codexVersion();

// LiteLLM is only needed by the bridge test. It is heavy and version-sensitive,
// so its absence skips rather than fails.
//
// Resolved through the product's own discovery, not a second copy of the rules:
// probing a different binary than the one the manager would start makes the
// test skip on exactly the machines where out-of-the-box behaviour matters.
const litellmBinary = process.env.PI_PROVIDER_MANAGER_LITELLM || findLitellm();
function litellmAvailable() {
  try {
    return execFileSync(litellmBinary, ["--version"], { encoding: "utf8", timeout: 60_000 }).includes("LiteLLM");
  } catch {
    return false;
  }
}

test("the real Codex binary loads what this manager writes", { skip: installed ? false : "codex is not installed" }, async () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-codex-real-"));
  // A file shaped like one a Codex user actually accumulates: a comment, keys
  // this manager does not know, per-project trust tables keyed by quoted paths
  // with dots and CJK, and a hand-written provider table it must not touch.
  const before = `# hand-written note
model_provider = "custom"
model = "gpt-5.6-sol"
disable_response_storage = true
plan_mode_reasoning_effort = "xhigh"

[model_providers.custom]
name = "existing gateway"
base_url = "https://existing.example/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.myown]
name = "Hand written"
base_url = "https://hand-written.example/v1"
wire_api = "responses"

[tui.model_availability_nux]
"gpt-5.6-sol" = 4

[projects."/mnt/d/000.MyData/我的简历_23/专项优化/威泰液压"]
trust_level = "trusted"
`;
  fs.writeFileSync(path.join(codexDir, "config.toml"), before);
  try {
    assert.equal(doctorConfigStatus(codexDir), "ok", "the fixture itself must be valid");

    await saveThroughServer(codexDir, {
      providerId: "packy",
      name: "PackyCode",
      baseUrl: "https://api.packycode.com/v1",
      requiresAuth: true,
      credential: { mode: "new", apiKey: "sk-not-a-real-key" },
      models: [
        { id: "gpt-5.6-sol", reasoningEffort: "xhigh" },
        { id: "gpt-5.1-codex", reasoningEffort: "medium" },
      ],
      defaultModelId: "gpt-5.6-sol",
      setActive: true,
    });

    // The question this file exists to answer: does Codex accept it?
    assert.equal(doctorConfigStatus(codexDir), "ok", "Codex rejected the generated config");

    const after = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    assert.match(after, /^name = "PackyCode"$/m);
    assert.match(after, /^# hand-written note$/m);
    assert.match(after, /^\[model_providers\.myown\]$/m);
    assert.match(after, /^\[projects\."\/mnt\/d\/000\.MyData\/我的简历_23\/专项优化\/威泰液压"\]$/m);
    assert.equal(/^\[profiles\./m.test(after), false, "profile tables are legacy in current Codex");
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

// The check that was missing when profile generation shipped: `codex doctor`
// said the config was fine, because it is — a legacy `[profiles.*]` table
// still parses. It is the `--profile` selector that rejects it, so only
// running the advertised command finds this. If Codex ever reverses the
// decision, this test says so.
test("Codex rejects --profile against a legacy table in config.toml", { skip: installed ? false : "codex is not installed" }, () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-codex-legacy-"));
  try {
    fs.writeFileSync(path.join(codexDir, "config.toml"), [
      'model_provider = "custom"',
      'model = "a-model"',
      "",
      "[model_providers.custom]",
      'name = "T"',
      // Deliberately unreachable: this must fail at config load, before any
      // request, so the test never depends on the network.
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
      "[profiles.custom]",
      'model = "a-model"',
      'model_provider = "custom"',
      "",
    ].join("\n"));
    const run = spawnSync("codex", ["exec", "--profile", "custom", "--skip-git-repo-check", "hi"], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: os.tmpdir(),
      env: { ...process.env, CODEX_HOME: codexDir },
    });
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;
    assert.notEqual(run.status, 0, `--profile unexpectedly succeeded:\n${output}`);
    assert.match(output, /legacy/, output);
    assert.match(output, /\[profiles\.custom\]/, output);
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test("a provider table without a name stops Codex loading the whole config", { skip: installed ? false : "codex is not installed" }, () => {
  // The reason the manager warns about hand-written tables missing `name`:
  // one of them takes down every provider, not just itself.
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-codex-nameless-"));
  try {
    const base = `model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nNAME_LINE\nbase_url = "https://existing.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`;
    fs.writeFileSync(path.join(codexDir, "config.toml"), base.replace("NAME_LINE\n", ""));
    assert.equal(doctorConfigStatus(codexDir), "fail");
    fs.writeFileSync(path.join(codexDir, "config.toml"), base.replace("NAME_LINE", 'name = "Named"'));
    assert.equal(doctorConfigStatus(codexDir), "ok");
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test("codex exec reaches a manager-configured gateway with the stored key", { skip: installed ? false : "codex is not installed" }, async () => {
  // The strongest claim this project makes: configure a provider here, and
  // Codex will actually talk to it, carrying the credential that was saved.
  // A stand-in gateway on loopback keeps it offline and keyless; it records the
  // Authorization header, which is what proves the auth path resolved.
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-codex-exec-"));
  const requestLog = path.join(codexDir, "requests.jsonl");
  const gatewayPort = await freePort();
  const savedKey = "manager-stored-key-not-real";
  const gateway = spawn(process.execPath, [
    path.join(projectRoot, "tests", "fixtures", "fake-responses-gateway.mjs"),
    String(gatewayPort),
    requestLog,
  ], { stdio: ["ignore", "ignore", "ignore"] });

  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, { method: "POST", body: "{}" });
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("stand-in gateway did not start");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    await saveThroughServer(codexDir, {
      providerId: "localgw",
      name: "Local test gateway",
      baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
      requiresAuth: true,
      credential: { mode: "new", apiKey: savedKey },
      models: [{ id: "fake-responses-model", reasoningEffort: "medium" }],
      defaultModelId: "fake-responses-model",
      setActive: true,
    });

    // Codex prints its resolved provider, model and effort on stderr and the
    // model's answer on stdout, so both are needed.
    const run = spawnSync("codex", ["exec", "--skip-git-repo-check", "say hi"], {
      encoding: "utf8",
      timeout: 180_000,
      cwd: os.tmpdir(),
      env: { ...process.env, CODEX_HOME: codexDir },
    });
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;
    assert.equal(run.status, 0, output);

    // Codex used the provider, model and effort the manager wrote.
    assert.match(output, /provider: custom/);
    assert.match(output, /model: fake-responses-model/);
    assert.match(output, /reasoning effort: medium/);
    // And it completed a turn against that gateway.
    assert.match(output, /PONG from the fake Responses gateway\./);

    const turns = fs.readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const authorized = turns.find((turn) => turn.authorization);
    assert.equal(authorized.authorization, `Bearer ${savedKey}`, "Codex did not send the credential the manager stored");
    assert.equal(authorized.url.startsWith("/v1/responses"), true);
  } finally {
    gateway.kill();
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test("codex reaches a chat-completions-only upstream through the managed bridge", {
  skip: !installed ? "codex is not installed" : !litellmAvailable() ? "litellm is not installed" : false,
}, async () => {
  // The claim under test: a gateway Codex cannot talk to at all becomes usable
  // because the manager configured and started a translator in front of it. The
  // stand-in upstream answers 404 on /v1/responses, so if Codex ever reached it
  // directly this would fail rather than quietly appear to work.
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-codex-bridge-"));
  const upstreamPort = await freePort();
  // The bridge's own port is asked for explicitly rather than left at the
  // default: a fixed port makes this test collide with a real bridge, with a
  // parallel run, or with a leftover from a run that was killed mid-flight.
  const bridgePort = await freePort();
  const upstreamKey = "upstream-key-not-real";
  const upstreamLog = path.join(codexDir, "upstream.log");
  const logStream = fs.openSync(upstreamLog, "a");
  const upstream = spawn(process.execPath, [
    path.join(projectRoot, "tests", "fixtures", "fake-chat-gateway.mjs"),
    String(upstreamPort),
    upstreamKey,
  ], { stdio: ["ignore", "ignore", logStream] });

  try {
    const ready = Date.now() + 10_000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${upstreamPort}/v1/models`);
        break;
      } catch {
        if (Date.now() > ready) throw new Error("stand-in upstream did not start");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const direct = await fetch(`http://127.0.0.1:${upstreamPort}/v1/responses`, { method: "POST", body: "{}" });
    assert.equal(direct.status, 404, "the fixture must be an upstream Codex cannot use directly");

    await saveThroughServer(codexDir, {
      providerId: "chatonly",
      name: "Chat-only gateway",
      credential: { mode: "keep" },
      bridge: { upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: upstreamKey, port: bridgePort },
      models: [{ id: "fake-chat-model", reasoningEffort: "medium" }],
      defaultModelId: "fake-chat-model",
      setActive: true,
    }, { start: "chatonly" });

    // LiteLLM takes a while to come up the first time.
    const bridgeDeadline = Date.now() + 180_000;
    for (;;) {
      try {
        const health = await fetch(`http://127.0.0.1:${bridgePort}/health/readiness`);
        if (health.ok) break;
      } catch {}
      if (Date.now() > bridgeDeadline) throw new Error("the managed bridge never became ready");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const run = spawnSync("codex", ["exec", "--skip-git-repo-check", "say hi"], {
      encoding: "utf8",
      timeout: 180_000,
      cwd: os.tmpdir(),
      env: { ...process.env, CODEX_HOME: codexDir },
    });
    const output = `${run.stdout || ""}\n${run.stderr || ""}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /PONG from the fake upstream/);

    // The upstream only ever saw Chat Completions, always authenticated with
    // the key the manager stored — which lives in neither config file.
    const seen = fs.readFileSync(upstreamLog, "utf8");
    assert.match(seen, /POST \/v1\/chat\/completions auth=yes/);
    const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    const yaml = fs.readFileSync(path.join(codexDir, "pi-provider-manager-litellm.yaml"), "utf8");
    assert.equal(config.includes(upstreamKey), false);
    assert.equal(yaml.includes(upstreamKey), false);
    assert.equal(config.includes(`base_url = "http://127.0.0.1:${bridgePort}/v1"`), true);
  } finally {
    upstream.kill();
    fs.closeSync(logStream);
    try {
      execFileSync("pkill", ["-f", path.join(codexDir, "pi-provider-manager-litellm.yaml")]);
    } catch {}
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});
