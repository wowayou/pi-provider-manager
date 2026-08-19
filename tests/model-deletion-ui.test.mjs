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

function findChrome() {
  const playwrightRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(os.homedir(), ".cache", "ms-playwright");
  const playwrightCandidates = fs.existsSync(playwrightRoot)
    ? fs.readdirSync(playwrightRoot).flatMap((directory) => [
        path.join(playwrightRoot, directory, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        path.join(playwrightRoot, directory, "chrome-linux", "chrome"),
      ])
    : [];
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...playwrightCandidates,
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error("Chrome was not found. Set CHROME_BIN to a Chrome or Chromium executable.");
  }
  return executable;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForUrl(url, timeout = 10_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child, processGroup = false) {
  if (!child) return;
  const signal = (name) => {
    try {
      if (processGroup && process.platform !== "win32") process.kill(-child.pid, name);
      else if (child.exitCode === null) child.kill(name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (child.exitCode === null) signal("SIGKILL");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") this.errors.push(message);
      if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
        this.errors.push(message);
      }
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async waitFor(expression, timeout = 10_000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeout) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        // A reload destroys the old execution context before the new document is
        // ready. Treat that brief CDP error like any other not-ready state.
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${expression}${lastError ? `: ${lastError.message}` : ""}`);
  }

  close() {
    for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed."));
    this.pending.clear();
    this.socket.close();
  }
}

function writeFixture(agentDir) {
  const model = (id) => ({
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 16000,
  });
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    "review-router": { type: "api_key", key: "dummy-browser-test-key" },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "review-router": {
        baseUrl: "https://router.example/v1",
        api: "openai-completions",
        models: [
          model("anthropic/claude-opus"),
          model("openai/gpt-router"),
          model("google/gemini-router"),
        ],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "review-router",
    defaultModel: "anthropic/claude-opus",
    defaultThinkingLevel: "high",
  }));
}

const rowMeasurements = `(() => [...document.querySelectorAll('.model-row')].map((row) => {
  const controls = [...row.querySelectorAll('.model-name-cell input, label:nth-of-type(2) input, label:nth-of-type(3) input, select')];
  return {
    height: row.getBoundingClientRect().height,
    tops: controls.map((control) => control.getBoundingClientRect().top),
  };
}))()`;

test("production UI protects persisted model deletion paths", { timeout: 30_000 }, async () => {
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-delete-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-"));
  writeFixture(agentDir);
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server;
  let chrome;
  let cdp;
  let serverOutput = "";
  let chromeOutput = "";

  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_PROVIDER_MANAGER_SERVE_UI: "1",
        PI_PROVIDER_MANAGER_PORT: String(appPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; });
    server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl(`http://127.0.0.1:${appPort}/api/state`);

    chrome = spawn(chromePath, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    chrome.stdout.on("data", (chunk) => { chromeOutput += chunk; });
    chrome.stderr.on("data", (chunk) => { chromeOutput += chunk; });
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`);

    const target = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}`)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1487,
      height: 1058,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3 && document.querySelector('.live-default-badge')`);

    const initial = await cdp.evaluate(`({
      rows: ${rowMeasurements},
      readOnlyCount: document.querySelectorAll('.model-name-cell input[readonly]').length,
      liveId: document.querySelector('.live-default-badge').closest('.model-row').querySelector('.model-name-cell input').value,
    })`);
    assert.equal(initial.readOnlyCount, 3);
    assert.equal(initial.liveId, "anthropic/claude-opus");
    assert.deepEqual(initial.rows.map((row) => row.height), [85, 85, 85]);
    for (const row of initial.rows) assert.equal(new Set(row.tops).size, 1);

    await cdp.evaluate(`document.querySelector('.model-name-cell input').focus()`);
    await cdp.send("Input.insertText", { text: "replacement/should-not-apply" });
    assert.equal(
      await cdp.evaluate(`document.querySelector('.model-name-cell input').value`),
      "anthropic/claude-opus",
    );

    await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
    await cdp.waitFor(`document.querySelector('.model-row .icon-button').classList.contains('is-confirming') && document.querySelector('.toast code')`);
    const liveArmed = await cdp.evaluate(`({
      rows: ${rowMeasurements},
      toast: document.querySelector('.toast').textContent,
      codeFont: getComputedStyle(document.querySelector('.toast code')).fontFamily,
    })`);
    assert.deepEqual(liveArmed.rows, initial.rows);
    assert.match(liveArmed.toast, /anthropic\/claude-opus/);
    assert.match(liveArmed.toast, /openai\/gpt-router/);
    assert.match(liveArmed.toast, /兼容信息/);
    assert.match(liveArmed.codeFont, /monospace/);

    await new Promise((resolve) => setTimeout(resolve, 450));
    await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 2 && document.querySelector('.toast-action')`);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3`);
    assert.deepEqual(await cdp.evaluate(`({
      first: document.querySelector('.model-row .model-name-cell input').value,
      selected: document.querySelector('input[type=radio]:checked').closest('.model-row').querySelector('.model-name-cell input').value,
    })`), {
      first: "anthropic/claude-opus",
      selected: "anthropic/claude-opus",
    });

    await cdp.evaluate(`document.querySelectorAll('.model-row')[1].querySelector('.icon-button').click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row')[1].querySelector('.icon-button').classList.contains('is-confirming')`);
    assert.match(await cdp.evaluate(`document.querySelector('.toast').textContent`), /openai\/gpt-router.*兼容信息/);

    await cdp.evaluate(`document.querySelector('.models-actions .outline-button').click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 4`);
    assert.equal(await cdp.evaluate(`document.querySelector('.model-row:last-child .model-name-cell input').readOnly`), false);

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 900,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.evaluate(`localStorage.setItem('ppm-theme', 'dark')`);
    await cdp.send("Page.reload");
    await cdp.waitFor(`document.documentElement.dataset.theme === 'dark' && document.querySelectorAll('.model-row').length === 3`);
    await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
    await cdp.waitFor(`document.querySelector('.toast')`);
    const mobile = await cdp.evaluate(`(() => {
      const toast = document.querySelector('.toast').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        toastLeft: toast.left,
        toastRight: toast.right,
        rowHeights: [...document.querySelectorAll('.model-row')].map((row) => row.getBoundingClientRect().height),
      };
    })()`);
    assert.equal(mobile.overflow, 0);
    assert.ok(mobile.toastLeft >= 0 && mobile.toastRight <= 420);
    assert.deepEqual(mobile.rowHeights, [85, 85, 85]);
    assert.equal(cdp.errors.length, 0);
  } catch (error) {
    error.message += `\nServer output:\n${serverOutput}\nChrome output:\n${chromeOutput}`;
    throw error;
  } finally {
    if (cdp) {
      await Promise.race([
        cdp.send("Browser.close").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      cdp.close();
    }
    await stopProcess(chrome, true);
    await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
