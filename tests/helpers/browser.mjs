import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function findChrome() {
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

export function freePort() {
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

export async function waitForUrl(url, timeout = 10_000) {
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

export async function stopProcess(child, processGroup = false) {
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

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
    this.listeners = new Set();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) for (const listener of this.listeners) listener(message);
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

  // Subscribes to CDP events (Fetch.requestPaused and the like); returns the
  // unsubscribe function.
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
