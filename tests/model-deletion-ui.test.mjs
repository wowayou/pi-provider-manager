import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requireFreshBuiltUi } from "./helpers/built-ui.mjs";

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
    // exceptionDetails.text is just "Uncaught" for a thrown Error. The message and
    // stack live on the exception object, so a bare text throw hides the failure.
    if (result.exceptionDetails) {
      const { text, exception, lineNumber, columnNumber } = result.exceptionDetails;
      const detail = exception?.description || exception?.value || text;
      throw new Error(`${detail} (evaluating at ${lineNumber}:${columnNumber})\n${expression}`);
    }
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
  requireFreshBuiltUi();
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

    // The radio that picks the default model had no focus indicator at all:
    // the app's one focus ring is declared with :where() (zero specificity) and
    // was overridden by `input:focus-visible { outline: none }`, which text
    // fields survive because they draw a box-shadow ring instead — a ring that
    // `input[type=radio]:focus { box-shadow: none }` then removed. Keyboard-only
    // users had no way to see which row they were on. Measured, not asserted
    // from CSS: only the rendered outline proves it.
    await cdp.evaluate(`document.querySelector('.model-row .model-name-cell input').focus()`);
    const radioFocus = await (async () => {
      for (let press = 0; press < 40; press += 1) {
        for (const type of ["rawKeyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", {
            type,
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
            nativeVirtualKeyCode: 9,
          });
        }
        const found = await cdp.evaluate(`(() => {
          const active = document.activeElement;
          if (!active || active.type !== "radio") return null;
          const style = getComputedStyle(active);
          return {
            focusVisible: active.matches(":focus-visible"),
            outlineStyle: style.outlineStyle,
            outlineWidth: parseFloat(style.outlineWidth) || 0,
            boxShadow: style.boxShadow,
          };
        })()`);
        if (found) return found;
      }
      return null;
    })();
    assert.ok(radioFocus, "tabbing reaches the default-model radio");
    assert.equal(radioFocus.focusVisible, true);
    // Either cue is acceptable; having neither is not.
    assert.equal(
      radioFocus.outlineStyle !== "none" && radioFocus.outlineWidth > 0
        || (radioFocus.boxShadow && radioFocus.boxShadow !== "none"),
      true,
      `keyboard focus on the radio must be visible, got outline ${radioFocus.outlineStyle} ${radioFocus.outlineWidth}px and box-shadow ${radioFocus.boxShadow}`,
    );
    // A mouse click must not paint that ring, which is why the rule this
    // replaced existed at all. It takes real CDP mouse events: element.focus()
    // and a scripted .click() both still match :focus-visible, so a JS-only
    // check here would pass no matter what the stylesheet said. The radio
    // clicked is the one already selected, so the default model does not move.
    // Blur first: clicking an element that is *already* keyboard-focused fires
    // no new focus event, so the ring from the Tab above would simply persist
    // and the click would prove nothing.
    const radioBox = await cdp.evaluate(`(() => {
      document.activeElement?.blur();
      const radio = document.querySelector('.model-row input[type=radio]:checked');
      const box = radio.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: radioBox.x,
        y: radioBox.y,
        button: "left",
        clickCount: 1,
      });
    }
    const radioAfterClick = await cdp.evaluate(`(() => {
      const radio = document.querySelector('.model-row input[type=radio]:checked');
      return {
        focused: document.activeElement === radio,
        focusVisible: radio.matches(":focus-visible"),
        outlineStyle: getComputedStyle(radio).outlineStyle,
      };
    })()`);
    assert.equal(radioAfterClick.focused, true, "the click landed on the radio");
    assert.equal(radioAfterClick.focusVisible, false);
    assert.equal(radioAfterClick.outlineStyle, "none");

    await cdp.evaluate(`document.querySelector('.nav-settings').click()`);
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
    await cdp.evaluate(`document.querySelector('.nav-settings').click()`);
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
  requireFreshBuiltUi();
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

// A bridge whose stored upstream key is really a URL reads as "no credential", so
// the server asks for a real one — proven in tests/codex-server.test.mjs. The form
// then told the opposite story: its placeholder keyed off the bridge merely
// existing, so it promised "留空表示沿用已保存的 key" over an empty box with nothing
// to reuse, and following it lands on the save error instead of a fixed provider.
// The field the browser is already given is the one that answers this.
test("the form does not offer to reuse a bridge key that cannot be used", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-legacy-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-legacy-codex-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-legacy-"));
  writeFixture(agentDir);
  // No `[model_providers.*]` table, so nothing is adopted and the two providers
  // under test are exactly the two in the store.
  fs.writeFileSync(path.join(codexDir, "config.toml"), "[tui]\nnotifications = true\n");
  const upstream = "https://chatonly.example/v1";
  const bridgeProvider = (port, key) => ({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requiresAuth: false,
    models: [{ id: "deepseek-chat", reasoningEffort: "medium" }],
    defaultModelId: "deepseek-chat",
    credential: null,
    bridge: { upstreamBaseUrl: upstream, port, credential: { type: "api_key", key }, models: {} },
  });
  fs.writeFileSync(path.join(codexDir, "pi-provider-manager-store.json"), JSON.stringify({
    version: 1,
    ownedProviderId: "custom",
    activeProviderId: "legacy-bridge",
    providers: {
      // The bad data 0.2.x could write: the upstream address in the key slot.
      "legacy-bridge": { name: "旧数据的桥", ...bridgeProvider(43210, upstream) },
      // The same shape with a usable key, so the opposite copy is checked too and
      // the assertion cannot pass by never showing the reuse offer at all.
      "healthy-bridge": { name: "正常的桥", ...bridgeProvider(43211, "sk-upstream-not-real") },
    },
  }));
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
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor(`document.querySelector('.target-switch')`);

    const clickText = (selector, text) =>
      cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => node.textContent.includes(${JSON.stringify(text)})).click()`);

    await clickText(".target-switch button", "Codex");
    await cdp.waitFor(`document.querySelectorAll('.provider-item').length === 2`);

    // Opening a provider that has models lands on the model step; the credentials
    // step is reached back through the stepper, the way a person would.
    const openCredentials = async (name) => {
      await clickText(".provider-item", name);
      await cdp.waitFor(`document.querySelector('.models-step')`);
      await clickText(".step", "填写凭据");
      await cdp.waitFor(`document.querySelector('.credential-box .key-field input')`);
      return cdp.evaluate(`({
        placeholder: document.querySelector('.credential-box .key-field input').placeholder,
        notes: [...document.querySelectorAll('.credential-box .credential-status strong')]
          .map((node) => node.textContent.trim()),
      })`);
    };

    const legacy = await openCredentials("旧数据的桥");
    assert.equal(legacy.placeholder, "输入后不会回显");
    assert.ok(
      legacy.notes.some((note) => note.includes("还没有可用的上游 key")),
      `expected the unusable-key note, saw ${JSON.stringify(legacy.notes)}`,
    );

    const healthy = await openCredentials("正常的桥");
    assert.equal(healthy.placeholder, "留空表示沿用已保存的 key");
    assert.equal(
      healthy.notes.some((note) => note.includes("还没有可用的上游 key")),
      false,
      `a usable key must not be reported as missing, saw ${JSON.stringify(healthy.notes)}`,
    );

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

test("production UI drives the prompt library for both agents", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-prompts-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-prompts-codex-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-prompts-"));
  writeFixture(agentDir);
  // A hand-written file that predates the manager, which must be adopted rather
  // than presented as absent and then overwritten.
  const handWritten = "# 我手写的规则\n始终使用中文回复。\n";
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), handWritten);
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server;
  let chrome;
  let cdp;
  let serverOutput = "";

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

    const clickText = (selector, text) =>
      cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => node.textContent.includes(${JSON.stringify(text)})).click()`);
    // "some item has the badge" is already true before an activation lands, so
    // waiting on that races the request. Wait for the badge to be on the item
    // that is supposed to receive it.
    const liveBadgeOn = (name) => cdp.waitFor(`[...document.querySelectorAll('.prompt-item')]
      .find((node) => node.textContent.includes(${JSON.stringify(name)}))?.querySelector('.live-default-badge')`);

    await cdp.evaluate(`document.querySelector('.nav-prompts').click()`);
    // The textarea exists one paint before the effect fills it, so waiting on
    // the element alone snapshots an empty draft on a slow runner.
    await cdp.waitFor(`document.querySelector('.prompt-editor textarea')?.value.includes('我手写的规则')`);

    // Pi declares three files; the hand-written one is adopted and shown live.
    const opened = await cdp.evaluate(`({
      slots: [...document.querySelectorAll('.prompt-slot code')].map((node) => node.textContent),
      items: [...document.querySelectorAll('.prompt-item-name')].map((node) => node.textContent),
      badges: [...document.querySelectorAll('.prompt-item .provider-badge')].map((node) => node.textContent),
      live: document.querySelector('.prompt-item .live-default-badge')?.textContent || "",
      text: document.querySelector('.prompt-editor textarea').value,
    })`);
    assert.deepEqual(opened.slots, ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]);
    assert.deepEqual(opened.items, ["现有内容"]);
    assert.deepEqual(opened.badges, ["已接管"]);
    assert.equal(opened.live, "生效中");
    assert.equal(opened.text, handWritten);
    // Rendering an adopted file must not have written anything.
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), handWritten);

    // The file path is the most important thing in that note, and it was once
    // painted with --info-code — a background tint, not a text colour — which
    // rendered it invisible. Assert it is not the colour of its own ground.
    const notePath = await cdp.evaluate(`(() => {
      const node = document.querySelector('.prompt-note code');
      const style = getComputedStyle(node);
      return { color: style.color, background: style.backgroundColor, text: node.textContent };
    })()`);
    assert.notEqual(notePath.color, notePath.background, `the path is invisible: ${JSON.stringify(notePath)}`);
    assert.match(notePath.text, /AGENTS\.md/);

    // Destructive actions stay quiet until armed everywhere in this app.
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.prompt-actions .prompt-delete'))`), true);
    assert.equal(await cdp.evaluate(`document.querySelector('.prompt-actions .prompt-delete').classList.contains('is-armed')`), false);

    // A list with more rows than fit fades at that edge, rather than clipping
    // mid-row with nothing to say there is more.
    assert.equal(await cdp.evaluate(`document.querySelector('.provider-list').classList.contains('has-more-below')`), false, "nothing to scroll yet");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 380, deviceScaleFactor: 1, mobile: false });
    await cdp.waitFor(`document.querySelector('.provider-list').classList.contains('has-more-below')`);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.waitFor(`!document.querySelector('.provider-list').classList.contains('has-more-below')`);

    // The beginner tip costs list space forever unless it can be dismissed.
    await cdp.waitFor(`document.querySelector('.beginner-tip')`);
    await cdp.evaluate(`document.querySelector('.tip-dismiss').click()`);
    await cdp.waitFor(`!document.querySelector('.beginner-tip')`);
    assert.equal(await cdp.evaluate(`localStorage.getItem('ppm.tip-dismissed')`), "1");

    // Add a second document and make it live.
    await clickText(".prompt-list .add-provider", "新建提示词");
    await cdp.evaluate(`(() => {
      const set = (element, value, proto) => {
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('.prompt-editor input'), 'English 优先', window.HTMLInputElement.prototype);
      set(document.querySelector('.prompt-editor textarea'), 'Answer in English.\\n', window.HTMLTextAreaElement.prototype);
    })()`);
    await clickText(".prompt-actions .primary-button", "保存并写入文件");
    await cdp.waitFor(`[...document.querySelectorAll('.prompt-item-name')].length === 2`);
    await liveBadgeOn("English 优先");
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), "Answer in English.\n");

    // Switching back restores the adopted text, which proves it was kept.
    await clickText(".prompt-item", "现有内容");
    await cdp.waitFor(`document.querySelector('.prompt-editor textarea').value.includes('我手写的规则')`);
    await clickText(".prompt-actions .secondary-button", "启用这一份");
    await liveBadgeOn("现有内容");
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), handWritten);

    // A different file in the same agent is independent.
    await clickText(".prompt-slot", "SYSTEM.md");
    await cdp.waitFor(`document.querySelector('.prompt-editor textarea').value === ''`);
    await cdp.evaluate(`(() => {
      const set = (element, value, proto) => {
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('.prompt-editor input'), '精简', window.HTMLInputElement.prototype);
      set(document.querySelector('.prompt-editor textarea'), 'Be terse.\\n', window.HTMLTextAreaElement.prototype);
    })()`);
    await clickText(".prompt-actions .primary-button", "保存并写入文件");
    await liveBadgeOn("精简");
    assert.equal(fs.readFileSync(path.join(agentDir, "SYSTEM.md"), "utf8"), "Be terse.\n");
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), handWritten, "the other file is untouched");

    // The same screen serves Codex, which declares only one file.
    await clickText(".target-switch button", "Codex");
    await cdp.evaluate(`document.querySelector('.nav-prompts').click()`);
    await cdp.waitFor(`document.querySelector('.prompt-editor textarea')`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.prompt-slot').length`), 0, "one file needs no tabs");
    await cdp.evaluate(`(() => {
      const set = (element, value, proto) => {
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('.prompt-editor input'), 'Codex 的', window.HTMLInputElement.prototype);
      set(document.querySelector('.prompt-editor textarea'), 'Codex only.\\n', window.HTMLTextAreaElement.prototype);
    })()`);
    await clickText(".prompt-actions .primary-button", "保存并写入文件");
    await liveBadgeOn("Codex 的");
    assert.equal(fs.readFileSync(path.join(codexDir, "AGENTS.md"), "utf8"), "Codex only.\n");
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), handWritten, "Pi's file is not Codex's");

    assert.equal(serverOutput.includes("Error"), false, serverOutput);
  } finally {
    // The same teardown the other two browser tests use. A hand-rolled kill
    // that does not await the exit leaves Chrome writing its profile directory
    // while rmSync walks it, which fails with ENOTEMPTY.
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

// Text contrast, measured in the browser rather than reasoned about from the
// stylesheet. design-qa.md recorded "Colors and visual tokens: passed" for two
// releases while seventeen pieces of light-theme text sat below WCAG AA — the
// two primary action buttons among them at 3.05:1. Nothing had ever measured
// it. Composited colour is the only thing that settles this: a token looks fine
// in isolation and fails on the surface it lands on, and a ring declared inside
// :where() loses to any later rule.
const CONTRAST_AUDIT = `(() => {
  // Alpha matters: .toast-action paints rgba(255,255,255,.13) over a dark toast.
  // Reading that as solid white made a legible button look like 1:1 contrast.
  const parse = (value) => {
    const parts = String(value).match(/[\\d.]+/g);
    if (!parts || parts.length < 3) return null;
    const [r, g, b, a] = parts.map(Number);
    const alpha = a === undefined ? 1 : a;
    return alpha === 0 ? null : [r, g, b, alpha];
  };
  const over = ([r, g, b, a], [br, bg, bb]) => [
    r * a + br * (1 - a),
    g * a + bg * (1 - a),
    b * a + bb * (1 - a),
  ];
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const ratio = (fg, bg) => {
    const a = luminance(fg);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  // The nearest ancestor that actually paints. A transparent background means
  // the text sits on whatever is behind it, which is what the eye judges.
  // Semi-transparent layers stack, so they are collected and then composited
  // over the first opaque surface underneath — what the eye actually sees.
  const backdrop = (node) => {
    const layers = [];
    let source = null;
    for (let current = node; current; current = current.parentElement) {
      const painted = parse(getComputedStyle(current).backgroundColor);
      if (!painted) continue;
      if (!source) source = current;
      if (painted[3] >= 1) {
        let colour = [painted[0], painted[1], painted[2]];
        for (const layer of layers.reverse()) colour = over(layer, colour);
        return { colour, from: source };
      }
      layers.push(painted);
    }
    let colour = [255, 255, 255];
    for (const layer of layers.reverse()) colour = over(layer, colour);
    return { colour, from: source };
  };
  // Opacity multiplies down the tree, so a faded ancestor fades its text too.
  // Skipping only opacity:0 measured a 50%-faded disabled control as if it were
  // painted at full strength.
  const fade = (node) => {
    let value = 1;
    for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
      value *= Number(getComputedStyle(current).opacity);
    }
    return value;
  };
  // WCAG 1.4.3 exempts text in an inactive component, and "inactive" has to mean
  // genuinely inert. This app also sets aria-disabled="true" on a button that
  // still answers clicks — it exists to say why the last model cannot be removed
  // — so keying off aria-disabled would excuse text people are meant to read.
  // Only the real disabled property counts, and exempt findings are reported
  // rather than asserted.
  const inert = (node) => {
    for (let current = node; current; current = current.parentElement) {
      if (current.disabled === true) return true;
    }
    return false;
  };
  const failures = [];
  const exempt = [];
  let examined = 0;
  for (const node of document.querySelectorAll("body *")) {
    // Only elements holding their own text: a wrapper would be measured against
    // its child's colour and report a failure that is not on screen.
    const own = [...node.childNodes]
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent.trim())
      .join("");
    if (!own) continue;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const parsedColour = parse(style.color);
    if (!parsedColour) continue;
    const opacity = fade(node);
    if (opacity === 0) continue;
    examined += 1;
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    // WCAG 1.4.3: 24px, or 18.66px when bold, drops the requirement to 3:1.
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    const behind = backdrop(node);
    // Text with its own alpha blends into whatever is behind it as well, and an
    // inherited opacity is one more alpha over the same backdrop.
    const effective = parsedColour[3] * opacity;
    const foreground = effective >= 1
      ? [parsedColour[0], parsedColour[1], parsedColour[2]]
      : over([parsedColour[0], parsedColour[1], parsedColour[2], effective], behind.colour);
    const measured = ratio(foreground, behind.colour);
    if (measured + 0.005 < required) {
      (inert(node) ? exempt : failures).push({
        text: own.slice(0, 30),
        ratio: Math.round(measured * 100) / 100,
        required,
        size,
        weight,
        opacity: Math.round(opacity * 100) / 100,
        selector: node.className ? \`\${node.tagName.toLowerCase()}.\${String(node.className).split(" ")[0]}\` : node.tagName.toLowerCase(),
        on: behind.from ? \`\${behind.from.tagName.toLowerCase()}.\${String(behind.from.className).split(" ")[0]}\` : "page",
      });
    }
  }
  return { failures, exempt, examined, theme: document.documentElement.dataset.theme || "light" };
})()`;

test("every piece of text meets WCAG AA contrast in both themes", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-contrast-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-contrast-"));
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
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3`);

    // Colour transitions are declared on these surfaces, and a measurement taken
    // mid-transition reads an interpolated background — which is how an earlier
    // version of this audit reported white text on a dark panel.
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // A fixed wait measures whatever frame it lands on. The first run of the hover
    // sweep reported five failures that were all one panel at 0.31 opacity, 56ms
    // into a 180ms fade — an animation frame, not a state anyone sits in. WCAG
    // judges the resting appearance, so wait for the animations to finish instead
    // of guessing a duration. The spinner and the skeleton shimmer never finish;
    // they are excluded by their infinite iteration count rather than by name, so
    // a new looping animation does not hang this.
    const settleAnimations = async (timeout = 3_000) => {
      // Transitions do not exist until the next style recalculation, so a poll
      // that starts immediately can find nothing running and return too early.
      await pause(80);
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const running = await cdp.evaluate(`document.getAnimations()
          .filter((animation) => animation.playState === "running")
          .filter((animation) => (animation.effect?.getComputedTiming().iterations ?? 1) !== Infinity)
          .length`);
        if (running === 0) return;
        await pause(50);
      }
      throw new Error("animations still running after 3s");
    };

    const settle = async () => {
      await pause(400);
      await settleAnimations();
    };

    const describe = (entry) =>
      `  ${entry.ratio}:1 (needs ${entry.required}) ${entry.size}px w${entry.weight}`
      + `${entry.opacity < 1 ? ` @${entry.opacity} opacity` : ""} ${entry.selector} on ${entry.on} :: ${entry.text}`;

    // Text WCAG exempts because its control is genuinely disabled. Not asserted —
    // the exemption is real — but printed, because "disabled" is a design choice
    // and the numbers should be visible when someone revisits it.
    const exemptFound = [];

    const audit = async (label) => {
      await settle();
      const result = await cdp.evaluate(CONTRAST_AUDIT);
      for (const entry of result.exempt) exemptFound.push({ ...entry, where: label });
      // Without this the whole test passes on a page that rendered nothing:
      // zero elements examined is zero failures.
      assert.ok(
        result.examined >= 30,
        `${label}: expected to examine real text, only found ${result.examined} elements`,
      );
      assert.deepEqual(
        result.failures,
        [],
        `${label} theme (${result.theme}) has ${result.failures.length} of ${result.examined} text elements below WCAG AA:\n`
        + result.failures.map(describe).join("\n"),
      );
      return result.examined;
    };

    // Hover repaints text and its surface together, and either side can move: a
    // link darkens, or the row underneath it lightens. `.safe-default` is only
    // ever on screen while its row is hovered, so every measurement above skipped
    // it — it sat at 4.49:1 against the default row's tint until this found it.
    //
    // The pointer is moved for real. Forcing :hover on one node would not apply
    // `.model-row:hover .safe-default`, where the hovered element and the
    // repainted text are different elements.
    const auditHovered = async (label) => {
      const targets = await cdp.evaluate(`(() => {
        // Every selector in the stylesheet whose :hover changes colour, resolved
        // to what is currently on screen, so this list follows the CSS instead of
        // being a copy of it that silently rots.
        const hoverRules = [...document.styleSheets]
          .flatMap((sheet) => {
            try { return [...sheet.cssRules]; } catch { return []; }
          })
          .filter((rule) => rule.selectorText && rule.selectorText.includes(":hover"))
          .filter((rule) => /(^|[^-])color:|background/.test(rule.style.cssText));
        const seen = new Set();
        const found = [];
        for (const rule of hoverRules) {
          for (const part of rule.selectorText.split(",")) {
            // Drop everything after :hover so the element that receives the
            // pointer is found, not the descendant that changes colour.
            const target = part.split(":hover")[0].trim();
            if (!target) continue;
            let nodes;
            try { nodes = document.querySelectorAll(target); } catch { continue; }
            for (const node of nodes) {
              const box = node.getBoundingClientRect();
              if (box.width === 0 || box.height === 0) continue;
              if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) continue;
              const x = Math.round(box.left + box.width / 2);
              const y = Math.round(box.top + box.height / 2);
              // The topmost element at that point is what will actually be
              // hovered; anything covered would report a state nobody can reach.
              if (!node.contains(document.elementFromPoint(x, y))) continue;
              const key = \`\${x},\${y}\`;
              if (seen.has(key)) continue;
              seen.add(key);
              found.push({ x, y, selector: target });
            }
          }
        }
        return found;
      })()`);
      assert.ok(
        targets.length >= 10,
        `${label}: expected hoverable targets, found ${targets.length}`,
      );

      const failures = [];
      for (const target of targets) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
        await settleAnimations();
        const result = await cdp.evaluate(CONTRAST_AUDIT);
        for (const entry of result.failures) failures.push({ ...entry, hovering: target.selector });
        for (const entry of result.exempt) {
          exemptFound.push({ ...entry, where: `${label} hovering ${target.selector}` });
        }
      }
      // Park the pointer outside the viewport so the next measurement is not
      // taken with something still hovered.
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
      await settle();

      assert.deepEqual(
        failures,
        [],
        `${label}: ${failures.length} text elements below WCAG AA while hovering `
        + `(${targets.length} targets swept):\n`
        + failures.map((entry) => `${describe(entry)} [hovering ${entry.hovering}]`).join("\n"),
      );
      return targets.length;
    };

    // States a freshly loaded page never shows. Each paints from tokens the
    // default view does not use at all — the toast surface, --danger-*, the
    // dialog — so auditing only the loaded page leaves them unmeasured, which is
    // exactly how the palette drifted out of contrast in the first place.
    const auditTransients = async (label) => {
      // A plain toast: arming a model delete explains what Pi will read.
      await cdp.evaluate(`document.querySelectorAll('.provider-item')[0].click()`);
      await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3`);
      await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
      await cdp.waitFor(`document.querySelector('.toast')`);
      await audit(`${label} with a toast`);

      // The delete dialog, reached the way a single-model provider forces it.
      await cdp.evaluate(`document.querySelectorAll('.provider-item')[1].click()`);
      await cdp.waitFor(`document.querySelectorAll('.model-row').length === 1`);
      await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
      await cdp.waitFor(`document.querySelector('.toast-action')`);
      await cdp.evaluate(`document.querySelector('.toast-action').click()`);
      await cdp.waitFor(`document.querySelector('.provider-delete-dialog')`);
      await audit(`${label} with the delete dialog`);
      await cdp.evaluate(`document.querySelector('.provider-delete-dialog .secondary-button').click()`);
      await cdp.waitFor(`!document.querySelector('.provider-delete-dialog')`);

      // The error banner and the error toast, from a write genuinely refused
      // because the file moved underneath the draft.
      const settingsPath = path.join(agentDir, "settings.json");
      const edited = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      edited.externalEditorField = `${label}-external-change`;
      fs.writeFileSync(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
      await cdp.evaluate(`document.querySelector('.nav-settings').click()`);
      await cdp.waitFor(`document.querySelector('.settings-page') && !document.querySelector('.settings-footer .primary-button').disabled`);
      await cdp.evaluate(`document.querySelector('.settings-footer .primary-button').click()`);
      await cdp.waitFor(`document.querySelector('.toast.is-error') && document.querySelector('.error-banner')`);
      await audit(`${label} with the error banner`);
      // "重新读取" re-reads the configuration and leaves the settings page by
      // itself, so following it with the page's own back button finds nothing.
      await cdp.evaluate(`document.querySelector('.toast-action').click()`);
      await cdp.waitFor(`document.querySelector('.model-row') && !document.querySelector('.error-banner')`);
    };

    const lightCount = await audit("light");
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.theme || 'light'`), "light");
    const lightHovers = await auditHovered("light");
    await auditTransients("light");

    // Through the app's own control rather than localStorage, which throws a
    // SecurityError on a page that has not finished navigating.
    await cdp.evaluate(`[...document.querySelectorAll('.theme-switch button')]
      .find((node) => node.getAttribute('aria-label') === '深色').click()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === 'dark'`);
    const darkCount = await audit("dark");
    const darkHovers = await auditHovered("dark");
    await auditTransients("dark");

    // Both themes must have been measured against comparable pages; a collapsed
    // dark render would otherwise pass on a much smaller sample.
    assert.ok(
      Math.abs(lightCount - darkCount) <= 5,
      `both themes should render the same page, examined ${lightCount} light and ${darkCount} dark`,
    );
    assert.ok(
      Math.abs(lightHovers - darkHovers) <= 5,
      `both themes should offer the same hover targets, swept ${lightHovers} light and ${darkHovers} dark`,
    );
    // Not a failure — WCAG exempts an inactive control — but a disabled style is
    // a decision, and the only way anyone revisits it is by seeing what it costs.
    if (exemptFound.length > 0) {
      console.log(`${exemptFound.length} exempt (disabled) text elements below AA:`);
      for (const entry of exemptFound) console.log(`${describe(entry)} [${entry.where}]`);
    }
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
  }
});

// WCAG 2.2 SC 2.5.8: 24x24 CSS px, or enough clear space around a smaller one.
// Two controls here were resized to meet it — `.tip-dismiss` from 22px and
// `.safe-default` from a 16px-tall line of text — and nothing measured either, so
// a later padding change could quietly undo the fix. The rest of this audit is
// shaped by the naive version of it being wrong twice: the default-model radio is
// a 22x20 input that looks like a failure until the <label> around it turns out to
// be an 86x42 click target, and the spacing exception cannot be waved at a control
// whose neighbour sits 4.5px away.
const TARGET_SIZE_AUDIT = `(() => {
  const MINIMUM = 24;
  // What a pointer actually has to hit. A radio inside a <label> is activated by
  // the whole label, so the input's own 22x20 box is not the target: a click in
  // the label's corner, well outside the input, selects it.
  const targetBox = (node) => {
    const label = node.closest("label");
    if (label && label.control === node) {
      const box = label.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return { box, from: "label" };
    }
    return { box: node.getBoundingClientRect(), from: "self" };
  };
  const targets = [];
  for (const node of document.querySelectorAll(
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])',
  )) {
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") continue;
    // Faded to nothing is not on screen; partly faded still is.
    let invisible = false;
    for (let current = node; current; current = current.parentElement) {
      if (Number(getComputedStyle(current).opacity) === 0) { invisible = true; break; }
    }
    if (invisible) continue;
    // SC 2.5.8 exempts a control that is genuinely inert.
    if (node.disabled === true) continue;
    const { box, from } = targetBox(node);
    if (box.width === 0 || box.height === 0) continue;
    targets.push({
      box,
      from,
      selector: node.className
        ? \`\${node.tagName.toLowerCase()}.\${String(node.className).split(" ")[0]}\`
        : node.tagName.toLowerCase(),
      label: (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 24),
    });
  }
  const failures = [];
  const undersized = [];
  for (const target of targets) {
    if (Math.min(target.box.width, target.box.height) >= MINIMUM) continue;
    const centre = {
      x: target.box.left + target.box.width / 2,
      y: target.box.top + target.box.height / 2,
    };
    // The spacing exception, as the spec words it: a 24px-diameter circle centred
    // on this target may not overlap the circle of any other one.
    const crowding = targets
      .filter((other) => other !== target)
      .map((other) => ({
        with: other.selector,
        gap: Math.round(Math.hypot(
          centre.x - (other.box.left + other.box.width / 2),
          centre.y - (other.box.top + other.box.height / 2),
        ) * 10) / 10,
      }))
      .filter((entry) => entry.gap < MINIMUM);
    const record = {
      selector: target.selector,
      label: target.label,
      size: \`\${Math.round(target.box.width)}x\${Math.round(target.box.height)}\`,
      measured: target.from,
      crowding,
    };
    undersized.push(record);
    if (crowding.length > 0) failures.push(record);
  }
  return { total: targets.length, undersized, failures };
})()`;

test("every control is big enough to hit", { timeout: 60_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-target-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-target-"));
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
    // Taller than the 720px the other tests use, and deliberately so: the sidebar
    // hides `.beginner-tip` at `(min-width: 861px) and (max-height: 760px)`, so at
    // 720 its dismiss button — one of the two controls this test exists for — is
    // not rendered at all. The first version of this test measured it as 0x0 and
    // the audit below never saw it.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3`);
    await cdp.waitFor(`document.querySelector('.tip-dismiss')`);

    const check = async (label) => {
      const result = await cdp.evaluate(TARGET_SIZE_AUDIT);
      // Zero controls examined is zero failures, which would pass forever.
      assert.ok(result.total >= 20, `${label}: expected real controls, found ${result.total}`);
      assert.deepEqual(
        result.failures,
        [],
        `${label}: ${result.failures.length} of ${result.total} controls are under 24x24 `
        + `without the clear space SC 2.5.8 accepts instead:\n`
        + result.failures
          .map((entry) => `  ${entry.size} ${entry.selector} (measured on ${entry.measured}) :: ${entry.label}`
            + `\n    ${entry.crowding.map((near) => `${near.gap}px from ${near.with}`).join(", ")}`)
          .join("\n"),
      );
      return result;
    };

    const initial = await check("default view");
    // Asserted by name as well as in the aggregate, so a change to the button this
    // test was written for cannot pass by qualifying for the spacing exception.
    assert.deepEqual(
      await cdp.evaluate(`(() => {
        const box = document.querySelector('.tip-dismiss').getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height) };
      })()`),
      { width: 24, height: 24 },
    );

    // `.safe-default` is invisible until its row is hovered, so the default view
    // never sees it — the state it is actually used in is the only one worth
    // measuring. The pointer moves for real: forcing :hover on one node does not
    // satisfy `.model-row:hover .safe-default`, where the hovered element and the
    // revealed one are different elements.
    const rowPoint = await cdp.evaluate(`(() => {
      const box = document.querySelector('.model-row').getBoundingClientRect();
      return { x: Math.round(box.left + 60), y: Math.round(box.top + box.height / 2) };
    })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowPoint.x, y: rowPoint.y });
    // Visibility flips at once but opacity fades over 110ms, and a control faded
    // to nothing is not on screen — waiting only for visibility measured the
    // button at opacity 0, where the audit correctly ignored it and the count
    // never moved. Wait for the state a person would actually be looking at.
    await cdp.waitFor(`(() => {
      const style = getComputedStyle(document.querySelector('.safe-default'));
      return style.visibility === 'visible' && Number(style.opacity) === 1;
    })()`);
    const hovered = await check("hovering a model row");
    assert.ok(
      hovered.total > initial.total,
      `hovering should reveal at least one more control, saw ${initial.total} then ${hovered.total}`,
    );
    assert.deepEqual(
      await cdp.evaluate(`(() => {
        const button = document.querySelector('.safe-default');
        const box = button.getBoundingClientRect();
        const row = document.querySelector('.model-row').getBoundingClientRect();
        const field = button.closest('label').querySelector('input');
        const hits = (y) => document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(y),
        ) === button;
        return {
          height: Math.round(box.height),
          // Padding can only add to a line box, so an unpinned line height makes
          // the target's size depend on whichever font the machine happens to
          // have. This assertion passed locally at 24px and failed on CI at 20px
          // for exactly that reason — the label is Chinese, so it is a CJK
          // fallback, not the declared stack, that decides. A measurement can
          // only ever see the fonts of the machine taking it, so the size being
          // font-independent has to be asserted rather than measured.
          lineBoxIsFixed: /px$/.test(getComputedStyle(button).lineHeight),
          // The 8px of padding has to be part of the hit area, not just the box.
          topHits: hits(box.top + 2),
          bottomHits: hits(box.bottom - 2),
          // It grew downward, so it must not have pushed the row taller...
          insideRow: box.bottom <= row.bottom,
          // ...and must not have stolen the bottom edge of the field above it.
          fieldKeepsItsEdge: document.elementFromPoint(
            Math.round(box.left + box.width / 2),
            Math.round(field.getBoundingClientRect().bottom - 2),
          ) === field,
        };
      })()`),
      {
        height: 24,
        lineBoxIsFixed: true,
        topHits: true,
        bottomHits: true,
        insideRow: true,
        fieldKeepsItsEdge: true,
      },
    );
    assert.deepEqual(await cdp.evaluate(rowMeasurements).then((rows) => rows.map((row) => row.height)), [85, 85, 85]);

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
  }
});

// The compatibility card is the one place that answers "which Pi is this talking
// to", and every number on it belongs to the running process. After an upgrade
// that nobody restarted, all of them are the previous release's — which reads as
// an upgrade that failed rather than one that is merely not loaded yet. The card
// has to say so, and the state payload alone cannot prove that it does.
test("the compatibility card says when the checkout has moved ahead of the process", { timeout: 60_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  // A copy of the checkout, so the manifest can move underneath a running server
  // without touching this repository's own.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-upgrade-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-upgrade-agent-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-"));
  const manifestPath = path.join(projectDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  fs.copyFileSync(path.join(projectRoot, "server.mjs"), path.join(projectDir, "server.mjs"));
  fs.cpSync(path.join(projectRoot, "lib"), path.join(projectDir, "lib"), { recursive: true });
  fs.cpSync(path.join(projectRoot, "dist", "client"), path.join(projectDir, "dist", "client"), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFixture(agentDir);
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server;
  let chrome;
  let cdp;

  try {
    server = spawn(process.execPath, [path.join(projectDir, "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_PROVIDER_MANAGER_SERVE_UI: "1",
        PI_PROVIDER_MANAGER_PORT: String(appPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
    const target = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}`)}`,
      { method: "PUT" },
    ).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

    const openSettings = async () => {
      await cdp.waitFor(`document.querySelector('.nav-settings')`);
      await cdp.evaluate(`document.querySelector('.nav-settings').click()`);
      await cdp.waitFor(`document.querySelector('.compatibility-card')`);
      return cdp.evaluate(`(() => {
        const card = document.querySelector('.compatibility-card');
        const labels = [...card.querySelectorAll('dt')].map((term) => term.textContent);
        return {
          managerVersion: card.querySelector('dl').children[[...labels].indexOf('管理器版本')].querySelector('dd').textContent,
          notes: [...card.querySelectorAll('.compat-note')].map((note) => note.textContent),
        };
      })()`);
    };

    // The state everyone is normally in: nothing to announce.
    const before = await openSettings();
    assert.equal(before.managerVersion, manifest.version);
    assert.equal(before.notes.some((note) => note.includes("磁盘上的管理器")), false, before.notes.join(" | "));

    // An upgrade lands on disk. The process keeps serving the code it loaded.
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "9.9.9" }));
    await cdp.send("Page.reload", { ignoreCache: true });
    const after = await openSettings();
    // The card still reports the running version — claiming the new one would
    // hide exactly the problem — and names both versions plus the way out.
    assert.equal(after.managerVersion, manifest.version);
    const note = after.notes.find((text) => text.includes("磁盘上的管理器"));
    assert.ok(note, `no upgrade note rendered: ${after.notes.join(" | ")}`);
    assert.match(note, /9\.9\.9/);
    assert.ok(note.includes(manifest.version), `the running version is not named: ${note}`);
    assert.match(note, /重启/);

    assert.deepEqual(cdp.errors, []);
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
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
