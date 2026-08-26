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

// Records every command attempted and refuses to answer, so a test that means
// "the install tree alone answered this" can assert nothing was ever spawned —
// a detector that swallows the refusal must not read as a pass.
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

test("reads the Pi version from the install tree without running anything", async () => {
  const home = fakeHome({ "v24.18.0": "0.84.3" });
  const shell = refusing();
  assert.equal(await detectPiVersion({ homeDir: home, platform: "linux", run: shell.run }), "0.84.3");
  assert.deepEqual(shell.attempts, []);
});

test("prefers the newest Pi when several Node versions carry one", async () => {
  // localeCompare's default collation orders 0.84.10 below 0.84.9; the numeric
  // option is what makes this the newest rather than the longest.
  const home = fakeHome({ "v20.11.0": "0.84.9", "v22.14.0": "0.84.10", "v24.18.0": "0.9.0" });
  assert.equal(await detectPiVersion({ homeDir: home, platform: "linux", run: refusing().run }), "0.84.10");
});

test("ignores an unreadable entry in the install tree instead of failing", async () => {
  const home = fakeHome({ "v24.18.0": "0.84.3" });
  const broken = path.join(home, ".nvm", "versions", "node", "v20.11.0", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, "package.json"), "{ not json");
  assert.equal(await detectPiVersion({ homeDir: home, platform: "linux", run: refusing().run }), "0.84.3");
});

test("falls back to the command, through a login shell first, when no install tree exists", async () => {
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
