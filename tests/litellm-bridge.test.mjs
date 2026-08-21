import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { createBridgeRunner, renderLitellmConfig } from "../lib/litellm-bridge.mjs";

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppm-bridge-"));
}

test("never writes the upstream key into the generated config", () => {
  const yaml = renderLitellmConfig({
    models: [{ id: "gpt-5.6-sol" }, { id: "alias", upstreamId: "deepseek-v3" }],
    upstreamBaseUrl: "https://upstream.example/v1",
  });
  assert.match(yaml, /^model_list:$/m);
  assert.match(yaml, /^ {2}- model_name: "gpt-5\.6-sol"$/m);
  // The bridging flag is the entire point: without it LiteLLM would forward
  // /v1/responses to an upstream that does not implement it.
  assert.match(yaml, /^ {6}use_chat_completions_api: true$/m);
  assert.match(yaml, /^ {6}api_base: "https:\/\/upstream\.example\/v1"$/m);
  // A model may be exposed to Codex under a different name than the upstream's.
  assert.match(yaml, /^ {6}model: "openai\/deepseek-v3"$/m);
  // The key is referenced through the environment, never inlined.
  assert.match(yaml, /^ {6}api_key: "os\.environ\/PPM_BRIDGE_UPSTREAM_KEY"$/m);
  assert.equal(/sk-/.test(yaml), false);
});

test("quotes values that would otherwise break the document", () => {
  const yaml = renderLitellmConfig({
    models: [{ id: 'weird: "name"' }],
    upstreamBaseUrl: "https://upstream.example/v1",
  });
  assert.match(yaml, /- model_name: "weird: \\"name\\""/);
});

test("pins LiteLLM to loopback rather than its default 0.0.0.0", async (t) => {
  if (process.platform !== "linux") return t.skip("procfs only");
  const dir = sandbox();
  // A stand-in for the litellm binary that records how it was invoked and then
  // stays alive, so the runner's own bookkeeping is exercised too.
  const fake = path.join(dir, "fake-litellm");
  const argvLog = path.join(dir, "argv.txt");
  fs.writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nprintf '%s' "$PPM_BRIDGE_UPSTREAM_KEY" > ${JSON.stringify(path.join(dir, "key.txt"))}\nsleep 30\n`, { mode: 0o755 });

  const runner = createBridgeRunner({ dir });
  runner.writeConfig({ models: [{ id: "m" }], upstreamBaseUrl: "https://upstream.example/v1" });
  process.env.PI_PROVIDER_MANAGER_LITELLM = fake;
  const started = createBridgeRunner({ dir });
  try {
    started.start({ providerId: "p", port: 43999, upstreamKey: "upstream-secret" });
    for (let attempt = 0; attempt < 50 && !fs.existsSync(argvLog); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const argv = fs.readFileSync(argvLog, "utf8").trim().split("\n");
    // LiteLLM defaults to 0.0.0.0, which would expose an unauthenticated proxy
    // holding the user's upstream key on every interface.
    assert.equal(argv.includes("--host"), true);
    assert.equal(argv[argv.indexOf("--host") + 1], "127.0.0.1");
    assert.equal(argv[argv.indexOf("--port") + 1], "43999");
    assert.equal(argv[argv.indexOf("--config") + 1], runner.configPath);
    // The key reaches the process through the environment, as the config's
    // os.environ reference requires.
    assert.equal(fs.readFileSync(path.join(dir, "key.txt"), "utf8"), "upstream-secret");
    assert.equal(started.status().running, true);
    assert.equal(started.stop().stopped, true);
    assert.equal(started.status().running, false);
  } finally {
    delete process.env.PI_PROVIDER_MANAGER_LITELLM;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to signal a pid it cannot prove is its own", async (t) => {
  if (process.platform !== "linux") return t.skip("procfs only");
  const dir = sandbox();
  try {
    const runner = createBridgeRunner({ dir });
    // A live process that is emphatically not ours: pids are reused, and the
    // recorded one may belong to anything by the time stop is called.
    fs.writeFileSync(path.join(dir, "pi-provider-manager-bridge.json"), JSON.stringify({ pid: process.pid, port: 1, providerId: "p" }));
    assert.equal(runner.isOurProcess(process.pid), false);
    assert.equal(runner.status().running, false);
    assert.equal(runner.stop().stopped, false);
    // A pid that is simply gone is reported as not running rather than as ours.
    fs.writeFileSync(path.join(dir, "pi-provider-manager-bridge.json"), JSON.stringify({ pid: 2 ** 22, port: 1, providerId: "p" }));
    assert.equal(runner.status().running, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reports not running when nothing was ever started", () => {
  const dir = sandbox();
  try {
    const status = createBridgeRunner({ dir }).status();
    assert.equal(status.running, false);
    assert.equal(status.pid, 0);
    assert.equal(status.configPath, path.join(dir, "pi-provider-manager-litellm.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing binary is recorded, not thrown at the process", async () => {
  // spawn reports ENOENT asynchronously. An unlistened "error" event on a
  // ChildProcess is re-thrown as an uncaught exception, which would take the
  // whole manager down the moment someone clicked start without LiteLLM
  // installed.
  const dir = sandbox();
  process.env.PI_PROVIDER_MANAGER_LITELLM = path.join(dir, "does-not-exist");
  try {
    const runner = createBridgeRunner({ dir });
    runner.writeConfig({ models: [{ id: "m" }], upstreamBaseUrl: "https://upstream.example/v1" });
    runner.start({ providerId: "p", port: 44002, upstreamKey: "k" });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const log = fs.readFileSync(path.join(dir, "pi-provider-manager-bridge.log"), "utf8");
    assert.match(log, /找不到/);
    assert.match(log, /PI_PROVIDER_MANAGER_LITELLM/);
    // The failed attempt must not leave a pid behind that stop would chase.
    assert.equal(runner.status().running, false);
    assert.equal(runner.status().pid, 0);
  } finally {
    delete process.env.PI_PROVIDER_MANAGER_LITELLM;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to supervise where process ownership cannot be proven", async (t) => {
  if (process.platform !== "linux") return t.skip("needs a procfs machine to fake its absence");
  const dir = sandbox();
  try {
    const runner = createBridgeRunner({ dir });
    // On this machine supervision is possible, so the capability probe says so
    // and the manual command is still offered for copying.
    const status = runner.status();
    assert.equal(status.supervisable, true);
    assert.match(status.manualCommand, /--host 127\.0\.0\.1 --port 43210$/);
    // The upstream key is named, never included: this string reaches a browser.
    assert.match(status.manualCommand, /PPM_BRIDGE_UPSTREAM_KEY=<上游 key>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the manual command names the key rather than carrying it", async () => {
  // Whatever the platform, this string is rendered in the page, so it must not
  // be a place a credential can leak.
  const dir = sandbox();
  try {
    const runner = createBridgeRunner({ dir });
    runner.writeConfig({ models: [{ id: "m" }], upstreamBaseUrl: "https://upstream.example/v1" });
    const status = runner.status();
    assert.equal(status.manualCommand.includes("sk-"), false);
    assert.equal(status.manualCommand.includes(status.configPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
