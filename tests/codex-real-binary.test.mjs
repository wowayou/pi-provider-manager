// Runs the real `codex` binary against configuration this manager generated.
//
// Everything else about Codex is checked against its documented schema, which
// cannot tell us whether Codex actually accepts what we write. `codex doctor`
// loads the full config and reports whether it parsed, so it is the one check
// that answers that question. Skipped when Codex is not installed, so the suite
// still runs on a machine without it.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

async function saveThroughServer(codexDir, payload) {
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
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

const installed = codexVersion();

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
    assert.match(after, /^\[profiles\.custom-gpt-5-1-codex\]$/m);
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
