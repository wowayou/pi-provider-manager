import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CdpClient, findChrome, freePort, stopProcess, waitForUrl } from "./helpers/browser.mjs";

// Serve the publishable directory at the repository sub-path. There is no
// manager process behind it. An unexpected request fails before it is sent.
const output = fileURLToPath(new URL("../artifacts/showcase/", import.meta.url));
const prefix = "/pi-provider-manager/";
const mime = { ".html": "text/html", ".png": "image/png", ".css": "text/css", ".js": "text/javascript" };

test("static showcase ships only UI assets and switches all targets offline", { timeout: 60_000 }, async () => {
  assert.deepEqual(fs.readdirSync(output).sort(), ["assets", "favicon.png", "index.html"]);
  const assets = fs.readdirSync(path.join(output, "assets"));
  for (const name of assets) assert.match(name, /^(?:index|vendor-icons|target-(?:claude|codex|prompts))-[\w-]+\.(?:css|js)$/);
  const allowed = new Set(["index.html", "favicon.png", ...assets.map(name => `assets/${name}`)]);
  const errors = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = url.pathname.slice(prefix.length) || "index.html";
    if (req.method !== "GET" || !url.pathname.startsWith(prefix) || !allowed.has(file)) {
      errors.push(req.url); res.writeHead(404).end(); return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] });
    res.end(fs.readFileSync(path.join(output, file)));
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-showcase-"));
  let chrome, cdp;
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}${prefix}`;
    const port = await freePort();
    chrome = spawn(findChrome(), ["--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    await waitForUrl(`http://127.0.0.1:${port}/json/version`);
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = await CdpClient.connect(tab.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    cdp.on(({ method, params }) => {
      if (method !== "Fetch.requestPaused") return;
      const { request, resourceType, requestId } = params;
      const permitted = request.method === "GET" && request.url.startsWith(base)
        && ["Document", "Stylesheet", "Script", "Image", "Other"].includes(resourceType);
      if (!permitted) errors.push(`${resourceType} ${request.url}`);
      cdp.send(permitted ? "Fetch.continueRequest" : "Fetch.failRequest", permitted
        ? { requestId } : { requestId, errorReason: "BlockedByClient" }).catch(e => errors.push(e.message));
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.blockedConnections = []; document.addEventListener('securitypolicyviolation', event => window.blockedConnections.push(event.violatedDirective));` });
    await cdp.send("Page.navigate", { url: `${base}?demo=0` });
    await cdp.waitFor("document.querySelector('.showcase-notice')");
    assert.match(await cdp.evaluate(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`), /connect-src 'none'/);
    const target = name => cdp.evaluate(`[...document.querySelectorAll('.target-switch button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
    const row = id => `[...document.querySelectorAll('.provider-item')].find(r => r.querySelector('.provider-select').title.split(' · ')[1] === ${JSON.stringify(id)})`;
    const cases = [["Pi", "deepseek", "any-claude", "默认"], ["Codex", "kimi", "packy", "生效中"], ["Claude Code", "claude-backup", "claude-gateway", "全局默认"]];
    for (const [name, standby, , badge] of cases) {
      await target(name);
      await cdp.evaluate(`${row(standby)}.querySelector('.provider-activate').click()`);
      if (name === "Pi") await cdp.evaluate(`document.querySelector('.set-default-dialog .primary-button').click()`);
      await cdp.waitFor(`${row(standby)}.querySelector('.provider-badge').textContent === ${JSON.stringify(badge)} && !document.querySelector('.workspace-lock:disabled')`);
    }
    assert.deepEqual(await cdp.evaluate('window.blockedConnections'), []);
    await cdp.send("Page.reload");
    await cdp.waitFor("document.querySelector('.target-switch [aria-checked=true]')?.textContent === 'Pi'");
    for (const [name, , original, badge] of cases) {
      await target(name);
      await cdp.waitFor(`${row(original)}.querySelector('.provider-badge').textContent === ${JSON.stringify(badge)}`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(cdp.errors, []);
  } finally {
    cdp?.close(); await stopProcess(chrome);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
