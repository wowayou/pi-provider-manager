import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { detectCodexVersion, detectPiVersion, liveVersion } from "../lib/version-detect.mjs";

const temporaryHomes = [];
after(() => {
  for (const home of temporaryHomes) fs.rmSync(home, { recursive: true, force: true });
});

// A home directory carrying the Pi installs listed, one per Node version, in the
// layout nvm produces. An empty set of installs is the "nothing installed" case.
function fakeHome(installs = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ppm-home-"));
  temporaryHomes.push(home);
  for (const [nodeVersion, piVersion] of Object.entries(installs)) {
    const dir = path.join(home, ".nvm", "versions", "node", nodeVersion, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: piVersion }));
  }
  return home;
}

// Records every command attempted and refuses to answer. Old package manifests
// must never turn an unavailable command into an apparently installed version.
function refusing() {
  const attempts = [];
  return {
    attempts,
    run(command, ...args) {
      attempts.push([command, ...args.flat()]);
      throw new Error("nothing installed here");
    },
  };
}

// homeDir was the old detector's install-tree input. Keep feeding it here so
// restoring that shortcut fails against a real stale tree, not just a mock.
test("asks the runnable Pi even when an old npm install remains after migration", async () => {
  const home = fakeHome({ "v24.18.0": "1.0.2" });
  const attempts = [];
  const version = await detectPiVersion({
    homeDir: home, platform: "linux",
    run: (command, args) => { attempts.push([command, ...args]); return "1.1.0\n"; },
  });
  assert.equal(version, "1.1.0");
  assert.deepEqual(attempts, [["/bin/bash", "-lic", "pi --version"]]);
});

test("reports the selected Pi rather than the newest inactive npm install", async () => {
  const home = fakeHome({ "v20.11.0": "1.0.2", "v22.14.0": "1.1.0" });
  assert.equal(await detectPiVersion({ homeDir: home, platform: "linux", run: () => "1.0.4" }), "1.0.4");
});

test("does not report a leftover manifest as runnable when both commands fail", async () => {
  const home = fakeHome({ "v24.18.0": "1.0.2" });
  const shell = refusing();
  assert.equal(await detectPiVersion({ homeDir: home, platform: "linux", run: shell.run }), "unknown");
  assert.deepEqual(shell.attempts, [["/bin/bash", "-lic", "pi --version"], ["pi", "--version"]]);
});

test("asks a fresh login shell first when no install tree exists", async () => {
  const home = fakeHome();
  const attempts = [];
  const version = await detectPiVersion({
    homeDir: home,
    platform: "linux",
    run: (command, args) => {
      attempts.push([command, ...args]);
      return "pi 0.84.3 (linux-x64)\n";
    },
  });
  assert.equal(version, "0.84.3");
  assert.deepEqual(attempts, [["/bin/bash", "-lic", "pi --version"]]);
});

test("tries the bare command when the login shell has no pi on its PATH", async () => {
  const home = fakeHome();
  const attempts = [];
  const version = await detectPiVersion({
    homeDir: home,
    platform: "linux",
    run: (command, args) => {
      attempts.push(command);
      if (command === "/bin/bash") throw new Error("command not found");
      return "0.84.3";
    },
  });
  assert.equal(version, "0.84.3");
  assert.deepEqual(attempts, ["/bin/bash", "pi"]);
});

test("reports unknown rather than guessing when nothing answers", async () => {
  const home = fakeHome();
  assert.equal(await detectPiVersion({ homeDir: home, platform: "linux", run: refusing().run }), "unknown");
  assert.equal(await detectCodexVersion({ platform: "linux", run: () => "codex, no version here" }), "unknown");
});

test("tries the bare Pi command when the login shell output contains no version", async () => {
  const attempts = [];
  assert.equal(await detectPiVersion({ platform: "linux", run: (command) => {
    attempts.push(command);
    return command === "/bin/bash" ? "no version" : "1.1.0";
  } }), "1.1.0");
  assert.deepEqual(attempts, ["/bin/bash", "pi"]);
});

test("asks Windows for Pi through the bare command, never through bash or npm manifests", async () => {
  const home = fakeHome({ "v24.18.0": "1.0.2" });
  const attempts = [];
  assert.equal(await detectPiVersion({ homeDir: home, platform: "win32", run: (command, args) => {
    attempts.push([command, ...args]);
    return "1.1.0";
  } }), "1.1.0");
  assert.deepEqual(attempts, [["pi", "--version"]]);
});

test("asks the Codex binary itself, and asks Windows only the bare command", async () => {
  assert.equal(
    await detectCodexVersion({ platform: "linux", run: () => "codex-cli 0.149.0\n" }),
    "0.149.0",
  );
  const attempts = [];
  await detectCodexVersion({
    platform: "win32",
    run: (command, args) => {
      attempts.push([command, ...args]);
      return "0.149.0";
    },
  });
  assert.deepEqual(attempts, [["codex", "--version"]]);
});

test("serves the known version at once and refreshes an aged one behind the reader", async () => {
  let installed = "0.84.2";
  let detections = 0;
  let clock = 1_000;
  const live = liveVersion(
    async () => {
      detections += 1;
      return installed;
    },
    { ttlMs: 10_000, now: () => clock },
  );

  assert.equal(await live.ready(), "0.84.2");
  assert.equal(detections, 1);

  clock += 9_999;
  installed = "0.84.3";
  // Inside the window the answer is reused, so a burst of saves costs no
  // detection at all rather than a login shell each.
  assert.equal(live.get(), "0.84.2");
  assert.equal(detections, 1);

  clock += 1;
  // Past the window the reader still gets an answer immediately — the upgrade
  // lands for the next one. Nothing on the request path waits for a subprocess.
  assert.equal(live.get(), "0.84.2");
  await live.ready();
  assert.equal(detections, 2);
  assert.equal(live.get(), "0.84.3");
});

test("does not stack refreshes when reads arrive while one is running", async () => {
  let detections = 0;
  let release;
  const live = liveVersion(
    () => {
      detections += 1;
      return new Promise((resolve) => { release = () => resolve("0.84.3"); });
    },
    { ttlMs: 10_000, now: () => 0 },
  );

  const first = live.ready();
  assert.equal(live.get(), "unknown");
  assert.equal(live.get(), "unknown");
  assert.equal(detections, 1);
  release();
  assert.equal(await first, "0.84.3");
  assert.equal(live.get(), "0.84.3");
});

test("keeps a failed detection from starting a fresh attempt per read", async () => {
  let detections = 0;
  let clock = 0;
  const live = liveVersion(
    async () => { detections += 1; throw new Error("PATH is broken"); },
    { ttlMs: 10_000, now: () => clock },
  );

  assert.equal(await live.ready(), "unknown");
  assert.equal(live.get(), "unknown");
  assert.equal(live.get(), "unknown");
  assert.equal(detections, 1);

  clock += 10_000;
  live.get();
  await live.ready();
  assert.equal(detections, 2);
});
