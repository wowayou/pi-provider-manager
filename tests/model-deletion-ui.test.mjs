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
    "single-router": { type: "api_key", key: "dummy-single-model-key" },
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
      "single-router": {
        baseUrl: "https://single.example/v1",
        api: "openai-completions",
        models: [model("only/model")],
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

test("production UI protects persisted model deletion paths", { timeout: 60_000 }, async () => {
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
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, 30_000);

    const target = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}`)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3 && document.querySelector('.live-default-badge')`);

    const initial = await cdp.evaluate(`({
      rows: ${rowMeasurements},
      readOnlyCount: document.querySelectorAll('.model-name-cell input[readonly]').length,
      liveId: document.querySelector('.live-default-badge').closest('.model-row').querySelector('.model-name-cell input').value,
      frame: (() => {
        const shell = document.querySelector('.app-shell').getBoundingClientRect();
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
        const workspace = document.querySelector('.workspace').getBoundingClientRect();
        const content = document.querySelector('.step-content').getBoundingClientRect();
        const footer = document.querySelector('.wizard-footer').getBoundingClientRect();
        const table = document.querySelector('.models-table').getBoundingClientRect();
        const remove = document.querySelector('.model-row .icon-button').getBoundingClientRect();
        return {
          pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          pageOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          bodyOverflowY: document.body.scrollHeight - document.body.clientHeight,
          shellTop: shell.top,
          shellBottom: shell.bottom,
          shellHeight: shell.height,
          sidebarHeight: sidebar.height,
          workspaceHeight: workspace.height,
          contentOverflow: getComputedStyle(document.querySelector('.step-scroll')).overflowY,
          providerOverflow: getComputedStyle(document.querySelector('.provider-list')).overflowY,
          footerVisible: footer.top >= content.top && footer.bottom <= content.bottom + 1,
          removeVisible: remove.left >= table.left && remove.right <= table.right + 1,
          removeRight: remove.right,
        };
      })(),
    })`);
    assert.equal(initial.readOnlyCount, 3);
    assert.equal(initial.liveId, "anthropic/claude-opus");
    assert.deepEqual(initial.rows.map((row) => row.height), [85, 85, 85]);
    for (const row of initial.rows) assert.equal(new Set(row.tops).size, 1);
    assert.deepEqual({
      pageOverflowX: initial.frame.pageOverflowX,
      pageOverflowY: initial.frame.pageOverflowY,
      bodyOverflowY: initial.frame.bodyOverflowY,
      shellTop: initial.frame.shellTop,
      shellBottom: initial.frame.shellBottom,
      shellHeight: initial.frame.shellHeight,
      sidebarHeight: initial.frame.sidebarHeight,
      workspaceHeight: initial.frame.workspaceHeight,
      contentOverflow: initial.frame.contentOverflow,
      providerOverflow: initial.frame.providerOverflow,
      footerVisible: initial.frame.footerVisible,
      removeVisible: initial.frame.removeVisible,
    }, {
      pageOverflowX: 0,
      pageOverflowY: 0,
      bodyOverflowY: 0,
      shellTop: 0,
      shellBottom: 720,
      shellHeight: 720,
      sidebarHeight: 720,
      workspaceHeight: 720,
      contentOverflow: "auto",
      providerOverflow: "auto",
      footerVisible: true,
      removeVisible: true,
    });

    const deleteButton = await cdp.evaluate(`(() => {
      const button = document.querySelector('.delete-provider-button');
      const rect = button.getBoundingClientRect();
      return { text: button.textContent.trim(), visible: rect.width > 0 && rect.height > 0 };
    })()`);
    assert.deepEqual(deleteButton, { text: "删除供应商", visible: true });
    await cdp.evaluate(`document.querySelector('.delete-provider-button').click()`);
    await cdp.waitFor(`document.querySelector('.provider-delete-dialog') && document.activeElement === document.querySelector('.provider-delete-dialog .secondary-button')`);
    const defaultDeleteDialog = await cdp.evaluate(`({
      title: document.querySelector('#provider-delete-title').textContent,
      description: document.querySelector('#provider-delete-description').textContent,
      hasReplacementPanel: Boolean(document.querySelector('.replacement-panel')),
      replacementProvider: document.querySelector('.replacement-fields select:first-of-type')?.value,
      replacementModel: document.querySelector('.replacement-fields label:last-child select')?.value,
      keepCredential: document.querySelector('.keep-credential-option input').checked,
      cancelFocused: document.activeElement === document.querySelector('.provider-delete-dialog .secondary-button'),
    })`);
    assert.match(defaultDeleteDialog.title, /Review Router/);
    assert.match(defaultDeleteDialog.description, /review-router.*3 个模型/);
    assert.equal(defaultDeleteDialog.hasReplacementPanel, true);
    assert.equal(defaultDeleteDialog.replacementProvider, "single-router");
    assert.equal(defaultDeleteDialog.replacementModel, "only/model");
    assert.equal(defaultDeleteDialog.keepCredential, false);
    assert.equal(defaultDeleteDialog.cancelFocused, true);
    assert.deepEqual(await cdp.evaluate(`(() => {
      const first = document.querySelector('.replacement-fields select');
      const last = document.querySelector('.provider-delete-dialog .danger-button');
      last.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const forwardWrapped = document.activeElement === first;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
      return { forwardWrapped, backwardWrapped: document.activeElement === last };
    })()`), { forwardWrapped: true, backwardWrapped: true });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await cdp.waitFor(`!document.querySelector('.provider-delete-dialog')`);

    const actionableRemove = await cdp.evaluate(`(async () => {
      document.querySelector('.models-table').scrollIntoView({ block: 'start' });
      await new Promise(requestAnimationFrame);
      const content = document.querySelector('.step-content').getBoundingClientRect();
      const table = document.querySelector('.models-table').getBoundingClientRect();
      const remove = document.querySelector('.model-row .icon-button').getBoundingClientRect();
      const topmost = document.elementFromPoint(remove.left + remove.width / 2, remove.top + remove.height / 2);
      return {
        withinContent: remove.top >= content.top && remove.bottom <= content.bottom,
        withinTable: remove.left >= table.left && remove.right <= table.right + 1,
        topmost: Boolean(topmost?.closest('.icon-button')),
        topmostTag: topmost?.tagName || "",
        topmostClass: topmost?.className?.baseVal || topmost?.className || "",
        removeRect: { top: remove.top, right: remove.right, bottom: remove.bottom, left: remove.left },
        tableRect: { top: table.top, right: table.right, bottom: table.bottom, left: table.left },
        contentRect: { top: content.top, right: content.right, bottom: content.bottom, left: content.left },
      };
    })()`);
    assert.equal(actionableRemove.withinContent, true);
    assert.equal(actionableRemove.withinTable, true);
    assert.equal(actionableRemove.topmost, true, JSON.stringify(actionableRemove));

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1181,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const stickyRemove = await cdp.evaluate(`(async () => {
      const table = document.querySelector('.models-table');
      await new Promise(requestAnimationFrame);
      const before = document.querySelector('.model-row .icon-button').getBoundingClientRect();
      table.scrollLeft = table.scrollWidth;
      await new Promise(requestAnimationFrame);
      const after = document.querySelector('.model-row .icon-button').getBoundingClientRect();
      const bounds = table.getBoundingClientRect();
      return {
        horizontalOverflow: table.scrollWidth - table.clientWidth,
        beforeRight: before.right,
        afterRight: after.right,
        visibleBefore: before.left >= bounds.left && before.right <= bounds.right + 1,
        visibleAfter: after.left >= bounds.left && after.right <= bounds.right + 1,
      };
    })()`);
    assert.ok(stickyRemove.horizontalOverflow > 0);
    assert.ok(Math.abs(stickyRemove.afterRight - stickyRemove.beforeRight) <= 1);
    assert.equal(stickyRemove.visibleBefore, true);
    assert.equal(stickyRemove.visibleAfter, true);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.evaluate(`(async () => {
      document.querySelector('.models-table').scrollLeft = 0;
      document.querySelector('.step-scroll').scrollTop = 0;
      await new Promise(requestAnimationFrame);
    })()`);

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

    await cdp.evaluate(`document.querySelector('.settings-button').click()`);
    await cdp.waitFor(`document.querySelector('.settings-page') && document.querySelector('.settings-footer')`);
    const settingsFrame = await cdp.evaluate(`(() => {
      const page = document.querySelector('.settings-page').getBoundingClientRect();
      const footer = document.querySelector('.settings-footer').getBoundingClientRect();
      return {
        pageOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        scrollOverflow: getComputedStyle(document.querySelector('.settings-scroll')).overflowY,
        footerVisible: footer.top >= page.top && footer.bottom <= page.bottom + 1,
      };
    })()`);
    assert.deepEqual(settingsFrame, { pageOverflowY: 0, scrollOverflow: "auto", footerVisible: true });
    await cdp.evaluate(`document.querySelector('.settings-title .secondary-button').click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 4`);

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 900,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.evaluate(`localStorage.setItem('ppm-theme', 'dark')`);
    await cdp.send("Page.reload");
    await cdp.waitFor(`document.documentElement.dataset.theme === 'dark' && document.querySelectorAll('.model-row').length === 3`);
    await cdp.evaluate(`(async () => {
      const scroll = document.querySelector('.step-scroll');
      const table = document.querySelector('.models-table');
      const viewport = scroll.getBoundingClientRect();
      const before = table.getBoundingClientRect();
      const target = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, before.top - viewport.top - 12));
      scroll.scrollTop = target;
      await new Promise(requestAnimationFrame);
    })()`);
    await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
    await cdp.waitFor(`document.querySelector('.toast')`);
    const mobile = await cdp.evaluate(`(() => {
      const toast = document.querySelector('.toast').getBoundingClientRect();
      const shell = document.querySelector('.app-shell').getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const workspace = document.querySelector('.workspace').getBoundingClientRect();
      const content = document.querySelector('.step-content').getBoundingClientRect();
      const footer = document.querySelector('.wizard-footer').getBoundingClientRect();
      const table = document.querySelector('.models-table').getBoundingClientRect();
      const remove = document.querySelector('.model-row .icon-button').getBoundingClientRect();
      const topmost = document.elementFromPoint(remove.left + remove.width / 2, remove.top + remove.height / 2);
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        verticalOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        shellHeight: shell.height,
        frameFits: sidebar.top >= shell.top && workspace.bottom <= shell.bottom + 1,
        providerRailVisible: document.querySelector('.provider-list').getBoundingClientRect().height >= 48,
        footerVisible: footer.top >= content.top && footer.bottom <= content.bottom + 1,
        removeVisible: remove.left >= table.left && remove.right <= table.right + 1,
        removeTopmost: topmost?.closest('.icon-button') === document.querySelector('.model-row .icon-button'),
        toastLeft: toast.left,
        toastRight: toast.right,
        rowHeights: [...document.querySelectorAll('.model-row')].map((row) => row.getBoundingClientRect().height),
      };
    })()`);
    assert.equal(mobile.overflow, 0);
    assert.equal(mobile.verticalOverflow, 0);
    assert.equal(mobile.shellHeight, 900);
    assert.equal(mobile.frameFits, true);
    assert.equal(mobile.providerRailVisible, true);
    assert.equal(mobile.footerVisible, true);
    assert.equal(mobile.removeVisible, true);
    assert.equal(mobile.removeTopmost, true);
    assert.ok(mobile.toastLeft >= 0 && mobile.toastRight <= 420);
    assert.deepEqual(mobile.rowHeights, [85, 85, 85]);

    await cdp.evaluate(`document.querySelectorAll('.provider-item')[1].click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 1 && document.querySelector('.model-name-cell input').value === 'only/model'`);
    const onlyRemove = await cdp.evaluate(`({
      disabled: document.querySelector('.model-row .icon-button').disabled,
      ariaDisabled: document.querySelector('.model-row .icon-button').getAttribute('aria-disabled'),
    })`);
    assert.deepEqual(onlyRemove, { disabled: false, ariaDisabled: "true" });
    await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
    await cdp.waitFor(`document.querySelector('.toast-action') && document.querySelector('.toast').textContent.includes('唯一模型')`);
    assert.match(await cdp.evaluate(`document.querySelector('.toast').textContent`), /不能单独删除.*删除供应商/);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelector('.provider-delete-dialog') && document.activeElement === document.querySelector('.provider-delete-dialog .secondary-button')`);
    const mobileDialog = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.provider-delete-dialog').getBoundingClientRect();
      return {
        title: document.querySelector('#provider-delete-title').textContent,
        description: document.querySelector('#provider-delete-description').textContent,
        hasReplacementPanel: Boolean(document.querySelector('.replacement-panel')),
        cancelFocused: document.activeElement === document.querySelector('.provider-delete-dialog .secondary-button'),
        keepCredential: document.querySelector('.keep-credential-option input').checked,
        fits: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight,
      };
    })()`);
    assert.match(mobileDialog.title, /Single Router/);
    assert.match(mobileDialog.description, /single-router.*1 个模型/);
    assert.equal(mobileDialog.hasReplacementPanel, false);
    assert.equal(mobileDialog.cancelFocused, true);
    assert.equal(mobileDialog.keepCredential, false);
    assert.equal(mobileDialog.fits, true);
    await cdp.evaluate(`document.querySelector('.keep-credential-option input').click()`);
    await cdp.evaluate(`document.querySelector('.provider-delete-dialog .danger-button').click()`);
    await cdp.waitFor(`!document.querySelector('.provider-delete-dialog') && document.querySelectorAll('.provider-item').length === 1 && document.querySelector('.toast')`);
    assert.match(await cdp.evaluate(`document.querySelector('.toast').textContent`), /single-router.*凭据已保留/);
    const afterProviderDelete = await fetch(`http://127.0.0.1:${appPort}/api/state`).then((response) => response.json());
    assert.equal(afterProviderDelete.providers.some((provider) => provider.id === "single-router"), false);
    assert.equal(afterProviderDelete.authProviders.includes("single-router"), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["single-router"], undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["single-router"].key, "dummy-single-model-key");

    const externallyEditedSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    externallyEditedSettings.externalEditorField = "keep-external-change";
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify(externallyEditedSettings, null, 2)}\n`);
    await cdp.evaluate(`document.querySelector('.settings-button').click()`);
    await cdp.waitFor(`document.querySelector('.settings-page') && !document.querySelector('.settings-footer .primary-button').disabled`);
    await cdp.evaluate(`document.querySelector('.settings-footer .primary-button').click()`);
    await cdp.waitFor(`document.querySelector('.toast.is-error .toast-action') && document.querySelector('.error-banner').textContent.includes('其他程序或标签页')`);
    assert.equal(await cdp.evaluate(`document.querySelector('.toast-action').textContent`), "重新读取");
    const afterConflict = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(afterConflict.externalEditorField, "keep-external-change");
    assert.equal(Object.hasOwn(afterConflict, "transport"), false);
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

const CODEX_FIXTURE = `# 我自己写的注释，别动
model_provider = "custom"
model = "gpt-5.6-sol"

[model_providers.custom]
name = "现成的供应商"
base_url = "https://existing.example/v1"
wire_api = "responses"
requires_openai_auth = true

[model_providers.myown]
# 手写的表，本管理器不该碰
base_url = "https://hand-written.example/v1"
wire_api = "responses"

[tui]
notifications = true
`;

test("production UI drives the Codex workspace", { timeout: 90_000 }, async () => {
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-codex-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-codex-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-codex-"));
  const configPath = path.join(codexDir, "config.toml");
  fs.writeFileSync(configPath, CODEX_FIXTURE);
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
        PI_PROVIDER_MANAGER_CODEX_DIR: codexDir,
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
    ], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    chrome.stdout.on("data", (chunk) => { chromeOutput += chunk; });
    chrome.stderr.on("data", (chunk) => { chromeOutput += chunk; });
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, 30_000);

    const target = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}`)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor(`document.querySelector('.target-switch')`);

    // The Pi sidebar keeps the look it had before Codex existed: the badge cell
    // is present so both targets share one grid, but it carries no text.
    await cdp.waitFor(`document.querySelectorAll('.provider-item').length === 2`);
    assert.equal(
      await cdp.evaluate(`[...document.querySelectorAll('.provider-badge')].filter((node) => node.textContent.trim()).length`),
      0,
    );

    const clickText = (selector, text) =>
      cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => node.textContent.includes(${JSON.stringify(text)})).click()`);

    await clickText(".target-switch button", "Codex");
    await cdp.waitFor(`document.querySelector('.model-row.is-codex .model-name-cell input')`);

    // The table already on disk is adopted, shown as live, and said to be adopted.
    const adopted = await cdp.evaluate(`({
      name: document.querySelector('.provider-item .provider-copy strong').textContent,
      badge: document.querySelector('.provider-badge')?.textContent || "",
      note: document.querySelector('.adopted-note')?.textContent || "",
      model: document.querySelector('.model-row.is-codex .model-name-cell input').value,
    })`);
    assert.equal(adopted.name, "现成的供应商");
    assert.equal(adopted.badge, "生效中");
    assert.match(adopted.note, /已从现有 config\.toml 接管/);
    assert.equal(adopted.model, "gpt-5.6-sol");
    // Rendering the adopted entry must not have written anything.
    assert.equal(fs.readFileSync(configPath, "utf8"), CODEX_FIXTURE);

    // Add a second provider through the wizard.
    await cdp.evaluate(`document.querySelector('.add-provider').click()`);
    await cdp.waitFor(`document.querySelector('.protocol-grid.is-duo')`);
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor(`document.querySelector('.form-grid input')`);
    await cdp.evaluate(`(() => {
      const set = (element, value) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const inputs = [...document.querySelectorAll('.form-grid input')];
      set(inputs[0], 'packy');
      set(inputs[1], 'PackyCode');
      set(inputs[2], 'https://packy.example/v1');
      set(document.querySelector('.key-field input'), 'browser-test-codex-key');
    })()`);
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor(`document.querySelectorAll('.model-row.is-codex').length === 1`);

    // A second model row, so the armed delete has something to remove.
    await clickText(".models-actions button", "添加模型");
    await cdp.waitFor(`document.querySelectorAll('.model-row.is-codex').length === 2`);
    await cdp.evaluate(`(() => {
      const input = document.querySelectorAll('.model-row.is-codex .model-name-cell input')[1];
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'gpt-5.1-codex');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    // First click arms and explains; it must not remove the row.
    await cdp.evaluate(`document.querySelectorAll('.model-row.is-codex .icon-button')[1].click()`);
    await cdp.waitFor(`document.querySelector('.toast.is-error')`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.model-row.is-codex').length`), 2);
    assert.match(await cdp.evaluate(`document.querySelector('.toast').textContent`), /再次点击会移除/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await cdp.evaluate(`document.querySelectorAll('.model-row.is-codex .icon-button')[1].click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row.is-codex').length === 1`);
    // Every removal offers an undo.
    await cdp.waitFor(`document.querySelector('.toast-action')`);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row.is-codex').length === 2`);

    await clickText(".wizard-footer .primary-button", "保存并设为当前生效");
    await cdp.waitFor(`document.querySelector('.success-page')`, 20_000);
    assert.match(await cdp.evaluate(`document.querySelector('.success-page').textContent`), /开一个新的 codex 会话/);
    assert.equal(await cdp.evaluate(`document.querySelector('.command-row code').textContent`), "codex");

    const written = fs.readFileSync(configPath, "utf8");
    assert.match(written, /^# 我自己写的注释，别动$/m);
    assert.match(written, /^\[model_providers\.myown\]$/m);
    assert.match(written, /^# 手写的表，本管理器不该碰$/m);
    assert.match(written, /^\[tui\]$/m);
    assert.match(written, /^name = "PackyCode"$/m);
    assert.equal(/^\[profiles\./m.test(written), false, "profile tables are legacy in current Codex");
    assert.equal((written.match(/\[model_providers\./g) || []).length, 2);
    // The key belongs in auth.json and the manager's own store, never in the page.
    assert.equal(written.includes("browser-test-codex-key"), false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")).OPENAI_API_KEY,
      "browser-test-codex-key",
    );
    assert.equal(
      await cdp.evaluate(`(async () => (await (await fetch('/api/state', { cache: 'no-store' })).text()).includes('browser-test-codex-key'))()`),
      false,
    );

    // An external edit between read and write must be refused, not overwritten.
    fs.writeFileSync(configPath, `${written}\n# 另一个程序刚刚写的\n`);
    const staleConfig = fs.readFileSync(configPath, "utf8");
    await clickText(".success-actions button", "返回供应商详情");
    await cdp.waitFor(`document.querySelector('.model-row.is-codex')`);
    await clickText(".wizard-footer .primary-button", "保存更改");
    await cdp.waitFor(`document.querySelector('.toast.is-error .toast-action')`);
    assert.match(await cdp.evaluate(`document.querySelector('.error-banner').textContent`), /其他程序或标签页/);
    assert.equal(fs.readFileSync(configPath, "utf8"), staleConfig);

    assert.equal(cdp.errors.length, 0, JSON.stringify(cdp.errors));
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
    fs.rmSync(codexDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
