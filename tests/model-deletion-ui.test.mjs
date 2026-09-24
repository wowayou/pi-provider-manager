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
        path.join(playwrightRoot, directory, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        path.join(playwrightRoot, directory, "chrome-win", "chrome.exe"),
      ])
    : [];
  // The install locations are per-platform, and a suite that can only find
  // Chrome on Linux fails eight tests at once on a Windows checkout — which
  // reads as eight defects rather than as one missing path.
  const windowsCandidates = process.platform === "win32"
    ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
        .filter(Boolean)
        .flatMap((root) => [
          path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        ])
    : [];
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ...windowsCandidates,
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
      // A dirty draft now arms window.beforeunload, so a programmatic reload or
      // navigation raises a native leave prompt that would otherwise stall the
      // headless page. Auto-accepting models the user choosing to leave — the
      // same outcome the in-app discard toast produces.
      if (message.method === "Page.javascriptDialogOpening") {
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    });
  }

  static async connect(webSocketUrl) {
    // Node gained a global WebSocket in 22. On 18 and 20 every case here fails with
    // a bare "WebSocket is not defined" from this line, which reads as eight
    // defects in the product rather than one unmet requirement of the harness.
    // `engines.node` allows 18 because the server and `lib/` do run there — this
    // suite does not, and CI's ui job is why nobody noticed. Thrown, never skipped:
    // a skip would report success for a browser that was never opened.
    if (typeof WebSocket === "undefined") {
      throw new Error(
        `the browser suite needs a global WebSocket, added in Node 22; this is ${process.version}.`
        + " Run it on the version CI's ui job uses.",
      );
    }
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
    const page = await Promise.race([
      this.evaluate(`({
        readyState: document.readyState,
        loading: Boolean(document.querySelector('.loading-state')),
        loadFailed: Boolean(document.querySelector('.load-error')),
        target: document.querySelector('.target-switch [aria-checked=true]')?.textContent,
        heading: document.querySelector('.workspace h1')?.textContent,
        protocolStep: Boolean(document.querySelector('.protocol-grid')),
        modelRows: document.querySelectorAll('.model-row').length
      })`).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    throw new Error(`Timed out waiting for ${expression}${lastError ? `: ${lastError.message}` : ""}`
      + `\nPage: ${JSON.stringify(page)}\nBrowser errors: ${JSON.stringify(this.errors.slice(-3)).slice(0, 4000)}`);
  }

  close() {
    for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed."));
    this.pending.clear();
    this.socket.close();
  }
}

// The server resolves a Codex directory on every /api/state, so a test that never
// opens the Codex side still has to name one. Left unset it reads the developer's
// real ~/.codex: their gateway IDs and base URLs end up in this suite's failure
// output, and the run depends on one machine's private config. A path inside the Pi
// fixture directory is isolated, absent the way it is for anyone without Codex
// installed, and disappears when the fixture does.
const isolatedCodexDir = (agentDir) => path.join(agentDir, "codex");

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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
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
    assert.deepEqual(initial.rows.map((row) => row.height), [80, 80, 80]);
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
    // Selecting a different default radio above edited the draft, so the shared
    // leave guard asks first; discard to reach Settings.
    await cdp.waitFor(`document.querySelector('.toast-action')`);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
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
    // Measured before the toast exists. This asks whether anything in the 420px
    // layout covers the delete control, and the toast is a transient overlay this
    // test itself raises — reading it afterwards made the answer depend on the
    // toast's height against the scroll position, which moves with font metrics.
    // That is exactly how it failed once on CI and passed on re-run with the page
    // byte-identical, so the assertion was measuring the toast, not the control.
    const removeTopmost = await cdp.evaluate(`(() => {
      const button = document.querySelector('.model-row .icon-button');
      const box = button.getBoundingClientRect();
      const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return topmost?.closest('.icon-button') === button;
    })()`);
    await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
    await cdp.waitFor(`document.querySelector('.toast')`);
    const mobile = { ...(await cdp.evaluate(`(() => {
      const toast = document.querySelector('.toast').getBoundingClientRect();
      const shell = document.querySelector('.app-shell').getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const workspace = document.querySelector('.workspace').getBoundingClientRect();
      const content = document.querySelector('.step-content').getBoundingClientRect();
      const footer = document.querySelector('.wizard-footer').getBoundingClientRect();
      const table = document.querySelector('.models-table').getBoundingClientRect();
      const remove = document.querySelector('.model-row .icon-button').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        verticalOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        shellHeight: shell.height,
        frameFits: sidebar.top >= shell.top && workspace.bottom <= shell.bottom + 1,
        providerRailVisible: document.querySelector('.provider-list').getBoundingClientRect().height >= 48,
        footerVisible: footer.top >= content.top && footer.bottom <= content.bottom + 1,
        removeVisible: remove.left >= table.left && remove.right <= table.right + 1,
        toastLeft: toast.left,
        toastRight: toast.right,
        rowHeights: [...document.querySelectorAll('.model-row')].map((row) => row.getBoundingClientRect().height),
      };
    })()`)), removeTopmost };
    assert.equal(mobile.overflow, 0);
    assert.equal(mobile.verticalOverflow, 0);
    assert.equal(mobile.shellHeight, 900);
    assert.equal(mobile.frameFits, true);
    assert.equal(mobile.providerRailVisible, true);
    assert.equal(mobile.footerVisible, true);
    assert.equal(mobile.removeVisible, true);
    assert.equal(mobile.removeTopmost, true);
    assert.ok(mobile.toastLeft >= 0 && mobile.toastRight <= 420);
    assert.deepEqual(mobile.rowHeights, [80, 80, 80]);

    await cdp.evaluate(`document.querySelectorAll('.provider-select')[1].click()`);
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
    // The banner outlives the toast, so it carries the same action itself.
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.banner-reload'))`), true);
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

test("复制供应商 starts a fresh draft with the models and an empty credential", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-copy-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-copy-"));
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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
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
    // The default provider (review-router) opens straight into its editor.
    await cdp.waitFor(`document.querySelector('.duplicate-provider-button') && document.querySelectorAll('.model-row').length === 3`);
    await cdp.waitFor(`document.querySelector('.duplicate-provider-button')`);
    const before = await cdp.evaluate(`({
      rows: document.querySelectorAll('.model-row').length,
      baseUrl: (document.querySelector('.gateway-address-button') || document.querySelector('.gateway-summary code'))?.textContent || "",
    })`);
    assert.equal(before.rows, 3);

    await cdp.evaluate(`document.querySelector('.duplicate-provider-button').click()`);
    await cdp.waitFor(`document.querySelector('.form-grid input')`);
    const draft = await cdp.evaluate(`({
      providerId: document.querySelector('.form-grid input').value,
      baseUrl: document.querySelectorAll('.form-grid input')[1].value,
      // The copy's id is not in authProviders yet, so the "保留现有 key" tab is
      // absent: the first tab is 输入新 key, and it is the active one.
      tabs: [...document.querySelectorAll('.credential-tabs button')].map((button) => ({ text: button.textContent, active: button.classList.contains('is-active') })),
      keyField: Boolean(document.querySelector('.key-field input')),
    })`);
    assert.equal(draft.providerId, "review-router-copy");
    assert.equal(draft.baseUrl, before.baseUrl);
    assert.deepEqual(draft.tabs, [{ text: "输入新 key", active: true }, { text: "从已有凭据迁移", active: false }]);
    assert.equal(draft.keyField, true);

    await cdp.evaluate(`document.querySelector('.key-field input').focus()`);
    await cdp.send("Input.insertText", { text: "dummy-copy-key" });
    await cdp.evaluate(`[...document.querySelectorAll('.wizard-footer button')].find((button) => button.textContent.includes("下一步")).click()`);
    await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3`);
    const copiedIds = await cdp.evaluate(`[...document.querySelectorAll('.model-row .model-name-cell input')].map((input) => input.value)`);
    assert.deepEqual(copiedIds, ["anthropic/claude-opus", "openai/gpt-router", "google/gemini-router"]);

    await cdp.evaluate(`document.querySelector('.advanced-panel summary').click()`);
    await cdp.waitFor(`document.querySelector('.advanced-panel[open] .user-agent-field input')`);
    assert.deepEqual(await cdp.evaluate(`({
      open: document.querySelector('.advanced-panel').open,
      value: document.querySelector('.user-agent-field input').value,
      placeholder: document.querySelector('.user-agent-field input').placeholder,
    })`), { open: true, value: "", placeholder: "未设置供应商 UA 覆盖" });

    await cdp.evaluate(`[...document.querySelectorAll('.user-agent-actions button')].find((button) => button.textContent.includes("Claude Code")).click()`);
    await cdp.waitFor(`document.querySelector('.user-agent-field input').value.startsWith("claude-cli/") && document.querySelector('.toast-action')`);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelector('.user-agent-field input').value === ""`);

    await cdp.evaluate(`document.querySelector('.user-agent-field input').focus()`);
    await cdp.send("Input.insertText", { text: "$BAD" });
    await cdp.evaluate(`[...document.querySelectorAll('.wizard-footer button')].find((button) => button.textContent.includes("保存并设为默认")).click()`);
    await cdp.waitFor(`document.querySelector('.advanced-panel').open && document.querySelector('.user-agent-field input[aria-invalid="true"]') && document.querySelector('.field-error')`);
    assert.match(await cdp.evaluate(`document.querySelector('.field-error').textContent`), /不能包含/);

    await cdp.evaluate(`document.querySelector('.user-agent-actions button:last-child').click()`);
    await cdp.waitFor(`document.querySelector('.user-agent-field input').value === ""`);

    await cdp.evaluate(`[...document.querySelectorAll('.wizard-footer button')].find((button) => button.textContent.includes("保存并设为默认")).click()`);
    await cdp.waitFor(`document.querySelector('.success-page')`);

    const state = await fetch(`http://127.0.0.1:${appPort}/api/state`).then((response) => response.json());
    const copyProvider = state.providers.find((provider) => provider.id === "review-router-copy");
    assert.equal(copyProvider.models.length, 3);
    assert.equal(copyProvider.baseUrl, before.baseUrl);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["review-router-copy"].models.length, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["review-router-copy"].api, "openai-completions");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["review-router-copy"].headers, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["review-router-copy"].key, "dummy-copy-key");
    // The source provider is untouched, and stays the count it started with.
    assert.equal(state.providers.find((provider) => provider.id === "review-router").models.length, 3);
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
    await cdp.waitFor(`document.querySelector('.target-switch button:not(:disabled)')`);

    // Both targets answer "which one is Pi/Codex actually using" in the sidebar.
    // On Pi that is settings.json's defaultProvider, and only that one row: the
    // fixture's default is review-router, so single-router must stay unmarked.
    await cdp.waitFor(`document.querySelectorAll('.provider-item').length === 2`);
    assert.deepEqual(
      await cdp.evaluate(`[...document.querySelectorAll('.provider-item')].map((row) => [
        row.querySelector('.provider-copy strong').textContent,
        row.querySelector('.provider-badge').textContent,
      ])`),
      [["Review Router", "默认"], ["Single Router", ""]],
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

    // 复制供应商 is offered for a draft whose ID names a stored provider, which is
    // exactly what the handler requires before it will copy anything. Renaming
    // that ID to a fresh value used to leave the button standing where clicking
    // it did nothing at all — the gate read the selection, the handler read the
    // form. Pi has always gated this control on the fact its handler checks.
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.duplicate-provider-button'))`), true);
    await clickText(".wizard-footer button", "上一步");
    await cdp.waitFor(`document.querySelector('.form-grid input')`);
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.form-grid input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'custom-renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // The adopted table needs a key of its own — this fixture ships no auth.json —
    // and the step says so rather than letting 下一步 through.
    await cdp.evaluate(`document.querySelector('.key-field input').focus()`);
    await cdp.send("Input.insertText", { text: "dummy-rename-key" });
    await clickText(".wizard-footer button", "下一步");
    await cdp.waitFor(`document.querySelector('.model-row.is-codex')`);
    assert.deepEqual(await cdp.evaluate(`({
      duplicate: Boolean(document.querySelector('.duplicate-provider-button')),
      // Deleting still applies: that flow acts on the stored provider this draft
      // was opened from, and its dialog names it.
      remove: Boolean(document.querySelector('.delete-provider-button')),
    })`), { duplicate: false, remove: true });

    // Removing the model config.toml points at is the one deletion with a
    // consequence outside this draft, so arming names it — the same fact Pi
    // states about settings.json. Only the active provider has a live model, so
    // this is reachable only back under the stored ID.
    await clickText(".wizard-footer button", "上一步");
    await cdp.waitFor(`document.querySelector('.form-grid input')`);
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.form-grid input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'custom');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await clickText(".wizard-footer button", "下一步");
    await cdp.waitFor(`document.querySelector('.model-row.is-codex')`);
    await clickText(".models-actions button", "添加模型");
    await cdp.waitFor(`document.querySelectorAll('.model-row.is-codex').length === 2`);
    await cdp.evaluate(`document.querySelector('.model-row.is-codex .icon-button').click()`);
    await cdp.waitFor(`document.querySelector('.toast.is-error')`);
    assert.match(
      await cdp.evaluate(`document.querySelector('.toast').textContent`),
      /需要先指定另一个已命名模型才能保存/,
    );
    // Arming removes nothing: the row is still there.
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.model-row.is-codex').length`), 2);
    // Name the replacement row and arm again — the other half of the same branch,
    // which names the model the default moves to rather than asking for one. Wait
    // out the arm window first: a synthetic click does not focus the button, so
    // `onBlur` never fires to reset it and a second click would delete the row.
    await cdp.waitFor(
      `!document.querySelector('.model-row.is-codex .icon-button').classList.contains('is-confirming')`,
      8_000,
    );
    await cdp.evaluate(`(() => {
      const input = document.querySelectorAll('.model-row.is-codex .model-name-cell input')[1];
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'gpt-5.6-mini');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evaluate(`document.querySelector('.model-row.is-codex .icon-button').click()`);
    await cdp.waitFor(`document.querySelector('.toast.is-error')?.textContent.includes('Codex 的默认模型改为')`);
    assert.match(await cdp.evaluate(`document.querySelector('.toast').textContent`), /gpt-5\.6-mini/);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.model-row.is-codex').length`), 2);

    // Add a second provider through the wizard.
    await cdp.evaluate(`document.querySelector('.add-provider').click()`);
    // The current Codex draft was edited above, so the shared leave guard asks
    // first; discard to proceed to the fresh draft.
    await cdp.waitFor(`document.querySelector('.toast-action')`);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
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
    await cdp.waitFor(`document.querySelector('.target-switch button:not(:disabled)')`);

    const clickText = (selector, text) =>
      cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => node.textContent.includes(${JSON.stringify(text)})).click()`);

    await clickText(".target-switch button", "Codex");
    await cdp.waitFor(`document.querySelectorAll('.provider-item').length === 2`);

    // Opening a provider that has models lands on the model step; the credentials
    // step is reached back through the stepper, the way a person would.
    const openCredentials = async (name) => {
      await clickText(".provider-select", name);
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
    await cdp.waitFor(`document.querySelector('.target-switch button:not(:disabled)')`);

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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
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
      await cdp.evaluate(`document.querySelectorAll('.provider-select')[0].click()`);
      await cdp.waitFor(`document.querySelectorAll('.model-row').length === 3`);
      await cdp.evaluate(`document.querySelector('.model-row .icon-button').click()`);
      await cdp.waitFor(`document.querySelector('.toast')`);
      await audit(`${label} with a toast`);

      // The delete dialog, reached the way a single-model provider forces it.
      await cdp.evaluate(`document.querySelectorAll('.provider-select')[1].click()`);
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

      // The reload returns to the previously selected provider, which can
      // differ after the dialog path above. Keep both theme measurements on
      // the same three-model page so the page signature tests theme parity,
      // not navigation state.
      await cdp.evaluate(`document.querySelectorAll('.provider-select')[0].click()`);
      await cdp.waitFor(`document.querySelector('.models-step') && document.querySelectorAll('.model-row').length === 3 && !document.querySelector('.error-banner')`);
    };

    const pageSignature = () => cdp.evaluate(`({
      selectedProvider: document.querySelector('.provider-item.is-selected')?.textContent.trim() || "",
      modelIds: [...document.querySelectorAll('.model-name-cell input')].map((input) => input.value),
      visibleView: [...document.querySelectorAll('.step-content, .settings-page, .success-page')]
        .find((node) => getComputedStyle(node).display !== 'none')?.className || "",
      hasBeginnerTip: Boolean(document.querySelector('.beginner-tip')),
    })`);

    const lightCount = await audit("light");
    const lightSignature = await pageSignature();
    assert.equal(await cdp.evaluate(`document.documentElement.dataset.theme || 'light'`), "light");
    const lightHovers = await auditHovered("light");
    await auditTransients("light");

    // Through the app's own control rather than localStorage, which throws a
    // SecurityError on a page that has not finished navigating. The appearance
    // control cycles system → light → dark, so click it until dark lands.
    await cdp.evaluate(`(async () => {
      for (let i = 0; i < 3 && document.documentElement.dataset.theme !== 'dark'; i++) {
        document.querySelector('.theme-cycle-icon').click();
        await new Promise((r) => setTimeout(r, 30));
      }
    })()`);
    await cdp.waitFor(`document.documentElement.dataset.theme === 'dark'`);
    const darkCount = await audit("dark");
    const darkSignature = await pageSignature();
    const darkHovers = await auditHovered("dark");
    await auditTransients("dark");

    // Browser-reported text geometry can differ between color-scheme values for
    // native controls. Compare the rendered page structure instead, while the
    // per-theme audit above still checks every measurable text node.
    assert.deepEqual(
      darkSignature,
      lightSignature,
      `both themes should render the same page (examined ${lightCount} light and ${darkCount} dark)`,
    );
    assert.ok(
      Math.abs(lightHovers - darkHovers) <= 5,
      `both themes should offer the same hover targets, swept ${lightHovers} light and ${darkHovers} dark`,
    );
    // Not a failure — WCAG exempts an inactive control — but a disabled style is
    // a decision, and the only way anyone revisits it is by seeing what it costs.
    // Grouped, because the hover sweep and the transient states re-measure the
    // same control many times over: one finding printed twenty times is a finding
    // nobody reads. The one entry currently expected is the disabled-state
    // paragraph in design-qa.md, and the rule that sets its numbers is
    // `button:disabled` in src/styles.css.
    if (exemptFound.length > 0) {
      const grouped = new Map();
      for (const entry of exemptFound) {
        const key = `${entry.selector} :: ${entry.text} :: ${entry.ratio}`;
        const group = grouped.get(key) || { entry, where: [] };
        group.where.push(entry.where);
        grouped.set(key, group);
      }
      console.log(`${exemptFound.length} exempt (disabled) measurements below AA, ${grouped.size} distinct:`);
      for (const { entry, where } of grouped.values()) {
        console.log(`${describe(entry)} [${where.length} states, first: ${where[0]}]`);
      }
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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
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
    assert.deepEqual(await cdp.evaluate(rowMeasurements).then((rows) => rows.map((row) => row.height)), [80, 80, 80]);

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
  // The restart replaces the server this test started, so the process to stop at
  // the end is not the one spawn() returned.
  let replacedPid = 0;

  try {
    server = spawn(process.execPath, [path.join(projectDir, "server.mjs")], {
      cwd: projectDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
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
      await cdp.waitFor(`document.querySelector('.nav-settings:not(:disabled)')`);
      await cdp.evaluate(`document.querySelector('.nav-settings').click()`);
      await cdp.waitFor(`document.querySelector('.manager-card')`);
      return cdp.evaluate(`(() => {
        const card = document.querySelector('.manager-card');
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

    // Checking for a release is offered, and says where it would go before it goes:
    // a page load that had already looked would be a page load that reached the
    // network, which this project does not do.
    const update = await cdp.evaluate(`(() => {
      const row = document.querySelector('.compat-update-row');
      return { button: row.querySelector('button').textContent, hint: row.querySelector('span').textContent };
    })()`);
    assert.match(update.button, /检查更新/);
    assert.match(update.hint, /只有按下这个按钮才会联网/);
    assert.match(update.hint, /api\.github\.com/);

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

    // The note names a restart, and the card offers to do it. Telling someone to
    // find a pid and kill it is the version of this that nobody carries out.
    const label = await cdp.evaluate(`document.querySelector('.restart-button').textContent`);
    assert.match(label, /重启以应用 9\.9\.9/);
    replacedPid = (await (await fetch(`http://127.0.0.1:${appPort}/api/state`)).json()).compatibility.servicePid;
    // Marks this document, because every selector on the page survives the reload:
    // waiting for one of those would pass against the page that is still up and
    // then race the reload. A property on window does not survive it.
    await cdp.evaluate(`window.__beforeRestart = true`);
    await cdp.evaluate(`document.querySelector('.restart-button').click()`);
    // The page reloads itself once a different process answers, so this covers the
    // whole handover rather than just the request being accepted.
    await cdp.waitFor(`!window.__beforeRestart && document.querySelector('.nav-settings:not(:disabled)')`, 40_000);
    const applied = await openSettings();
    assert.equal(applied.managerVersion, "9.9.9");
    // Nothing left to announce: the version running is the version on disk.
    assert.equal(applied.notes.some((text) => text.includes("磁盘上的管理器")), false, applied.notes.join(" | "));
    const replacement = await (await fetch(`http://127.0.0.1:${appPort}/api/state`)).json();
    assert.notEqual(replacement.compatibility.servicePid, replacedPid, "the same process cannot be running new code");
    assert.equal(replacement.restartError, "");
    replacedPid = replacement.compatibility.servicePid;

    // An actual edit is the one thing a restart would discard, so that — and only
    // that — is confirmed first. Two of this screen's five keys are absent from the
    // fixture's settings.json, which is the ordinary state and must not be treated
    // as unsaved work.
    await cdp.evaluate(`(() => {
      const select = document.querySelector('.settings-card select');
      select.value = [...select.options].map((option) => option.value).find((value) => value !== select.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await cdp.evaluate(`document.querySelector('.restart-button').click()`);
    await cdp.waitFor(`[...document.querySelectorAll('.compat-restart button')].some((button) => button.textContent.includes('确认重启'))`);
    const asked = await cdp.evaluate(`document.querySelector('.compat-restart .is-warning').textContent`);
    assert.match(asked, /未保存的修改/);
    // Cancelling has to leave the manager alone.
    await cdp.evaluate(`[...document.querySelectorAll('.compat-restart button')].find((button) => button.textContent.includes('取消')).click()`);
    await cdp.waitFor(`document.querySelector('.restart-button')`);
    const stillThere = await (await fetch(`http://127.0.0.1:${appPort}/api/state`)).json();
    assert.equal(stillThere.compatibility.servicePid, replacedPid);

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
    // Whoever holds the port now, rather than a pid remembered earlier: a failure
    // between the restart and the last assertion would leave the replacement
    // running under a pid this test never recorded.
    try {
      const holder = await (await fetch(`http://127.0.0.1:${appPort}/api/state`)).json();
      if (holder.compatibility?.servicePid > 0) replacedPid = holder.compatibility.servicePid;
    } catch {}
    if (replacedPid > 0) {
      try { process.kill(replacedPid, "SIGTERM"); } catch {}
      // SIGTERM only asks. projectDir is that process's working directory, and
      // Windows refuses to remove one of those while it still exists, so the
      // exit has to be waited out rather than assumed.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { process.kill(replacedPid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// An ID that already names a provider is not an error — saving really does replace
// that provider — so the field cannot refuse it. What it must not do is stay quiet.
// The only earlier signal was the footer button on the *next* step reading
// 保存更改 instead of 保存并设为默认, which nobody reads as "this discards
// review-router's address and model list".
test("the credentials step says when saving would replace another provider", { timeout: 60_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-overwrite-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-overwrite-"));
  writeFixture(agentDir);
  const modelsPath = path.join(agentDir, "models.json");
  const untouched = fs.readFileSync(modelsPath, "utf8");
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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
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
    await cdp.waitFor(`document.querySelectorAll('.provider-item').length === 2`);

    const clickText = (selector, text) =>
      cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => node.textContent.includes(${JSON.stringify(text)})).click()`);
    const setId = (value) => cdp.evaluate(`(() => {
      const input = document.querySelectorAll('.form-grid input')[0];
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const warnings = () =>
      cdp.evaluate(`[...document.querySelectorAll('.field-warning')].map((node) => node.textContent)`);
    const idField = () => cdp.evaluate(`(() => {
      const input = document.querySelectorAll('.form-grid input')[0];
      return { value: input.value, invalid: input.getAttribute('aria-invalid') };
    })()`);

    // A fresh draft, stopped on the step where the ID is typed.
    await cdp.evaluate(`document.querySelector('.add-provider').click()`);
    await cdp.waitFor(`document.querySelector('.protocol-grid')`);
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor(`document.querySelector('.form-grid input')`);
    assert.deepEqual(await warnings(), []);

    // The collision is stated beside the field, and states the cost.
    await setId("review-router");
    await cdp.waitFor(`document.querySelector('.field-warning')`);
    const collision = await warnings();
    assert.equal(collision.length, 1, collision.join(" | "));
    assert.match(collision[0], /已有同名供应商/);
    assert.match(collision[0], /替换/);
    assert.match(collision[0], /地址/);
    assert.match(collision[0], /模型列表/);
    // A warning, not a refusal: the value stands and the field is not marked bad.
    assert.deepEqual(await idField(), { value: "review-router", invalid: null });

    // A free ID has nothing to say.
    await setId("fresh-router");
    await cdp.waitFor(`document.querySelectorAll('.field-warning').length === 0`);

    // An ID the shared pattern rejects shows that rule instead of the collision
    // one, and marks the field while it is being typed rather than reverting it.
    await setId("bad@id");
    await cdp.waitFor(`document.querySelector('.field-warning')`);
    const rejected = await warnings();
    assert.equal(rejected.length, 1, rejected.join(" | "));
    assert.match(rejected[0], /只能使用小写字母/);
    assert.equal((await idField()).invalid, "true");

    // Editing review-router itself is not a collision with review-router. This is
    // the half a plain "does this ID exist" check gets wrong, and getting it wrong
    // puts an overwrite warning on every edit of every saved provider.
    await cdp.evaluate(`document.querySelectorAll('.provider-select')[0].click()`);
    // A new draft with typed-in fields is edited, so the shared leave guard asks
    // first; discard to open the stored provider.
    await cdp.waitFor(`document.querySelector('.toast-action')`);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelector('.model-row')`);
    await cdp.evaluate(`document.querySelectorAll('.stepper .step')[1].click()`);
    await cdp.waitFor(`document.querySelector('.form-grid input')`);
    assert.equal((await idField()).value, "review-router");
    assert.deepEqual(await warnings(), []);

    // Renaming that same draft onto its sibling is a collision again.
    await setId("single-router");
    await cdp.waitFor(`document.querySelector('.field-warning')`);
    assert.match((await warnings())[0], /已有同名供应商/);

    // Warning about a write is not performing one.
    assert.equal(fs.readFileSync(modelsPath, "utf8"), untouched);
    assert.deepEqual(cdp.errors, []);
    assert.equal(serverOutput.includes("Error"), false, serverOutput);
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

// The prompt editor holds the only copy of that text: it is the document, not a
// form over a record that could be re-read. All three ways out of it — another
// document, another file, 新建 — discarded the edit on the first click, so leaving
// is offered through the toast's action instead.
test("leaving an edited prompt goes through the toast, not the first click", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-promptguard-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-promptguard-"));
  writeFixture(agentDir);
  const liveText = "# 我的规则\n\n始终使用中文回复。\n";
  const otherText = "Answer in English.\n";
  // Two documents, one of them matching the file on disk so it resolves as live
  // rather than being adopted as "现有内容".
  fs.writeFileSync(path.join(agentDir, "pi-provider-manager-prompts.json"), JSON.stringify({
    version: 1,
    slots: {
      agents: {
        activeId: "chinese",
        documents: {
          chinese: { name: "中文优先", text: liveText },
          english: { name: "English", text: otherText },
        },
      },
    },
  }));
  const agentsPath = path.join(agentDir, "AGENTS.md");
  fs.writeFileSync(agentsPath, liveText);
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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
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

    await cdp.waitFor(`document.querySelector('.nav-prompts:not(:disabled)')`);
    await cdp.evaluate(`document.querySelector('.nav-prompts').click()`);
    await cdp.waitFor(`document.querySelector('.prompt-editor textarea')`);

    const editor = () => cdp.evaluate(`(() => ({
      text: document.querySelector('.prompt-editor textarea').value,
      name: document.querySelector('.prompt-editor input').value,
      selected: document.querySelector('.prompt-item.is-selected .prompt-item-name')?.textContent || "",
      slot: document.querySelector('.prompt-slot.is-active code')?.textContent || "",
    }))()`);
    const type = (value) => cdp.evaluate(`(() => {
      const area = document.querySelector('.prompt-editor textarea');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(value)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const toast = () => cdp.evaluate(`(() => {
      const node = document.querySelector('.toast');
      return node ? { text: node.textContent, error: node.classList.contains('is-error'), action: node.querySelector('.toast-action')?.textContent || "" } : null;
    })()`);
    const dismissToast = async () => {
      await cdp.evaluate(`document.querySelector('.toast-close')?.click()`);
      await cdp.waitFor(`!document.querySelector('.toast')`);
    };

    // The live document opens first, and AGENTS.md is one of three files.
    const opened = await editor();
    assert.equal(opened.selected, "中文优先");
    assert.equal(opened.text, liveText);
    assert.equal(opened.slot, "AGENTS.md");

    const edited = `${liveText}又加了一行。\n`;

    // 1. Another document. The first click must not switch, and must not discard.
    await type(edited);
    await cdp.evaluate(`[...document.querySelectorAll('.prompt-item')]
      .find((node) => node.textContent.includes('English')).click()`);
    await cdp.waitFor(`document.querySelector('.toast')`);
    const blocked = await toast();
    assert.equal(blocked.error, true);
    assert.match(blocked.text, /未保存的修改/);
    assert.equal(blocked.action, "放弃修改并切换");
    const held = await editor();
    assert.equal(held.selected, "中文优先", "the first click switched documents");
    assert.equal(held.text, edited, "the first click discarded the edit");

    // The toast's action is what leaves.
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelector('.prompt-editor textarea').value === ${JSON.stringify(otherText)}`);
    assert.equal((await editor()).selected, "English");

    // 2. 新建. Same guard, same way out.
    await dismissToast();
    await type(`${otherText}another line\n`);
    await cdp.evaluate(`document.querySelector('.prompt-list .add-provider').click()`);
    await cdp.waitFor(`document.querySelector('.toast')`);
    assert.equal((await toast()).action, "放弃修改并切换");
    assert.equal((await editor()).text, `${otherText}another line\n`);
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelector('.prompt-editor textarea').value === ''`);
    assert.equal((await editor()).name, "");

    // 3. Another file. A new draft with text in it counts as edited too.
    await dismissToast();
    await type("写给 SYSTEM.md 的内容\n");
    await cdp.evaluate(`[...document.querySelectorAll('.prompt-slot')]
      .find((node) => node.textContent.includes('SYSTEM.md')).click()`);
    await cdp.waitFor(`document.querySelector('.toast')`);
    assert.equal((await toast()).action, "放弃修改并切换");
    assert.equal((await editor()).slot, "AGENTS.md", "the first click switched files");
    await cdp.evaluate(`document.querySelector('.toast-action').click()`);
    await cdp.waitFor(`document.querySelector('.prompt-slot.is-active code').textContent === 'SYSTEM.md'`);

    // Clicking the document that is already open is not a switch, so it must not
    // raise the guard against itself.
    await dismissToast();
    await cdp.evaluate(`[...document.querySelectorAll('.prompt-slot')]
      .find((node) => node.textContent.includes('AGENTS.md')).click()`);
    await cdp.waitFor(`document.querySelector('.prompt-slot.is-active code').textContent === 'AGENTS.md'`);
    await cdp.evaluate(`document.querySelector('.prompt-item.is-selected').click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await toast(), null, "re-picking the open document raised the guard");

    // None of that was a write: the guard exists to protect the editor, and the
    // file only changes through 保存.
    assert.equal(fs.readFileSync(agentsPath, "utf8"), liveText);
    assert.deepEqual(cdp.errors, []);
    assert.equal(serverOutput.includes("Error"), false, serverOutput);
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

test("production UI keeps new-draft User-Agent intent and locates invalid whitespace", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-user-agent-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-user-agent-"));
  writeFixture(agentDir);
  const modelsPath = path.join(agentDir, "models.json");
  const fixture = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  fixture.providers["review-router"].headers = { "User-Agent": "old-client/1.0" };
  fs.writeFileSync(modelsPath, JSON.stringify(fixture));
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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
        PI_PROVIDER_MANAGER_SERVE_UI: "1",
        PI_PROVIDER_MANAGER_PORT: String(appPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; });
    server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");

    chrome = spawn(chromePath, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=" + debugPort,
      "--user-data-dir=" + profileDir,
      "about:blank",
    ], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch(
      "http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort),
      { method: "PUT" },
    ).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");

    const clickText = (selector, text) => cdp.evaluate(
      "[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()",
    );
    const setNthInput = (index, value) => cdp.evaluate(
      "(() => { const input = document.querySelectorAll('.form-grid input')[" + index + "];"
      + "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
      + "setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()",
    );
    const setValue = (selector, value) => cdp.evaluate(
      "(() => { const input = document.querySelector(" + JSON.stringify(selector) + ");"
      + "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
      + "setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()",
    );

    // A fresh draft with an existing ID must explicitly clear the target's old
    // literal UA; leaving the field absent would preserve it on disk.
    await cdp.evaluate("document.querySelector('.add-provider').click()");
    await cdp.waitFor("document.querySelector('.protocol-grid')");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelectorAll('.form-grid input').length === 2");
    await setNthInput(0, "review-router");
    await setNthInput(1, "https://replacement.example/v1");
    await setValue("input[type=password]", "replacement-key-not-real");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelector('.models-table')");
    assert.equal(await cdp.evaluate("document.querySelector('.user-agent-field input').value"), "");
    await clickText(".wizard-footer .primary-button", "保存更改");
    await cdp.waitFor("document.querySelector('.success-page')");
    const savedState = await (await fetch("http://127.0.0.1:" + appPort + "/api/state")).json();
    const savedProvider = savedState.providers.find((provider) => provider.id === "review-router");
    assert.deepEqual(savedProvider.userAgent, { kind: "none" });
    const savedModels = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    assert.equal(savedModels.providers["review-router"].headers, undefined);

    // The same production page must locate a server-invalid value even after
    // the advanced details have been collapsed before Save is pressed.
    await cdp.evaluate(
      "[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('review-router')).click()",
    );
    await cdp.waitFor("document.querySelector('.models-table')");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("document.querySelector('.user-agent-field input')");
    await setValue(".user-agent-field input", " ".repeat(513));
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("!document.querySelector('.advanced-panel').open");
    await clickText(".wizard-footer .primary-button", "保存更改");
    await cdp.waitFor("document.querySelector('.advanced-panel[open] input[aria-invalid=\"true\"]')");
    const invalid = await cdp.evaluate("({ open: document.querySelector('.advanced-panel').open, invalid: document.querySelector('.user-agent-field input').getAttribute('aria-invalid'), error: document.querySelector('.field-error').textContent, banner: document.querySelector('.error-banner').textContent })");
    assert.deepEqual(invalid, {
      open: true,
      invalid: "true",
      error: "供应商 UA 最多 512 字节。",
      banner: "供应商 UA 最多 512 字节。",
    });
    assert.deepEqual(cdp.errors, []);
    assert.equal(serverOutput.includes("Error"), false, serverOutput);
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


test("production UI edits Anthropic Beta and preserves unrelated draft edits", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-beta-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-beta-"));
  writeFixture(agentDir);
  const modelsPath = path.join(agentDir, "models.json");
  const fixture = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  fixture.providers["review-router"].api = "anthropic-messages";
  fixture.providers["review-router"].models = fixture.providers["review-router"].models.slice(0, 2);
  fs.writeFileSync(modelsPath, JSON.stringify(fixture));
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 2");
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    const setValue = (selector, value) => cdp.evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await cdp.evaluate("[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('review-router')).click()");
    await cdp.waitFor("document.querySelector('.models-table')");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("document.querySelector('.beta-group select')");
    await setValue(".beta-value-field input", "context-1m-2025-08-07");
    await clickText(".wizard-footer .primary-button", "保存更改");
    await cdp.waitFor("document.querySelector('.success-page')");
    let saved = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    assert.equal(saved.providers["review-router"].models[0].headers["anthropic-beta"], "context-1m-2025-08-07");
    await cdp.evaluate("[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('review-router')).click()");
    await cdp.waitFor("document.querySelector('.beta-value-field input')");
    assert.equal(await cdp.evaluate("document.querySelector('.beta-value-field input').value"), "context-1m-2025-08-07");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("document.querySelector('.advanced-panel').open");
    await clickText(".beta-actions button", "清除模型覆盖");

    // The report this round came from: a model on an Anthropic-protocol relay,
    // switched to an OpenAI protocol by the per-model override, given a beta.
    // Pi sends model.headers on every protocol, so the field stays editable and
    // the save goes through; the note only says most such gateways ignore it.
    // Add an override for the second model through the picker, then set it.
    await cdp.evaluate("(() => { const add = document.querySelector('.protocol-add-field select'); const option = [...add.options].find((o) => o.textContent === 'openai/gpt-router'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(add, option.value); add.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await cdp.waitFor("[...document.querySelectorAll('.protocol-group label')].some((label) => label.querySelector('.mono')?.textContent === 'openai/gpt-router')");
    await cdp.evaluate("(() => { const label = [...document.querySelectorAll('.protocol-group label')].find((l) => l.querySelector('.mono')?.textContent === 'openai/gpt-router'); const select = label.querySelector('select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(select, 'openai-completions'); select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await cdp.evaluate("(() => { const select = document.querySelector('.beta-model-field select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(select, select.options[1].value); select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await cdp.waitFor("document.querySelector('.beta-group .compat-note')");
    assert.match(await cdp.evaluate("document.querySelector('.beta-group .compat-note').textContent"), /仍会把这个请求头原样发出/);
    assert.equal(await cdp.evaluate("document.querySelector('.beta-value-field input').readOnly"), false, "the beta field went read-only on a non-Anthropic protocol");
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.beta-actions button')].find((node) => node.textContent.includes('1M 示例')).disabled"), false);
    await setValue(".beta-value-field input", "beta-on-openai");
    await clickText(".wizard-footer .primary-button", "保存更改");
    await cdp.waitFor("document.querySelector('.success-page')");
    saved = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    assert.equal(saved.providers["review-router"].models[1].api, "openai-completions");
    assert.equal(saved.providers["review-router"].models[1].headers["anthropic-beta"], "beta-on-openai");
    assert.equal(Object.hasOwn(saved.providers["review-router"].models[0], "headers"), false, "the cleared override on the first model came back");
    await cdp.evaluate("[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('review-router')).click()");
    await cdp.waitFor("document.querySelector('.models-table')");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("document.querySelector('.advanced-panel').open");
    // Back to the first model for the undo and invalid-value steps below.
    await cdp.evaluate("(() => { const select = document.querySelector('.beta-model-field select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(select, select.options[0].value); select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await setValue(".beta-value-field input", "context-1m-2025-08-07");
    await clickText(".beta-actions button", "清除模型覆盖");
    await cdp.evaluate("document.querySelector('.model-row input:not([readonly])').focus()");
    await setValue(".model-row input:not([readonly])", "211K");
    await cdp.evaluate("document.querySelector('.model-row input:not([readonly])').blur()");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cdp.evaluate("[...document.querySelectorAll('.toast-action')].at(-1).click()");
    assert.equal(await cdp.evaluate("document.querySelector('.beta-value-field input').value"), "context-1m-2025-08-07");
    assert.equal(await cdp.evaluate("document.querySelector('.model-row input:not([readonly])').value"), "211K");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await setValue(".beta-value-field input", "$BETA");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await clickText(".wizard-footer .primary-button", "保存更改");
    await cdp.waitFor("document.querySelector('.advanced-panel[open] .beta-value-field input[aria-invalid=\"true\"]')");
    assert.equal(await cdp.evaluate("document.querySelector('.advanced-panel').open"), true);
    await cdp.waitFor("document.activeElement === document.querySelector('.beta-value-field input')");
    assert.equal(await cdp.evaluate("document.querySelector('.success-page')"), null);
    assert.deepEqual(cdp.errors, []);
    assert.equal(serverOutput.includes("Error"), false, serverOutput);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("production UI imports the models a gateway lists, and explains a gateway it cannot reach", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-discover-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-discover-"));
  writeFixture(agentDir);
  const [appPort, debugPort, gatewayPort] = await Promise.all([freePort(), freePort(), freePort()]);
  // The stored provider points at a stand-in gateway on loopback, so the
  // listing is fetched with the key the fixture stored — never one the browser saw.
  const modelsPath = path.join(agentDir, "models.json");
  const fixture = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
  fixture.providers["review-router"].baseUrl = `http://127.0.0.1:${gatewayPort}/v1`;
  fs.writeFileSync(modelsPath, JSON.stringify(fixture));
  let server; let chrome; let cdp; let gateway; let serverOutput = ""; let gatewayOutput = "";
  try {
    gateway = spawn(process.execPath, [path.join(projectRoot, "tests", "fixtures", "fake-chat-gateway.mjs"), String(gatewayPort), "dummy-browser-test-key"], { stdio: ["ignore", "ignore", "pipe"] });
    gateway.stderr.on("data", (chunk) => { gatewayOutput += chunk; });
    await waitForUrl(`http://127.0.0.1:${gatewayPort}/v1/models`);
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl(`http://127.0.0.1:${appPort}/api/state`);
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
    const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}`)}`, { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");
    const clickText = (selector, text) => cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(text)})).click()`);

    await clickText(".models-actions button", "获取模型");
    await cdp.waitFor("document.querySelector('.discover-modal .discover-row')");
    assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('.discover-row .mono')].map((node) => node.textContent)"), ["fake-chat-model"]);
    assert.equal(await cdp.evaluate("document.querySelector('.discover-modal .primary-button').disabled"), true, "nothing is selected until the user picks");
    await cdp.evaluate("document.querySelector('.discover-row input').click()");
    assert.equal(await cdp.evaluate("document.querySelector('.discover-modal .modal-count').textContent"), "网关返回 1 个模型，已选 1 个");
    await clickText(".discover-modal .primary-button", "导入 1 个模型");
    await cdp.waitFor("!document.querySelector('.discover-modal') && document.querySelectorAll('.model-row').length === 4");
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.model-row .model-name-cell input')].at(-1).value"), "fake-chat-model");
    assert.match(await cdp.evaluate("document.querySelector('.toast')?.textContent || ''"), /已从网关导入 1 个模型/);
    assert.match(gatewayOutput, /GET \/v1\/models auth=yes/, "the listing was fetched without the stored credential");

    // The dialog fits a short window. Once the path field joined the heading,
    // the filter and a 420px list, the actions row sat below the fold on a
    // 600px viewport with nothing to scroll — the primary button was simply
    // off-screen. Measured in the resting layout before anything is clicked.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 600, deviceScaleFactor: 1, mobile: false });
    await clickText(".models-actions button", "获取模型");
    await cdp.waitFor("document.querySelector('.discover-modal .discover-row')");
    const fit = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.discover-modal').getBoundingClientRect();
      const primary = document.querySelector('.discover-modal .primary-button').getBoundingClientRect();
      const heading = document.querySelector('.discover-modal .modal-heading').getBoundingClientRect();
      const list = document.querySelector('.discover-list');
      return {
        dialogInside: dialog.top >= 0 && dialog.bottom <= window.innerHeight,
        primaryInside: primary.top >= 0 && primary.bottom <= window.innerHeight,
        headingInside: heading.top >= 0,
        listScrolls: getComputedStyle(list).overflowY === 'auto',
      };
    })()`);
    assert.deepEqual(fit, { dialogInside: true, primaryInside: true, headingInside: true, listScrolls: true });
    await clickText(".discover-modal .secondary-button", "取消");
    await cdp.waitFor("!document.querySelector('.discover-modal')");
    await cdp.send("Emulation.clearDeviceMetricsOverride");

    // Already-listed IDs are shown but cannot be imported twice.
    await clickText(".models-actions button", "获取模型");
    await cdp.waitFor("document.querySelector('.discover-modal .discover-row.is-existing input:disabled')");
    assert.equal(await cdp.evaluate("document.querySelector('.discover-modal .modal-count').textContent"), "网关返回 1 个模型，已选 0 个");
    await clickText(".discover-modal .secondary-button", "取消");
    await cdp.waitFor("!document.querySelector('.discover-modal')");

    // The path is overridable, because relays do not agree on where a
    // catalogue lives: deepseek serves chat under /anthropic and its list at
    // the root, so the protocol default 404s there and only an override reaches
    // it. The dialog states which URL answered rather than leaving the user to
    // guess whether the override took effect.
    await clickText(".models-actions button", "获取模型");
    await cdp.waitFor("document.querySelector('.discover-modal .discover-path input')");
    assert.equal(await cdp.evaluate("document.querySelector('.discover-path input').placeholder"), "/models", "the field offers the protocol default");
    assert.equal(await cdp.evaluate("document.querySelector('.discover-path input').value"), "", "an override is opt-in");
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.discover-path input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '/v1/models?limit=5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await clickText(".discover-path-row button", "用这个路径重试");
    await cdp.waitFor("document.querySelector('.discover-modal .modal-heading code').textContent.includes('limit=5')");
    assert.match(gatewayOutput, /GET \/v1\/models\?limit=5/, "the override was not the URL asked for");

    // Same origin is the boundary: this request carries a stored credential, so
    // a path that could change host must be refused rather than sent.
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.discover-path input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'https://evil.example/v1/models');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await clickText(".discover-path-row button", "用这个路径重试");
    await cdp.waitFor("document.querySelector('.discover-modal .error-banner')");
    assert.match(await cdp.evaluate("document.querySelector('.discover-modal .error-banner').textContent"), /同源/);
    assert.equal(gatewayOutput.includes("evil.example"), false, "the refused host was contacted");
    await clickText(".discover-modal .secondary-button", "取消");
    await cdp.waitFor("!document.querySelector('.discover-modal')");
    assert.equal(await cdp.evaluate("document.querySelectorAll('.model-row').length"), 4, "a path experiment changed the draft");
    // A gateway that does not answer is reported in the dialog, with a retry.
    await stopProcess(gateway);
    await clickText(".models-actions button", "获取模型");
    await cdp.waitFor("document.querySelector('.discover-modal .error-banner')");
    assert.match(await cdp.evaluate("document.querySelector('.discover-modal .error-banner').textContent"), /无法连接网关/);
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.discover-modal button')].some((node) => node.textContent.includes('重试'))"), true);
    await clickText(".discover-modal .secondary-button", "取消");
    await cdp.waitFor("!document.querySelector('.discover-modal')");
    assert.equal(await cdp.evaluate("document.querySelectorAll('.model-row').length"), 4, "a failed listing changed the draft");
    assert.deepEqual(cdp.errors, []);
    assert.equal(serverOutput.includes("Error"), false, serverOutput);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server); await stopProcess(gateway);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the sidebar row menu deletes a provider without opening it first", { timeout: 60_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-rowmenu-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-rowmenu-"));
  writeFixture(agentDir);
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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
        PI_PROVIDER_MANAGER_SERVE_UI: "1",
        PI_PROVIDER_MANAGER_PORT: String(appPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; });
    server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl(`http://127.0.0.1:${appPort}/api/state`);
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
    const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}`)}`, { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor("document.querySelectorAll('.provider-item').length === 2");

    // The default (review-router) is auto-opened in the wizard; single-router is
    // not the open provider. Deleting it must not require navigating to it first.
    assert.match(await cdp.evaluate("document.querySelector('.provider-item.is-selected .provider-copy strong')?.textContent || ''"), /Review Router/);
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('single-router')).closest('.provider-item').classList.contains('is-selected')"), false);

    // Open the row menu for single-router and delete it, never clicking the row.
    await cdp.evaluate(`[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('single-router')).parentElement.querySelector('.row-menu-trigger').click()`);
    await cdp.waitFor("document.querySelector('.row-menu-popup')");
    await cdp.evaluate(`[...document.querySelectorAll('.row-menu-popup button')].find((node) => node.textContent.includes('删除供应商')).click()`);
    await cdp.waitFor("document.querySelector('.provider-delete-dialog') && document.activeElement === document.querySelector('.provider-delete-dialog .secondary-button')");

    // The dialog names the row's own provider, not the (unselected) wizard draft.
    assert.match(await cdp.evaluate("document.querySelector('#provider-delete-description').textContent"), /single-router/);
    // single-router is not Pi's default, so no replacement is required.
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.replacement-panel'))"), false);
    await cdp.evaluate("document.querySelector('.provider-delete-dialog .danger-button').click()");
    await cdp.waitFor("!document.querySelector('.provider-delete-dialog') && document.querySelectorAll('.provider-item').length === 1 && document.querySelector('.toast')");

    // The right provider was removed from disk, the default left intact.
    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.deepEqual(Object.keys(models.providers), ["review-router"]);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "review-router");
    // Its credential went with it by default.
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(Object.hasOwn(auth, "single-router"), false);
    assert.equal(cdp.errors.length, 0);
  } catch (error) {
    error.message += `\nServer output:\n${serverOutput}`;
    throw error;
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("selection mode bulk-deletes providers from the sidebar", { timeout: 60_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-bulk-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-bulk-"));
  writeFixture(agentDir);
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
        PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir),
        PI_PROVIDER_MANAGER_SERVE_UI: "1",
        PI_PROVIDER_MANAGER_PORT: String(appPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; });
    server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl(`http://127.0.0.1:${appPort}/api/state`);
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
    const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${appPort}`)}`, { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}` });
    await cdp.waitFor("document.querySelectorAll('.provider-item').length === 2");

    // Enter selection mode from the entry beside the count.
    await cdp.evaluate("[...document.querySelectorAll('.select-toggle')].find((node) => node.textContent.includes('选择')).click()");
    await cdp.waitFor("document.querySelector('.bulk-action-bar')");

    // Check single-router (not Pi's default) by clicking its row.
    await cdp.evaluate(`[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('single-router')).click()`);
    await cdp.waitFor("document.querySelector('.bulk-action-count').textContent === '已选 1 个'");

    await cdp.evaluate("[...document.querySelectorAll('.bulk-action-bar button')].find((node) => node.textContent.includes('删除')).click()");
    await cdp.waitFor("document.querySelector('.provider-delete-dialog')");
    // The set names single-router; the default is not in it, so no replacement panel.
    assert.match(await cdp.evaluate("document.querySelector('.bulk-delete-list').textContent"), /single-router/);
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.replacement-panel'))"), false);
    await cdp.evaluate("document.querySelector('.provider-delete-dialog .danger-button').click()");
    await cdp.waitFor("!document.querySelector('.provider-delete-dialog') && document.querySelectorAll('.provider-item').length === 1 && !document.querySelector('.bulk-action-bar')");

    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.deepEqual(Object.keys(models.providers), ["review-router"]);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "review-router");
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    assert.equal(Object.hasOwn(auth, "single-router"), false);
    assert.equal(cdp.errors.length, 0);
  } catch (error) {
    error.message += `\nServer output:\n${serverOutput}`;
    throw error;
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the shared leave guard warns before dropping an edited draft", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-guard-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-guard-"));
  writeFixture(agentDir);
  const settingsPath = path.join(agentDir, "settings.json");
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    const setValue = (selector, value) => cdp.evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    const beforeUnloadPrevented = () => cdp.evaluate("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()");

    // A clean draft leaves at once and does not arm the native prompt.
    assert.equal(await beforeUnloadPrevented(), false);

    // Edit the draft by moving the default-model radio to the second row.
    await cdp.evaluate("document.querySelectorAll('.model-row input[type=radio]')[1].click()");
    await cdp.waitFor("document.querySelectorAll('.model-row input[type=radio]')[1].checked");
    // The footer now says there are unsaved changes, and the button reads 保存更改
    // because review-router is Pi's current default.
    assert.equal(await cdp.evaluate("document.querySelector('.wizard-footer .dirty-note').textContent"), "有未保存的修改");
    assert.equal(await cdp.evaluate("document.querySelector('.wizard-footer .primary-button').textContent.trim()"), "保存更改");
    // An edited draft arms window.beforeunload.
    assert.equal(await beforeUnloadPrevented(), true);

    // Selecting another provider does not navigate; it raises the discard toast.
    await cdp.evaluate("[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('single-router')).click()");
    await cdp.waitFor("document.querySelector('.toast-action')");
    assert.match(await cdp.evaluate("document.querySelector('.toast').textContent"), /未保存的修改/);
    assert.equal(await cdp.evaluate("document.querySelector('.toast-action').textContent"), "放弃修改并离开");
    // Still on review-router: three model rows, nothing switched.
    assert.equal(await cdp.evaluate("document.querySelectorAll('.model-row').length"), 3);

    // Discarding proceeds to the other provider.
    await cdp.evaluate("document.querySelector('.toast-action').click()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 1 && document.querySelector('.model-name-cell input').value === 'only/model'");
    // The freshly loaded provider is clean, so no native prompt is armed and a
    // second switch is immediate.
    assert.equal(await beforeUnloadPrevented(), false);
    await cdp.evaluate("[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('review-router')).click()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");

    // A new provider added alongside existing ones offers 只保存 as well as
    // 保存并设为默认, and 只保存 leaves settings.json's default untouched.
    const settingsBefore = fs.readFileSync(settingsPath, "utf8");
    await cdp.evaluate("document.querySelector('.add-provider').click()");
    await cdp.waitFor("document.querySelector('.protocol-grid')");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelectorAll('.form-grid input').length === 2");
    await setValue(".form-grid input", "backup-router");
    await cdp.evaluate("(() => { const input = document.querySelectorAll('.form-grid input')[1]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, 'https://backup.example/v1'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await setValue("input[type=password]", "backup-key-not-real");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelector('.models-table')");
    const footerButtons = await cdp.evaluate("[...document.querySelectorAll('.wizard-footer .footer-actions button')].map((node) => node.textContent.trim())");
    assert.deepEqual(footerButtons, ["只保存", "保存并设为默认"]);
    await clickText(".wizard-footer .footer-actions button", "只保存");
    await cdp.waitFor("document.querySelector('.success-page')");
    assert.match(await cdp.evaluate("document.querySelector('.success-summary').textContent"), /全局默认模型没有改动/);
    const settingsAfter = fs.readFileSync(settingsPath, "utf8");
    assert.equal(JSON.parse(settingsAfter).defaultProvider, "review-router");
    assert.equal(JSON.parse(settingsBefore).defaultProvider, "review-router");

    assert.deepEqual(cdp.errors, []);
    assert.equal(serverOutput.includes("Error"), false, serverOutput);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the first Pi provider can only be saved as default", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-first-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-first-"));
  // An empty Pi config: no providers, no credentials, no default.
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}");
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    const setValue = (selector, value) => cdp.evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    // Zero providers: the wizard is on step one with an empty sidebar.
    await cdp.waitFor("document.querySelector('.protocol-grid')");
    assert.equal(await cdp.evaluate("document.querySelectorAll('.provider-item').length"), 0);
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelectorAll('.form-grid input').length === 2");
    await setValue(".form-grid input", "first-router");
    await cdp.evaluate("(() => { const input = document.querySelectorAll('.form-grid input')[1]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, 'https://first.example/v1'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await setValue("input[type=password]", "first-key-not-real");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelector('.models-table')");
    // No 只保存 for the very first provider: there is nothing to displace.
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.wizard-footer .footer-actions'))"), false);
    assert.equal(await cdp.evaluate("document.querySelector('.wizard-footer .primary-button').textContent.trim()"), "保存并设为默认");
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a saved bridged Codex provider gets its bridge control on the success screen", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-brg-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-brg-codex-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-brg-"));
  writeFixture(agentDir);
  // An empty Codex config: a fresh bridged provider has room to be created.
  fs.writeFileSync(path.join(codexDir, "config.toml"), "");
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: codexDir, PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    const setNth = (index, value) => cdp.evaluate("(() => { const input = document.querySelectorAll('.form-grid input')[" + index + "]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await cdp.waitFor("document.querySelector('.target-switch button:not(:disabled)')");
    await clickText(".target-switch button", "Codex");
    await cdp.waitFor("document.querySelector('.protocol-grid.is-duo')");
    // Pick the chat/completions (bridge) path — the second card.
    await cdp.evaluate("document.querySelectorAll('.protocol-card')[1].click()");
    await cdp.waitFor("document.querySelector('.protocol-card.is-selected b').textContent.includes('经本地桥')");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelectorAll('.form-grid input').length === 3");
    await setNth(0, "relay");
    await setNth(1, "Relay");
    await setNth(2, "https://relay.example/v1");
    await cdp.evaluate("(() => { const input = document.querySelector('.key-field input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, 'upstream-key-not-real'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelector('.model-row.is-codex')");
    await clickText(".wizard-footer .primary-button", "保存并设为当前生效");
    await cdp.waitFor("document.querySelector('.success-page')", 20_000);
    // The success screen leads with the bridge control, because the codex
    // command it advertises fails until the bridge is running.
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.bridge-first-step .bridge-control'))"), true);
    assert.equal(await cdp.evaluate("document.querySelector('.command-row code').textContent"), "codex");
    // Either the manager can supervise (a 启动桥 button) or it hands over a
    // manual command; both are the bridge control, never a bare codex prompt.
    const bridgeUi = await cdp.evaluate("(() => { const step = document.querySelector('.bridge-first-step'); return { startButton: [...step.querySelectorAll('button')].some((b) => b.textContent.includes('启动桥')), manual: Boolean(step.querySelector('.bridge-command')) }; })()");
    assert.equal(bridgeUi.startButton || bridgeUi.manual, true, JSON.stringify(bridgeUi));
    // The bridge key never comes back to the browser.
    assert.equal(await cdp.evaluate("(async () => (await (await fetch('/api/state', { cache: 'no-store' })).text()).includes('upstream-key-not-real'))()"), false);
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(codexDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("editing a saved provider jumps steps, focuses invalid fields, and moves the heading", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-jump-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-jump-"));
  writeFixture(agentDir);
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    const setValue = (selector, value) => cdp.evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");

    // Entering Settings via the sidebar sends focus to the settings heading.
    await cdp.evaluate("document.querySelector('.nav-settings').click()");
    await cdp.waitFor("document.querySelector('.settings-page') && document.activeElement === document.querySelector('.workspace h1')");
    // That heading is focused only to announce the screen (tabindex=-1, never in
    // the tab order). Forcing :focus-visible — which a keyboard reload leaves on,
    // and what boxed the models-step heading on first open — must not draw the
    // app focus ring around a non-interactive heading.
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const doc = await cdp.send("DOM.getDocument", { depth: 1 });
    const headingNode = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".workspace h1" });
    await cdp.send("CSS.forcePseudoState", { nodeId: headingNode.nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
    // outline-style none means nothing is painted, whatever the computed width
    // (the `outline: none` shorthand leaves width at its `medium` initial).
    assert.equal(
      await cdp.evaluate("getComputedStyle(document.querySelector('.workspace h1')).outlineStyle"),
      "none",
      "the announcement heading must not show the app focus ring",
    );
    await cdp.send("CSS.forcePseudoState", { nodeId: headingNode.nodeId, forcedPseudoClasses: [] });
    await cdp.evaluate("document.querySelector('.settings-title .secondary-button').click()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");

    // A saved provider's stepper allows a free jump: step three is reachable
    // from step one, and its steps are not disabled.
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.stepper .step')].every((step) => !step.disabled)"), true);
    await cdp.evaluate("document.querySelectorAll('.stepper .step')[0].click()");
    await cdp.waitFor("document.querySelector('.protocol-grid')");
    // Footer 下一步 moves focus to the next heading.
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelector('.form-grid input') && document.activeElement === document.querySelector('.workspace h1')");

    // Clearing the API address and pressing 下一步 focuses that field and marks
    // it invalid, with the banner in view.
    await setValue(".form-grid input[type=url]", "");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.activeElement === document.querySelector('.form-grid input[type=url]')");
    assert.equal(await cdp.evaluate("document.querySelector('.form-grid input[type=url]').getAttribute('aria-invalid')"), "true");
    assert.match(await cdp.evaluate("document.querySelector('.error-banner').textContent"), /API 地址/);

    // Restore the address and jump straight to the models step from here.
    await setValue(".form-grid input[type=url]", "https://router.example/v1");
    await cdp.evaluate("document.querySelectorAll('.stepper .step')[2].click()");
    await cdp.waitFor("document.querySelector('.models-table')");

    // The gateway summary's address is a button that returns to step two with
    // the caret on the API address.
    await cdp.evaluate("document.querySelector('.gateway-address-button').click()");
    await cdp.waitFor("document.activeElement === document.querySelector('.form-grid input[type=url]')");

    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a long model catalogue filters for display only and adds protocol overrides on demand", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-filter-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-filter-"));
  const modelIds = [
    ...Array.from({ length: 5 }, (_, i) => `anthropic/claude-${i + 1}`),
    ...Array.from({ length: 7 }, (_, i) => `openai/gpt-${i + 1}`),
  ];
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "big-router": { type: "api_key", key: "dummy-big-key" } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "big-router": {
        baseUrl: "https://big.example/v1",
        api: "openai-completions",
        models: modelIds.map((id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000 })),
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "big-router", defaultModel: "anthropic/claude-1" }));
  const modelsPath = path.join(agentDir, "models.json");
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    const setValue = (selector, value) => cdp.evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 12");

    // Filtering shows only matches and reports the count; it does not touch the
    // default marker.
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.model-filter'))"), true);
    const defaultBefore = await cdp.evaluate("document.querySelector('.model-row input[type=radio]:checked').closest('.model-row').querySelector('.model-name-cell input').value");
    await setValue(".model-filter", "claude");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 5");
    assert.match(await cdp.evaluate("document.querySelector('.models-header .count-pill').textContent"), /匹配 5 \/ 共 12/);
    await setValue(".model-filter", "");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 12");

    // Saving while filtered still posts every model. Make a benign edit first
    // (this provider is the current default, so 保存更改 is gated on dirtiness).
    await setValue(".model-filter", "gpt");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 7");
    await cdp.evaluate("(() => { const select = document.querySelector('.model-row select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(select, 'yes'); select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await cdp.waitFor("document.querySelector('.wizard-footer .dirty-note').textContent === '有未保存的修改'");
    await clickText(".wizard-footer .primary-button", "保存更改");
    await cdp.waitFor("document.querySelector('.success-page')");
    const saved = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    assert.equal(saved.providers["big-router"].models.length, 12);
    assert.equal(defaultBefore, "anthropic/claude-1");

    // Back in the editor, the protocol-override group renders no per-model
    // selects until one is added through the picker.
    await cdp.evaluate("[...document.querySelectorAll('.provider-select')].find((node) => node.title.includes('big-router')).click()");
    await cdp.waitFor("document.querySelector('.models-table')");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("document.querySelector('.protocol-group')");
    // Only the "add override" picker exists — not one select per model.
    assert.equal(await cdp.evaluate("document.querySelectorAll('.protocol-group select').length"), 1);
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.protocol-add-field'))"), true);
    // Add an override for the first inheriting model.
    await cdp.evaluate("(() => { const select = document.querySelector('.protocol-add-field select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(select, select.options[1].value); select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await cdp.waitFor("document.querySelectorAll('.protocol-group select').length === 2");

    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the toast stack keeps an undo alive and pauses on hover", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-toast-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-toast-"));
  writeFixture(agentDir);
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");

    // Delete the second (non-default) model: arm, then confirm, which raises an
    // undo toast.
    await cdp.evaluate("document.querySelectorAll('.model-row')[1].querySelector('.icon-button').click()");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await cdp.evaluate("document.querySelectorAll('.model-row')[1].querySelector('.icon-button').click()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 2 && document.querySelector('.toast-action')");

    // Immediately arm another delete: its plain toast must not evict the undo.
    await cdp.evaluate("document.querySelectorAll('.model-row')[0].querySelector('.icon-button').click()");
    await cdp.waitFor("document.querySelectorAll('.toast').length === 2");
    // The undo toast (with 撤销) is still present and clickable.
    const undoStillThere = await cdp.evaluate("[...document.querySelectorAll('.toast-action')].some((node) => node.textContent.includes('撤销'))");
    assert.equal(undoStillThere, true);
    // The arm toast is an error tone and announces assertively.
    const armToast = await cdp.evaluate("(() => { const t = [...document.querySelectorAll('.toast.is-error')][0]; return { role: t.getAttribute('role'), live: t.getAttribute('aria-live') }; })()");
    assert.deepEqual(armToast, { role: "alert", live: "assertive" });
    // Clicking the undo restores the deleted model.
    await cdp.evaluate("[...document.querySelectorAll('.toast-action')].find((node) => node.textContent.includes('撤销')).click()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");

    // Pause on hover: a plain arm toast (3.2s) survives past its lifetime while
    // hovered, then closes once the pointer leaves.
    await cdp.evaluate("document.querySelectorAll('.model-row')[0].querySelector('.icon-button').click()");
    await cdp.waitFor("document.querySelector('.toast')");
    const toastBox = await cdp.evaluate("(() => { const r = document.querySelector('.toast').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: toastBox.x, y: toastBox.y });
    await new Promise((resolve) => setTimeout(resolve, 3600));
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.toast'))"), true, "a hovered toast must not expire");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    await cdp.waitFor("!document.querySelector('.toast')", 6000);

    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("initial navigation waits for configuration, including after a failed read", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-initial-state-"));
  const codexDir = isolatedCodexDir(agentDir);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-initial-state-"));
  writeFixture(agentDir);
  fs.mkdirSync(codexDir);
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nname = "现成的供应商"\nbase_url = "https://existing.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp;
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: codexDir, PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: "ignore" });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(findChrome(), ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: "ignore" });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?about:blank", { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    // Hold the actual browser request until after navigation is exercised.
    // No sleeps or product test hooks: the race is deterministic on fast hosts too.
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/state", requestStage: "Request" }] });
    const nextStateRequest = () => new Promise((resolve) => {
      const listener = ({ data }) => {
        const message = JSON.parse(data);
        if (message.method !== "Fetch.requestPaused") return;
        cdp.socket.removeEventListener("message", listener);
        resolve(message.params.requestId);
      };
      cdp.socket.addEventListener("message", listener);
    });
    const navigation = ".target-switch button, .add-provider, .nav-settings, .nav-prompts";
    const assertNavigationLocked = async () => {
      assert.deepEqual(await cdp.evaluate(`Array.from(document.querySelectorAll('${navigation}'), (button) => button.disabled)`), [true, true, true, true, true]);
      // Native clicks and the target radio group's arrow keys must both be inert.
      await cdp.evaluate(`(() => {
        document.querySelectorAll('${navigation}').forEach((button) => button.click());
        document.querySelector('.target-switch button').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      })()`);
      assert.equal(await cdp.evaluate("document.querySelector('.target-switch [aria-checked=true]').textContent"), "Pi");
    };
    let request = nextStateRequest();
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const initialRequestId = await request;
    await cdp.waitFor("document.querySelector('.loading-state')");
    await assertNavigationLocked();
    await cdp.send("Fetch.continueRequest", { requestId: initialRequestId });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");
    assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('${navigation}')).some((button) => button.disabled)`), false);
    await cdp.evaluate("document.querySelectorAll('.target-switch button')[1].click()");
    await cdp.waitFor("document.querySelector('.model-row.is-codex') && document.querySelector('.delete-provider-button')");
    assert.equal(await cdp.evaluate("document.querySelector('.model-row.is-codex input').value"), "gpt-5.6-sol");
    await cdp.evaluate("document.querySelectorAll('.target-switch button')[0].click()");
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");
    await cdp.evaluate("document.querySelector('.add-provider').click()");
    await cdp.waitFor("document.querySelector('.protocol-grid')");

    // A failed first read must not unlock navigation against an empty state.
    request = nextStateRequest();
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    await cdp.send("Fetch.fulfillRequest", { requestId: await request, responseCode: 503, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify({ error: "fixture state read failed" })).toString("base64") });
    await cdp.waitFor("document.querySelector('.load-error')");
    await assertNavigationLocked();
    assert.equal(await cdp.evaluate("document.querySelector('.load-error button').disabled"), false);
    request = nextStateRequest();
    await cdp.evaluate("document.querySelector('.load-error button').click()");
    const retryRequestId = await request;
    await cdp.waitFor("document.querySelector('.loading-state')");
    await assertNavigationLocked();
    await cdp.send("Fetch.continueRequest", { requestId: retryRequestId });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");
    assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('${navigation}')).some((button) => button.disabled)`), false);
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the Codex delete dialog keeps a blocked delete focusable and explains it", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-cdel-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-cdel-codex-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-cdel-"));
  writeFixture(agentDir);
  const configPath = path.join(codexDir, "config.toml");
  const soleProvider = 'model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nname = "现成的供应商"\nbase_url = "https://existing.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n';
  fs.writeFileSync(configPath, soleProvider);
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: codexDir, PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    await cdp.waitFor("document.querySelector('.target-switch button:not(:disabled)')");
    await clickText(".target-switch button", "Codex");
    await cdp.waitFor("document.querySelector('.model-row.is-codex') && document.querySelector('.delete-provider-button')");
    await cdp.evaluate("document.querySelector('.delete-provider-button').click()");
    await cdp.waitFor("document.querySelector('.provider-delete-dialog')");
    // The delete dialog matches Pi: a trash-icon heading and a danger-button.
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.provider-delete-dialog .delete-dialog-icon'))"), true);
    const button = await cdp.evaluate("(() => { const b = document.querySelector('.provider-delete-dialog .danger-button'); return { disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled') }; })()");
    // Blocked, but focusable: not the disabled attribute, aria-disabled instead.
    assert.deepEqual(button, { disabled: false, ariaDisabled: "true" });
    // Activating it explains the block; it sends no request and leaves config.toml alone.
    await cdp.evaluate("document.querySelector('.provider-delete-dialog .danger-button').click()");
    await cdp.waitFor("document.querySelector('.provider-delete-dialog .error-banner')");
    assert.match(await cdp.evaluate("document.querySelector('.provider-delete-dialog .error-banner').textContent"), /没有别的供应商可以接替|先取消并添加/);
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.provider-delete-dialog'))"), true);
    assert.equal(fs.readFileSync(configPath, "utf8"), soleProvider);
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(codexDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the Codex settings screen carries the shared manager card", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-mgr-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-mgr-codex-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-mgr-"));
  writeFixture(agentDir);
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nname = "现成的供应商"\nbase_url = "https://existing.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: codexDir, PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    // Pi settings carry the manager card.
    await cdp.waitFor("document.querySelector('.nav-settings:not(:disabled)')");
    await cdp.evaluate("document.querySelector('.nav-settings').click()");
    await cdp.waitFor("document.querySelector('.manager-card')");
    await cdp.evaluate("document.querySelector('.settings-title .secondary-button').click()");
    await cdp.waitFor("document.querySelector('.stepper')");
    // Switch to Codex and open its settings — the same manager card is there.
    await clickText(".target-switch button", "Codex");
    await cdp.waitFor("document.querySelector('.model-row.is-codex')");
    await cdp.evaluate("document.querySelector('.nav-settings').click()");
    await cdp.waitFor("document.querySelector('.manager-card')");
    const managerCard = await cdp.evaluate("(() => { const card = document.querySelector('.manager-card'); return { hasManagerVersion: [...card.querySelectorAll('dt')].some((t) => t.textContent === '管理器版本'), hasCheck: [...card.querySelectorAll('button')].some((b) => b.textContent.includes('检查更新')), hasRestart: Boolean(card.querySelector('.restart-button')) }; })()");
    assert.deepEqual(managerCard, { hasManagerVersion: true, hasCheck: true, hasRestart: true });
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(codexDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("CJK text renders at 12px or larger in both themes", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-cjk-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-cjk-"));
  writeFixture(agentDir);
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: isolatedCodexDir(agentDir), PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const cjkTooSmall = () => cdp.evaluate("(() => { const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const cjk = /[\\u4e00-\\u9fff\\u3400-\\u4dbf]/; const bad = []; let node; while ((node = walker.nextNode())) { const text = node.nodeValue.trim(); if (!text || !cjk.test(text)) continue; const el = node.parentElement; if (!el) continue; const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) continue; const size = parseFloat(getComputedStyle(el).fontSize); if (size < 12) bad.push({ text: text.slice(0, 24), size, cls: (el.className && el.className.baseVal) || el.className || el.tagName }); } return bad; })()");
    const auditBoth = async (label) => {
      const light = await cjkTooSmall();
      assert.deepEqual(light, [], label + " (light): " + JSON.stringify(light));
      await cdp.evaluate("(() => { localStorage.setItem('ppm-theme', 'dark'); document.documentElement.dataset.theme = 'dark'; })()");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const dark = await cjkTooSmall();
      assert.deepEqual(dark, [], label + " (dark): " + JSON.stringify(dark));
      await cdp.evaluate("(() => { localStorage.setItem('ppm-theme', 'light'); document.documentElement.dataset.theme = 'light'; })()");
    };
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3 && document.querySelector('.provider-badge')");
    await auditBoth("wizard step 3");
    // Advanced panel surfaces disclaimers and per-model annotations.
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("document.querySelector('.advanced-panel').open");
    await auditBoth("advanced open");
    // Settings, including the shared manager card.
    await cdp.evaluate("document.querySelector('.nav-settings').click()");
    await cdp.waitFor("document.querySelector('.manager-card')");
    await auditBoth("settings");
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the Codex context-window field is bounded and the API key can be revealed", { timeout: 90_000 }, async () => {
  requireFreshBuiltUi();
  const chromePath = findChrome();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-bounds-pi-"));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-ui-bounds-codex-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-chrome-bounds-"));
  writeFixture(agentDir);
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nname = "现成的供应商"\nbase_url = "https://existing.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n');
  const [appPort, debugPort] = await Promise.all([freePort(), freePort()]);
  let server; let chrome; let cdp; let serverOutput = "";
  try {
    server = spawn(process.execPath, [path.join(projectRoot, "server.mjs")], { cwd: projectRoot, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER_MANAGER_CODEX_DIR: codexDir, PI_PROVIDER_MANAGER_SERVE_UI: "1", PI_PROVIDER_MANAGER_PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    await waitForUrl("http://127.0.0.1:" + appPort + "/api/state");
    chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=" + debugPort, "--user-data-dir=" + profileDir, "about:blank"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    await waitForUrl("http://127.0.0.1:" + debugPort + "/json/version", 30_000);
    const target = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent("http://127.0.0.1:" + appPort), { method: "PUT" }).then((response) => response.json());
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + appPort });
    const clickText = (selector, text) => cdp.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find((node) => node.textContent.includes(" + JSON.stringify(text) + ")).click()");
    const setValue = (selector, value) => cdp.evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, " + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");

    // #15 — the Pi new-key field can be revealed and re-masked. Wait for the
    // initial /api/state load to finish before opening a new draft: clicking
    // 添加供应商 before the default provider has loaded lets the load effect
    // overwrite the fresh draft and jump back to the models step.
    await cdp.waitFor("document.querySelectorAll('.model-row').length === 3");
    await cdp.evaluate("document.querySelector('.add-provider').click()");
    await cdp.waitFor("document.querySelector('.protocol-grid')");
    await clickText(".wizard-footer .primary-button", "下一步");
    await cdp.waitFor("document.querySelector('.key-input input')");
    await setValue(".key-input input", "sk-visible-check");
    assert.equal(await cdp.evaluate("document.querySelector('.key-input input').type"), "password");
    assert.equal(await cdp.evaluate("document.querySelector('.key-reveal').getAttribute('aria-pressed')"), "false");
    await cdp.evaluate("document.querySelector('.key-reveal').click()");
    assert.equal(await cdp.evaluate("document.querySelector('.key-input input').type"), "text");
    assert.equal(await cdp.evaluate("document.querySelector('.key-reveal').getAttribute('aria-pressed')"), "true");
    assert.equal(await cdp.evaluate("document.querySelector('.key-input input').value"), "sk-visible-check");
    await cdp.evaluate("document.querySelector('.key-reveal').click()");
    assert.equal(await cdp.evaluate("document.querySelector('.key-input input').type"), "password");

    // #14 — the Codex context-window field rejects out-of-range values.
    await clickText(".target-switch button", "Codex");
    // The half-typed Pi draft is dirty, so the leave guard asks; discard it.
    await cdp.waitFor("document.querySelector('.toast-action')");
    await cdp.evaluate("document.querySelector('.toast-action').click()");
    await cdp.waitFor("document.querySelector('.model-row.is-codex')");
    await cdp.evaluate("document.querySelector('.nav-settings').click()");
    await cdp.waitFor("document.querySelector('.manager-card')");
    await cdp.evaluate("document.querySelector('.advanced-panel > summary').click()");
    await cdp.waitFor("document.querySelector('.advanced-panel[open]')");
    const contextSelector = "[...document.querySelectorAll('.advanced-panel input')].find((node) => node.placeholder && node.placeholder.includes('留空'))";
    await cdp.evaluate("(() => { const input = " + contextSelector + "; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '900m'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await cdp.waitFor("(" + contextSelector + ").getAttribute('aria-invalid') === 'true'");
    assert.equal(await cdp.evaluate("document.querySelector('.settings-footer .primary-button').disabled"), true, "an out-of-range context window must block save");
    // A valid value clears the invalid state.
    await cdp.evaluate("(() => { const input = " + contextSelector + "; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '200000'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await cdp.waitFor("(" + contextSelector + ").getAttribute('aria-invalid') === null");
    assert.equal(await cdp.evaluate("document.querySelector('.settings-footer .primary-button').disabled"), false);
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); cdp.close(); }
    await stopProcess(chrome, true); await stopProcess(server);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(codexDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
