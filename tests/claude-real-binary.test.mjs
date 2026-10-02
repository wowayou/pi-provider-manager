// Offline wire proof: the installed Claude reads exactly the user files the
// HTTP API writes. No real key, model service, or user's config is involved.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withClaudeServer } from "./helpers/claude-server.mjs";
import { resolveClaudeCommand } from "../bin/claude-with-provider.mjs";
// Resolve Claude the way the launcher does. On Windows that runs the native
// executable without cmd.exe, which would mangle the empty and JSON arguments
// below, and the probe cannot skip where the product itself would find Claude.
let installed = "", claudeCommand = null;
try { claudeCommand = resolveClaudeCommand("claude"); installed = execFileSync(claudeCommand.file, [...claudeCommand.args, "--version"], { encoding: "utf8", timeout: 20000 }).trim(); } catch {}

for (const authType of ["token", "api-key"]) test("real Claude Code reads the saved " + authType + ", model alias and global instructions", { skip: installed ? false : "Claude Code is not installed", timeout: 120000 }, async (t) => {
  t.diagnostic(installed);
  const turns = [];
  const gateway = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (route === "/v1/messages/count_tokens") { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"input_tokens":32}'); return; }
    if (route !== "/v1/messages") { response.writeHead(404); response.end(); return; }
    turns.push({ headers: request.headers, body });
    const message = { id: "msg_local", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 32, output_tokens: 4 } };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const sse = (type, data) => response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
    sse("message_start", { message });
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "PONG" } });
    sse("content_block_stop", { index: 0 });
    sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    sse("message_stop", {}); response.end();
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  try {
    await withClaudeServer(async (api) => {
      const secret = "dummy-claude-wire-" + authType;
      const save = await api.post("/api/claude/providers", { providerId: "wire", name: "Wire test", baseUrl: "http://127.0.0.1:" + gateway.address().port, authType, model: "sonnet", aliases: { sonnet: "relay-claude-sonnet" }, credential: { mode: "new", value: secret }, setActive: true });
      assert.equal(save.status, 200, await save.text());
      const state = await api.state();
      const marker = "CLAUDE_GLOBAL_PROMPT_WIRE_EVIDENCE";
      const prompt = await api.post("/api/prompts", { target: "claude", slot: "claude", name: "Wire", text: marker, setActive: true }, state.prompts.claude.revision);
      assert.equal(prompt.status, 200, await prompt.text());
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|CODEX_|PI_PROVIDER_MANAGER_)/.test(key)) delete env[key];
      const cwd = path.join(api.dir, "work"); fs.mkdirSync(cwd);
      Object.assign(env, { CLAUDE_CONFIG_DIR: api.claudeDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
      const child = spawn(claudeCommand.file, [...claudeCommand.args, "-p", "Reply PONG.", "--setting-sources", "user", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
      let code;
      try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }); } finally { clearTimeout(timer); }
      assert.equal(code, 0, output);
      assert.match(output, /PONG/);
      assert.ok(turns.length > 0);
      for (const turn of turns) {
        assert.equal(turn.headers[authType === "token" ? "authorization" : "x-api-key"], authType === "token" ? "Bearer " + secret : secret);
        assert.equal(turn.headers[authType === "token" ? "x-api-key" : "authorization"], undefined);
      }
      assert.ok(turns.some((turn) => turn.body.model === "relay-claude-sonnet"), "saved sonnet mapping reached the wire");
      assert.ok(turns.some((turn) => JSON.stringify(turn.body).includes(marker)), "Claude read CLAUDE.md from the selected config directory");
    });
  } finally { gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); }
});

// Keep two real Claude processes alive across the global switch, then send a
// second turn through each. Starting two short-lived processes separately would
// not prove that a settings watcher cannot redirect an already running one.
test("two real Claude terminals retain separate gateways across global switches", { skip: installed ? false : "Claude Code is not installed", timeout: 120000 }, async (t) => {
  t.diagnostic(installed);
  const { runClaude } = await import("../bin/claude-with-provider.mjs");
  const records = { a: [], b: [] };
  const gateways = {};
  const processes = [];
  const runs = [];
  const waitFor = async (predicate, what) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out: " + what); await new Promise((resolve) => setTimeout(resolve, 100)); }
  };
  for (const id of ["a", "b"]) {
    gateways[id] = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const route = new URL(request.url, "http://127.0.0.1").pathname;
      if (route.endsWith("/count_tokens")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"input_tokens":32}'); return; }
      if (route !== "/v1/messages") { response.writeHead(404); response.end(); return; }
      records[id].push({ headers: request.headers, body });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type, data) => response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
      event("message_start", { message: { id: "msg_" + id + records[id].length, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 32, output_tokens: 4 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "PONG " + id } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
      event("message_stop", {}); response.end();
    });
    await new Promise((resolve) => gateways[id].listen(0, "127.0.0.1", resolve));
  }
  try {
    await withClaudeServer(async (api) => {
      for (const id of ["a", "b"]) {
        const saved = await api.post("/api/claude/providers", { providerId: id, name: id, baseUrl: "http://127.0.0.1:" + gateways[id].address().port, authType: id === "a" ? "token" : "api-key", model: "sonnet", aliases: { sonnet: "relay-model-" + id }, credential: { mode: "new", value: "dummy-window-" + id }, setActive: id === "a" });
        assert.equal(saved.status, 200, await saved.text());
      }
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|CODEX_|PI_PROVIDER_MANAGER_)/.test(key)) delete env[key];
      Object.assign(env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
      const cwd = path.join(api.dir, "project"); fs.mkdirSync(cwd);
      // Give the project a conflicting gateway as well: --settings must outrank
      // that user-owned choice while leaving all permission rules untouched.
      fs.mkdirSync(path.join(cwd, ".claude"));
      fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "wrong-project-key" } }));
      const originalCwd = process.cwd(); process.chdir(cwd);
      try {
        for (const id of ["a", "b"]) {
          const entry = { id, child: null, file: "", results: 0, output: "" };
          processes.push(entry);
          const done = runClaude({ dir: api.claudeDir, providerId: id, extra: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence"] }, { env, stdio: ["pipe", "pipe", "pipe"], onSpawn: (child, file) => {
            entry.child = child; entry.file = file;
            let buffer = "";
            child.stdout.on("data", (chunk) => {
              buffer += chunk; entry.output += chunk;
              const lines = buffer.split("\n"); buffer = lines.pop();
              for (const line of lines) { try { if (JSON.parse(line).type === "result") entry.results += 1; } catch {} }
            });
            child.stderr.on("data", (chunk) => { entry.output += chunk; });
          } });
          runs.push(done);
          entry.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "FIRST_WINDOW_" + id } }) + "\n");
        }
        await waitFor(() => processes.every((entry) => entry.results >= 1), "first turns from both terminals");
        assert.equal((await api.post("/api/claude/activate", { providerId: "b" })).status, 200);
        assert.equal((await api.post("/api/claude/settings", { language: "Chinese" })).status, 200);
        // Allow the real clients' user-settings watchers to apply the changes.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        for (const entry of processes) entry.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "SECOND_WINDOW_" + entry.id } }) + "\n");
        await waitFor(() => processes.every((entry) => entry.results >= 2), "second turns after global switch");
        for (const entry of processes) entry.child.stdin.end();
        assert.deepEqual(await Promise.all(runs), [0, 0]);
        for (const entry of processes) assert.equal(fs.existsSync(entry.file), false, "session snapshot cleaned on exit");
        for (const id of ["a", "b"]) {
          const turns = records[id];
          assert.ok(turns.some((turn) => JSON.stringify(turn.body).includes("FIRST_WINDOW_" + id)));
          assert.ok(turns.some((turn) => JSON.stringify(turn.body).includes("SECOND_WINDOW_" + id)));
          for (const turn of turns) {
            assert.equal(turn.headers[id === "a" ? "authorization" : "x-api-key"], id === "a" ? "Bearer dummy-window-a" : "dummy-window-b");
            assert.equal(turn.headers[id === "a" ? "x-api-key" : "authorization"], undefined);
            assert.ok(!JSON.stringify(turn.body).includes("WINDOW_" + (id === "a" ? "b" : "a")), "another terminal's conversation never reaches this gateway");
          }
          assert.ok(turns.some((turn) => turn.body.model === "relay-model-" + id));
        }
        assert.equal((await api.state()).claude.activeProviderId, "b");
      } finally {
        process.chdir(originalCwd);
        for (const entry of processes) if (entry.child?.exitCode === null) entry.child.kill("SIGKILL");
        await Promise.allSettled(runs);
      }
    });
  } finally { for (const gateway of Object.values(gateways)) { gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); } }
});

// Shared fake gateway for the cases below: optional signed thinking, and an
// optional rejection used to reproduce a relay that refuses a replayed signature.
async function fakeGateway(name, { thinking = false, reject, rejectMessage = "messages.1.content.0: Invalid `signature` in `thinking` block" } = {}) {
  const records = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (route.endsWith("/count_tokens")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"input_tokens":32}'); return; }
    if (route !== "/v1/messages") { response.writeHead(404); response.end(); return; }
    records.push({ headers: request.headers, body });
    if (reject?.(body)) { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: rejectMessage } })); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type, data) => response.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n");
    event("message_start", { message: { id: "msg_" + name + records.length, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 32, output_tokens: 4 } } });
    let index = 0;
    if (thinking) {
      event("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      event("content_block_delta", { index, delta: { type: "thinking_delta", thinking: "thinking on " + name } });
      event("content_block_delta", { index, delta: { type: "signature_delta", signature: "SIG_FROM_" + name } });
      event("content_block_stop", { index }); index += 1;
    }
    event("content_block_start", { index, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index, delta: { type: "text_delta", text: "PONG " + name } });
    event("content_block_stop", { index });
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    event("message_stop", {}); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { name, records, url: "http://127.0.0.1:" + server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
const cleanClaudeEnv = (extra) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|CODEX_|PI_PROVIDER_MANAGER_)/.test(key)) delete env[key];
  return Object.assign(env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" }, extra);
};
const STREAM_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands"];
function streamClient(args, { cwd, env }) {
  const child = spawn(claudeCommand.file, [...claudeCommand.args, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const client = { child, results: [], output: "", sessionId: "" };
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk; client.output += chunk;
    const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) { try { const item = JSON.parse(line); if (item.session_id) client.sessionId = item.session_id; if (item.type === "result") client.results.push(item); } catch {} }
  });
  child.stderr.on("data", (chunk) => { client.output += chunk; });
  client.send = (text) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  client.wait = async (count) => {
    const deadline = Date.now() + 45000;
    while (client.results.length < count) { if (Date.now() > deadline || child.exitCode !== null) throw new Error("Claude stopped early:\n" + client.output.slice(-2000)); await new Promise((resolve) => setTimeout(resolve, 100)); }
  };
  client.end = () => new Promise((resolve) => { if (child.exitCode !== null) { resolve(child.exitCode); return; } child.stdin.end(); child.once("exit", resolve); });
  return client;
}
const tempTree = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-claude-real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = path.join(root, "cfg"), cwd = path.join(root, "work");
  fs.mkdirSync(cfg); fs.mkdirSync(cwd);
  return { root, cfg, cwd };
};

// The "跟随全局默认" launch mode is plain `claude`; this is the behaviour it
// relies on. Claude's settings watcher needs a moment, so the second turn waits.
test("follow mode: a running plain claude switches gateway, credential and alias when the manager switches the global default", { skip: installed ? false : "Claude Code is not installed", timeout: 120000 }, async (t) => {
  t.diagnostic(installed);
  const A = await fakeGateway("A"), B = await fakeGateway("B");
  try {
    await withClaudeServer(async (api) => {
      for (const gateway of [A, B]) {
        const saved = await api.post("/api/claude/providers", { providerId: gateway.name.toLowerCase(), name: gateway.name, baseUrl: gateway.url, authType: "token", model: "sonnet", aliases: { sonnet: "relay-" + gateway.name }, credential: { mode: "new", value: "dummy-follow-" + gateway.name }, setActive: gateway === A });
        assert.equal(saved.status, 200, await saved.text());
      }
      const cwd = path.join(api.dir, "follow"); fs.mkdirSync(cwd);
      const client = streamClient([...STREAM_ARGS, "--no-session-persistence"], { cwd, env: cleanClaudeEnv({ CLAUDE_CONFIG_DIR: api.claudeDir }) });
      try {
        client.send("FOLLOW_ONE"); await client.wait(1);
        assert.equal((await api.post("/api/claude/activate", { providerId: "b" })).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 4000));
        client.send("FOLLOW_TWO"); await client.wait(2);
      } finally { await client.end(); }
      assert.deepEqual(A.records.map((turn) => [turn.headers.authorization, turn.body.model]), [["Bearer dummy-follow-A", "relay-A"]]);
      assert.deepEqual(B.records.map((turn) => [turn.headers.authorization, turn.body.model]), [["Bearer dummy-follow-B", "relay-B"]]);
      assert.ok(JSON.stringify(B.records[0].body.messages).includes("FOLLOW_ONE"), "the conversation continues on the new gateway");
    });
  } finally { await A.close(); await B.close(); }
});

// Cross-gateway resume is Claude Code's behaviour, not the manager's: nothing
// here rewrites history. These cases document what 2.1.283 does, so a Claude
// upgrade that changes it fails loudly instead of silently changing the docs.
const resumeCase = async (t, { modelA, modelB, reject, rejectMessage }) => {
  const { root, cfg, cwd } = tempTree(t);
  fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ alwaysThinkingEnabled: true }));
  const A = await fakeGateway("A", { thinking: true });
  const B = await fakeGateway("B", { thinking: true, reject, rejectMessage });
  const snapshot = (gateway, model) => {
    const file = path.join(root, gateway.name + ".json");
    fs.writeFileSync(file, JSON.stringify({ model, env: { ANTHROPIC_BASE_URL: gateway.url, ANTHROPIC_AUTH_TOKEN: "dummy-resume-" + gateway.name, ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: model } }));
    return file;
  };
  const env = cleanClaudeEnv({ CLAUDE_CONFIG_DIR: cfg });
  try {
    let client = streamClient([...STREAM_ARGS, "--settings", snapshot(A, modelA)], { cwd, env });
    client.send("REMEMBER_ALPHA"); await client.wait(1); await client.end();
    assert.ok(client.sessionId);
    client = streamClient([...STREAM_ARGS, "--settings", snapshot(B, modelB), "--resume", client.sessionId], { cwd, env });
    client.send("CONTINUE_ON_B"); await client.wait(1); await client.end();
    return { result: client.results.at(-1), requests: B.records, turns: B.records.map((turn) => ({ history: JSON.stringify(turn.body.messages).includes("REMEMBER_ALPHA"), signature: JSON.stringify(turn.body.messages).includes("SIG_FROM_A") })) };
  } finally { await A.close(); await B.close(); }
};

test("cross-gateway resume with a different model drops the old signed thinking and continues", { skip: installed ? false : "Claude Code is not installed", timeout: 150000 }, async (t) => {
  const { result, turns } = await resumeCase(t, { modelA: "claude-sonnet-4-5", modelB: "claude-opus-4-1" });
  assert.equal(result.is_error, false, result.result);
  assert.deepEqual(turns, [{ history: true, signature: false }]);
});

test("cross-gateway resume with the same model retries without thinking after a standard signature error", { skip: installed ? false : "Claude Code is not installed", timeout: 150000 }, async (t) => {
  const { result, turns } = await resumeCase(t, { modelA: "claude-sonnet-4-5", modelB: "claude-sonnet-4-5", reject: (body) => JSON.stringify(body.messages).includes("SIG_FROM_A") });
  assert.equal(result.is_error, false, result.result);
  assert.deepEqual(turns, [{ history: true, signature: true }, { history: true, signature: false }]);
});

test("cross-gateway resume fails when the new relay rejects the signature with a non-standard error", { skip: installed ? false : "Claude Code is not installed", timeout: 150000 }, async (t) => {
  const { result, turns, requests } = await resumeCase(t, { modelA: "claude-sonnet-4-5", modelB: "claude-sonnet-4-5", reject: (body) => JSON.stringify(body.messages).includes("SIG_FROM_A"), rejectMessage: "Bad request" });
  assert.equal(result.is_error, true);
  assert.match(String(result.result), /400/);
  // The signature is never dropped here. Since 2.1.287 the first request asks
  // for thinking.display "updates"; refused, Claude repeats it once without
  // that field and nothing else changed. Up to 2.1.286 there is one request.
  assert.ok(turns.length === 1 || turns.length === 2, JSON.stringify(turns));
  assert.ok(turns.every((turn) => turn.history && turn.signature), JSON.stringify(turns));
  if (requests.length === 2) {
    assert.equal(requests[0].body.thinking?.display, "updates");
    const withoutDisplay = (body) => JSON.parse(JSON.stringify({ ...body, thinking: { ...body.thinking, display: undefined } }));
    assert.deepEqual(requests[1].body, withoutDisplay(requests[0].body));
  }
});

// A real interactive session in a pseudo-terminal, driven through the copied
// command's launcher: typing, a single Ctrl+C, /exit and closing the terminal.
const python = (() => { try { execFileSync("python3", ["-c", "import pty"], { stdio: "ignore" }); return "python3"; } catch { return ""; } })();
const PTY_DRIVER = String.raw`
import os, pty, sys, time, select
launcher, cfg, cwd, mode = sys.argv[1:5]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(sys.argv[5], [sys.argv[5], launcher, "--config-dir", cfg, "--provider", "a"])
def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try: os.read(fd, 65536)
            except OSError: return
def alive():
    try: return os.waitpid(pid, os.WNOHANG) == (0, 0)
    except ChildProcessError: return False
# Exit is polled up to a deadline rather than checked after a fixed sleep: on a
# loaded machine Claude can take longer than five seconds to shut down, and a
# fixed sleep then reports a clean exit as a hung session.
def exited_within(seconds, reading=True):
    end = time.time() + seconds
    while time.time() < end:
        if not alive(): return True
        if reading: drain(0.2)
        else: time.sleep(0.2)
    return not alive()
drain(8)
os.write(fd, b"INTERACTIVE_HELLO"); drain(1); os.write(fd, b"\r"); drain(8)
if mode == "ctrlc":
    os.write(fd, b"\x03"); drain(3)
    print("alive-after-ctrlc", alive())
    os.write(fd, b"/exit"); drain(1); os.write(fd, b"\r"); exited_within(20)
elif mode == "exit":
    os.write(fd, b"/exit"); drain(1); os.write(fd, b"\r"); exited_within(20)
elif mode == "hangup":
    os.close(fd); exited_within(20, reading=False)
print("alive-at-end", alive())
`;
for (const mode of ["exit", "ctrlc", "hangup"]) test("interactive terminal via the launcher: " + mode + " keeps the gateway and removes the snapshot", { skip: !installed ? "Claude Code is not installed" : process.platform === "win32" || !python ? "needs a POSIX pty (python3)" : false, timeout: 90000 }, async (t) => {
  t.diagnostic(installed);
  const { root, cfg, cwd } = tempTree(t);
  // Skip first-run onboarding and the folder trust prompt, which would
  // otherwise sit between the terminal and the first request.
  fs.writeFileSync(path.join(cfg, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  const A = await fakeGateway("A");
  try {
    const { createClaudeConfig } = await import("../lib/claude-config.mjs");
    const { default: crypto } = await import("node:crypto");
    const config = createClaudeConfig({ dir: cfg, revisionKey: crypto.randomBytes(32) });
    config.saveProvider({ revision: config.publicState().revision, providerId: "a", name: "A", baseUrl: A.url, authType: "token", model: "sonnet", aliases: { sonnet: "relay-interactive" }, credential: { mode: "new", value: "dummy-interactive" }, setActive: false });
    const driver = path.join(root, "drive.py"); fs.writeFileSync(driver, PTY_DRIVER);
    const launcher = fileURLToPath(new URL("../bin/claude-with-provider.mjs", import.meta.url));
    const run = spawn(python, [driver, launcher, cfg, cwd, mode, process.execPath], { env: cleanClaudeEnv({}), stdio: ["ignore", "pipe", "pipe"] });
    let report = ""; run.stdout.on("data", (chunk) => { report += chunk; }); run.stderr.on("data", (chunk) => { report += chunk; });
    assert.equal(await new Promise((resolve) => run.once("exit", resolve)), 0, report);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (mode === "ctrlc") assert.match(report, /alive-after-ctrlc True/, "one Ctrl+C interrupts, it does not quit");
    assert.match(report, /alive-at-end False/, report);
    assert.ok(A.records.some((turn) => JSON.stringify(turn.body.messages).includes("INTERACTIVE_HELLO")), "the typed prompt reached the pinned gateway");
    for (const turn of A.records) { assert.equal(turn.headers.authorization, "Bearer dummy-interactive"); assert.equal(turn.body.model, "relay-interactive"); }
    const runs = path.join(cfg, "pi-provider-manager-runs");
    assert.deepEqual(fs.existsSync(runs) ? fs.readdirSync(runs) : [], [], "snapshot removed");
  } finally { await A.close(); }
});
