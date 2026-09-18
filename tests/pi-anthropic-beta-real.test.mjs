// Runs the installed `pi` against configuration this manager wrote, with a
// stand-in Anthropic gateway on loopback recording every request.
//
// The unit tests prove what lands in models.json; only this file answers
// whether Pi then sends the header the user configured — and only that header,
// since Pi replaces its automatic beta list when a model carries its own.
// Offline and keyless by design, and skipped when Pi is not installed: a skip
// here means "unverified", never "passed".

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORED_KEY = "manager-stored-key-not-real";

function piVersion() {
  try {
    return execFileSync("pi", ["--version"], { encoding: "utf8", timeout: 20_000, shell: process.platform === "win32" }).trim();
  } catch {
    return "";
  }
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

async function waitFor(check, timeout, what) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`${what} did not become ready.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Every write goes through the manager's real HTTP boundary, so the file Pi
// reads is the file the product writes, not a hand-made approximation.
async function saveThroughServer(agentDir, payload) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of ["PI_PROVIDER_MANAGER_PORT", "PI_PROVIDER_MANAGER_API_PORT", "PI_CODING_AGENT_DIR", "PI_PROVIDER_MANAGER_CODEX_DIR", "CODEX_HOME"]) delete env[key];
  const child = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
    cwd: projectRoot,
    env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: path.join(agentDir, "codex"), PI_PROVIDER_MANAGER_API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const state = await waitFor(async () => (await fetch(`${baseUrl}/api/state`, { cache: "no-store" })).json(), 30_000, "the manager");
    const response = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, revision: state.revision }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    child.kill();
  }
}

// The flags are the only thing the two tests differ in. The first asks what the
// manager wrote, with everything Pi could contribute switched off. The second
// asks what Pi does when it has a beta list of its own to replace, and that
// needs thinking on: measured on 0.85.1, `--thinking off` leaves a model with no
// automatic list at all — tools on or off makes no difference — so a run in that
// configuration cannot tell "replaced" from "there was nothing to replace".
function runPi(agentDir, model, flags = ["--no-tools", "--thinking", "off"]) {
  // Everything discoverable is switched off so the run depends on the three
  // files the manager wrote and nothing in the developer's own Pi setup.
  const run = spawnSync("pi", [
    "--print", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    ...flags,
    "--model", model, "hi",
  ], {
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 120_000,
    cwd: os.tmpdir(),
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  return { status: run.status, output: `${run.stdout || ""}\n${run.stderr || ""}` };
}

function recordedTurns(recordPath) {
  return fs.readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((turn) => new URL(turn.url, "http://127.0.0.1").pathname === "/v1/messages");
}

const model = (id, extra = {}) => ({ id, name: id, contextWindow: 200000, maxTokens: 16000, supportsImages: false, reasoning: true, maximumThinking: "high", ...extra });
// Headers are compared as tokens, not as strings: Pi splits the saved value and
// re-joins it without spaces (measured on 0.85.1), which is the same header to
// the gateway and must not be asserted as a different one.
const tokens = (header) => String(header || "").split(",").map((token) => token.trim()).filter(Boolean);
const installed = piVersion();

test("pi sends exactly the model's anthropic-beta override, and its siblings keep Pi's own list", { skip: installed ? false : "pi is not installed", timeout: 300_000 }, async (t) => {
  t.diagnostic(`pi ${installed}`);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-pi-beta-"));
  const recordPath = path.join(agentDir, "requests.jsonl");
  const gatewayPort = await freePort();
  const gateway = spawn(process.execPath, [path.join(projectRoot, "tests", "fixtures", "fake-anthropic-gateway.mjs"), String(gatewayPort), recordPath], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: "{}" })).ok, 10_000, "the stand-in gateway");
    fs.writeFileSync(recordPath, "");

    const providerId = "beta-router";
    const baseUrl = `http://127.0.0.1:${gatewayPort}`;
    await saveThroughServer(agentDir, {
      providerId,
      baseUrl,
      api: "anthropic-messages",
      credential: { mode: "new", apiKey: STORED_KEY },
      models: [
        model("claude-one", { anthropicBeta: "context-1m-2025-08-07, context-1m-2025-08-07, prompt-caching-2024-07-31" }),
        model("claude-two"),
        model("claude-big[1M]", { contextWindow: 1000000, maxTokens: 128000 }),
      ],
      setDefault: true,
      defaultModelId: "claude-one",
      defaultThinkingLevel: "high",
    });
    const written = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers[providerId];
    assert.equal(written.models[0].headers["anthropic-beta"], "context-1m-2025-08-07, prompt-caching-2024-07-31", "saved deduplicated and canonical");
    assert.equal(written.models[1].headers, undefined);

    for (const id of ["claude-one", "claude-two", "claude-big[1M]"]) {
      const run = runPi(agentDir, `${providerId}/${id}`);
      assert.equal(run.status, 0, `pi failed for ${id}:\n${run.output}`);
      assert.match(run.output, /PONG/, `pi did not complete a turn for ${id}:\n${run.output}`);
    }
    const turns = recordedTurns(recordPath);
    const byModel = (id) => turns.filter((turn) => turn.body.model === id);
    assert.equal(byModel("claude-one").length > 0, true, "no request reached the gateway for claude-one");
    assert.equal(byModel("claude-two").length > 0, true, "no request reached the gateway for claude-two");
    assert.equal(byModel("claude-big[1M]").length > 0, true, "the [1M] id was not sent as-is");

    const one = byModel("claude-one")[0];
    // The claim under test: the override replaces Pi's list rather than being
    // appended to it, and every token arrives.
    assert.deepEqual(tokens(one.headers["anthropic-beta"]), ["context-1m-2025-08-07", "prompt-caching-2024-07-31"]);
    assert.equal(one.headers["x-api-key"], STORED_KEY, "Pi did not send the credential the manager stored");
    assert.equal(one.headers.authorization, undefined);

    const two = byModel("claude-two")[0];
    const automatic = two.headers["anthropic-beta"] || "";
    t.diagnostic(`pi ${installed} automatic anthropic-beta for a sibling model: ${automatic || "(none)"}`);
    assert.equal(automatic.includes("context-1m-2025-08-07"), false, "the sibling inherited the override");
    assert.equal(one.headers["anthropic-beta"] === automatic, false, "the override made no difference on the wire");

    // Clearing the override restores whatever Pi sends on its own.
    await saveThroughServer(agentDir, {
      providerId,
      baseUrl,
      api: "anthropic-messages",
      credential: { mode: "keep" },
      models: [model("claude-one", { anthropicBeta: "" }), model("claude-two"), model("claude-big[1M]", { contextWindow: 1000000, maxTokens: 128000 })],
      setDefault: false,
      defaultModelId: "claude-one",
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers[providerId].models[0].headers, undefined);
    fs.writeFileSync(recordPath, "");
    const cleared = runPi(agentDir, `${providerId}/claude-one`);
    assert.equal(cleared.status, 0, cleared.output);
    const afterClear = recordedTurns(recordPath).find((turn) => turn.body.model === "claude-one");
    assert.equal(afterClear.headers["anthropic-beta"] || "", automatic, "clearing the override did not restore Pi's own list");
  } finally {
    gateway.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

// The test above cannot speak to replacement: it runs with thinking off, and on
// 0.85.1 that leaves a model with no automatic beta list at all, so its sibling
// sending nothing is the absence of a list rather than a list that survived.
// "Pi replaces its own list with the model's" was therefore code reading — the
// user-facing copy promises it, and the whole reason `anthropic-beta` is exposed
// as a literal rather than inferred is that a wrong guess silently drops the
// betas Pi would otherwise have sent.
//
// This is the measurement. Thinking is on, which is what gives Pi an automatic
// list to lose; tools are left on as well, though they make no difference to it.
// The proof is a pair on one model: it sends exactly the override while the
// override is set, and exactly Pi's own list once it is cleared.
test("with tools and thinking on, an override replaces Pi's beta list rather than joining it", { skip: installed ? false : "pi is not installed", timeout: 300_000 }, async (t) => {
  t.diagnostic(`pi ${installed}`);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-pi-beta-thinking-"));
  const recordPath = path.join(agentDir, "requests.jsonl");
  const gatewayPort = await freePort();
  const gateway = spawn(process.execPath, [path.join(projectRoot, "tests", "fixtures", "fake-anthropic-gateway.mjs"), String(gatewayPort), recordPath], { stdio: ["ignore", "ignore", "ignore"] });
  const providerId = "thinking-router";
  const OVERRIDE = "context-1m-2025-08-07, prompt-caching-2024-07-31";
  // Tools stay on: no --no-tools. Thinking has to be asked for.
  const flags = ["--thinking", "high"];
  const models = (override) => [model("claude-override", { anthropicBeta: override }), model("claude-sibling")];
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, { method: "POST", body: "{}" })).ok, 10_000, "the stand-in gateway");
    const save = (override, credential) => saveThroughServer(agentDir, {
      providerId,
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      api: "anthropic-messages",
      credential,
      models: models(override),
      setDefault: true,
      defaultModelId: "claude-sibling",
      defaultThinkingLevel: "high",
    });

    // One model, one run, the tokens it actually sent.
    const betaTokensFor = (id) => {
      fs.writeFileSync(recordPath, "");
      const run = runPi(agentDir, `${providerId}/${id}`, flags);
      assert.equal(run.status, 0, `pi failed for ${id}:\n${run.output}`);
      const [turn] = recordedTurns(recordPath).filter((entry) => entry.body.model === id);
      assert.ok(turn, `no request reached the gateway for ${id}`);
      return tokens(turn.headers["anthropic-beta"]);
    };

    await save(OVERRIDE, { mode: "new", apiKey: STORED_KEY });
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers[providerId].models[0].headers["anthropic-beta"], OVERRIDE, "the save did not write the override this test is about");

    // The sibling is what makes this run worth anything: it proves Pi has a list
    // of its own here, so the override has something to replace. Without it, an
    // override-only header would prove nothing at all.
    const automatic = betaTokensFor("claude-sibling");
    t.diagnostic(`pi ${installed} automatic anthropic-beta with thinking on: ${automatic.join(",") || "(none)"}`);
    assert.ok(
      automatic.length > 0,
      "thinking gave Pi no automatic beta list, so this run cannot show that an override replaces one",
    );

    const overridden = betaTokensFor("claude-override");
    assert.deepEqual(overridden, ["context-1m-2025-08-07", "prompt-caching-2024-07-31"], "the override did not reach the wire intact");
    for (const token of automatic) {
      assert.equal(
        overridden.includes(token),
        false,
        `Pi sent its own ${token} alongside the override instead of replacing its list with it`,
      );
    }

    // The other half of the pair. Cleared, the same model gets its automatic list
    // back — so the header above was replaced, not simply never built.
    await save("", { mode: "keep" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers[providerId].models[0].headers, undefined, "clearing the override left a header behind");
    assert.deepEqual(
      betaTokensFor("claude-override"),
      automatic,
      "clearing the override did not hand the model back Pi's own list",
    );
  } finally {
    gateway.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
