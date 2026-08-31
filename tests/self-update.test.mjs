import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyCheckout,
  applyRefusal,
  assetFor,
  compareVersions,
  describeInstall,
  downloadArchive,
  latestRelease,
  repositorySlug,
} from "../lib/self-update.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = [];
after(() => {
  for (const entry of temporary) fs.rmSync(entry, { recursive: true, force: true });
});

function temporaryDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

// Records what it was asked to run and answers from a table, so a test says which
// commands an upgrade is allowed to run rather than trusting it not to run others.
function fakeRunner(answers = {}) {
  const calls = [];
  const run = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    for (const [pattern, answer] of Object.entries(answers)) {
      if (line.includes(pattern)) return { ok: true, stdout: "", stderr: "", ...answer };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return { calls, run };
}

test("reads the repository from the manifest rather than carrying a copy", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(repositorySlug(manifest), "wowayou/pi-provider-manager");
  assert.equal(repositorySlug({ repository: { url: "git@github.com:owner/repo.git" } }), "owner/repo");
  assert.equal(repositorySlug({}), "");
});

test("orders releases by number, not by string", () => {
  assert.equal(compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersions("v0.4.0", "0.3.99"), 1);
  assert.equal(compareVersions("0.3.5", "0.3.5"), 0);
  assert.equal(compareVersions("0.3.5", "0.3.6"), -1);
});

test("reads a release, and says so plainly when GitHub will not answer", async () => {
  const release = await latestRelease({
    slug: "owner/repo",
    version: "0.3.6",
    fetchJson: async (url, version) => {
      assert.equal(url, "https://api.github.com/repos/owner/repo/releases/latest");
      assert.equal(version, "0.3.6");
      return {
        tag_name: "v0.3.7",
        html_url: "https://example.invalid/releases/v0.3.7",
        published_at: "2026-08-26T00:00:00Z",
        assets: [
          { name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz", browser_download_url: "https://example.invalid/a.tar.gz", size: 12 },
          { name: "pi-provider-manager-v0.3.7-windows.zip", browser_download_url: "https://example.invalid/a.zip", size: 13 },
          { name: "not-a-download" },
        ],
      };
    },
  });
  assert.equal(release.version, "0.3.7");
  assert.equal(release.tag, "v0.3.7");
  // The entry with no download url is not an asset anyone can be pointed at.
  assert.deepEqual(release.assets.map((asset) => asset.name), [
    "pi-provider-manager-v0.3.7-linux-wsl.tar.gz",
    "pi-provider-manager-v0.3.7-windows.zip",
  ]);

  await assert.rejects(
    () => latestRelease({ slug: "owner/repo", fetchJson: async () => ({}) }),
    /没有返回可用的发布信息/,
  );
  await assert.rejects(() => latestRelease({ slug: "", fetchJson: async () => ({}) }), /没有记录 GitHub 仓库地址/);
});

test("picks the archive for the platform it is running on", () => {
  const release = {
    assets: [
      { name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz", url: "tar" },
      { name: "pi-provider-manager-v0.3.7-windows.zip", url: "zip" },
    ],
  };
  assert.equal(assetFor(release, "linux").url, "tar");
  assert.equal(assetFor(release, "win32").url, "zip");
  assert.equal(assetFor({ assets: [] }, "linux"), null);
});

test("an install that cannot fast-forward says which of the three reasons applies", async () => {
  const notARepository = await describeInstall({
    projectDir: "/nowhere",
    run: fakeRunner({ "rev-parse --is-inside-work-tree": { ok: false, stdout: "" } }).run,
  });
  assert.equal(notARepository.kind, "archive");
  assert.equal(notARepository.canApply, false);
  assert.match(notARepository.reason, /不是一个 git checkout/);

  const noUpstream = await describeInstall({
    projectDir: "/repo",
    run: fakeRunner({
      "rev-parse --is-inside-work-tree": { stdout: "true\n" },
      "--abbrev-ref HEAD": { stdout: "wip\n" },
      "@{upstream}": { ok: false, stderr: "no upstream" },
    }).run,
  });
  assert.equal(noUpstream.canApply, false);
  assert.match(noUpstream.reason, /没有对应的远端分支/);

  const dirty = await describeInstall({
    projectDir: "/repo",
    run: fakeRunner({
      "rev-parse --is-inside-work-tree": { stdout: "true\n" },
      "--abbrev-ref HEAD": { stdout: "main\n" },
      "@{upstream}": { stdout: "origin/main\n" },
      "status --porcelain": { stdout: " M server.mjs\n?? scratch.txt\n" },
    }).run,
  });
  assert.equal(dirty.canApply, false);
  assert.equal(dirty.dirty, true);
  assert.deepEqual(dirty.dirtyFiles, [" M server.mjs", "?? scratch.txt"]);

  const ready = await describeInstall({
    projectDir: "/repo",
    run: fakeRunner({
      "rev-parse --is-inside-work-tree": { stdout: "true\n" },
      "--abbrev-ref HEAD": { stdout: "main\n" },
      "@{upstream}": { stdout: "origin/main\n" },
      "status --porcelain": { stdout: "\n" },
    }).run,
  });
  assert.deepEqual(
    { kind: ready.kind, branch: ready.branch, upstream: ready.upstream, dirty: ready.dirty, canApply: ready.canApply },
    { kind: "checkout", branch: "main", upstream: "origin/main", dirty: false, canApply: true },
  );
});

test("an upgrade fetches, fast-forwards, and only reinstalls when the lockfile moved", async () => {
  let head = "aaa";
  const runner = fakeRunner({
    "diff --name-only": { stdout: "server.mjs\nsrc/App.jsx\n" },
  });
  const run = async (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.includes("rev-parse HEAD")) {
      const answer = { ok: true, stdout: `${head}\n`, stderr: "" };
      runner.calls.push(line);
      // The merge is what moves it; recording the value before and after is how
      // "nothing changed" is told apart from "upgraded".
      return answer;
    }
    if (line.includes("merge --ff-only")) head = "bbb";
    return runner.run(command, args);
  };

  const applied = await applyCheckout({ projectDir: "/repo", run });
  assert.equal(applied.ok, true);
  assert.equal(applied.head, "bbb");
  assert.equal(applied.dependenciesReinstalled, false);
  assert.deepEqual(applied.steps.map((step) => step.name), ["拉取远端提交", "快进到远端版本", "构建界面"]);
  assert.equal(runner.calls.some((line) => line.includes("npm ci")), false, runner.calls.join("\n"));
});

test("a lockfile change is what earns an npm ci", async () => {
  let head = "aaa";
  const runner = fakeRunner({
    "diff --name-only": { stdout: "package-lock.json\npackage.json\n" },
  });
  const run = async (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.includes("rev-parse HEAD")) {
      runner.calls.push(line);
      return { ok: true, stdout: `${head}\n`, stderr: "" };
    }
    if (line.includes("merge --ff-only")) head = "bbb";
    return runner.run(command, args);
  };
  const applied = await applyCheckout({ projectDir: "/repo", run });
  assert.equal(applied.ok, true);
  assert.equal(applied.dependenciesReinstalled, true);
  assert.deepEqual(applied.steps.map((step) => step.name), ["拉取远端提交", "快进到远端版本", "安装依赖", "构建界面"]);
});

test("a failed step stops the sequence, and the build is never skipped past", async () => {
  let head = "aaa";
  const run = async (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.includes("rev-parse HEAD")) return { ok: true, stdout: `${head}\n` };
    if (line.includes("merge --ff-only")) {
      head = "bbb";
      return { ok: false, stderr: "fatal: Not possible to fast-forward" };
    }
    return { ok: true, stdout: "" };
  };
  const seen = [];
  const applied = await applyCheckout({ projectDir: "/repo", run, onStep: (step) => seen.push(`${step.name}:${step.state}`) });
  assert.equal(applied.ok, false);
  assert.equal(applied.failed, "快进到远端版本");
  // Nothing was built on top of a merge that did not happen.
  assert.deepEqual(applied.steps.map((step) => step.name), ["拉取远端提交", "快进到远端版本"]);
  assert.match(applied.steps[1].output, /Not possible to fast-forward/);
  assert.deepEqual(seen, [
    "拉取远端提交:running",
    "拉取远端提交:done",
    "快进到远端版本:running",
    "快进到远端版本:failed",
  ]);
});

test("a fast-forward blocked by local commits names them, rather than quoting git's advice", async () => {
  const run = async (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.includes("rev-parse HEAD")) return { ok: true, stdout: "aaa\n" };
    if (line.includes("merge --ff-only")) {
      return {
        ok: false,
        stderr: "hint: Diverging branches can't be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.",
      };
    }
    // Counted after the fetch, so the remote-tracking ref is current.
    if (line.includes("rev-list --count")) return { ok: true, stdout: "2\n" };
    return { ok: true, stdout: "" };
  };
  const applied = await applyCheckout({ projectDir: "/repo", run });
  assert.equal(applied.ok, false);
  assert.equal(applied.failed, "快进到远端版本");
  const step = applied.steps[applied.steps.length - 1];
  assert.match(step.output, /本地有 2 个远端没有的提交/);
  // git's own words are kept underneath: they are the authoritative failure.
  assert.match(step.output, /Not possible to fast-forward/);
});

test("a fast-forward that fails with nothing local ahead is left as git reported it", async () => {
  const run = async (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.includes("rev-parse HEAD")) return { ok: true, stdout: "aaa\n" };
    if (line.includes("merge --ff-only")) return { ok: false, stderr: "fatal: refusing to merge unrelated histories" };
    if (line.includes("rev-list --count")) return { ok: true, stdout: "0\n" };
    return { ok: true, stdout: "" };
  };
  const applied = await applyCheckout({ projectDir: "/repo", run });
  assert.equal(applied.ok, false);
  const step = applied.steps[applied.steps.length - 1];
  assert.equal(step.output.startsWith("本地有"), false, step.output);
  assert.match(step.output, /unrelated histories/);
});

test("an upgrade that is already applied says so instead of rebuilding", async () => {
  const run = async (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.includes("rev-parse HEAD")) return { ok: true, stdout: "same\n" };
    return { ok: true, stdout: "" };
  };
  const applied = await applyCheckout({ projectDir: "/repo", run });
  assert.equal(applied.ok, true);
  assert.equal(applied.unchanged, true);
  assert.equal(applied.steps.some((step) => step.name === "构建界面"), false);
});

test("an archive is unpacked beside the install, never over it", async () => {
  const archive1 = Buffer.from("not really a tarball");
  const parent = temporaryDir("ppm-sibling-");
  const projectDir = path.join(parent, "pi-provider-manager-v0.3.6");
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, "server.mjs"), "// the running install\n");
  const release = {
    tag: "v0.3.7",
    assets: [{ name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz", url: "https://example.invalid/a.tar.gz", size: 20 }, { name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz.sha256", url: "https://example.invalid/a.sha256", size: 100 }],
  };

  let downloadedFrom = "";
  const result = await downloadArchive({
    release,
    projectDir,
    platform: "linux",
    fetchBinary: async (url) => {
      if (url.endsWith(".sha256")) return Buffer.from("b3b786ecd6e4f6ab3398d0b1bfd62dbc47534c8723cd3802f642f7203a3b55d7  pi-provider-manager-v0.3.7-linux-wsl.tar.gz\n");
      downloadedFrom = url;
      return archive1;
    },
    // Stands in for tar: the contract under test is what happens around the
    // extraction, so what unpacks it is the one part worth substituting.
    run: async (command, args) => {
      assert.equal(command, "tar");
      if (args[0] === "-tzf") return { ok: true, stdout: "pi-provider-manager-v0.3.7/\npi-provider-manager-v0.3.7/server.mjs\npi-provider-manager-v0.3.7/dist/client/index.html\n" };
      assert.equal(args[0], "-xzf");
      assert.equal(fs.existsSync(args[1]), true, "the archive must exist while it is unpacked");
      const unpacked = path.join(args[3], "pi-provider-manager-v0.3.7", "dist", "client");
      fs.mkdirSync(unpacked, { recursive: true });
      fs.writeFileSync(path.join(unpacked, "index.html"), "<!doctype html>");
      fs.writeFileSync(path.join(args[3], "pi-provider-manager-v0.3.7", "server.mjs"), "// the new one\n");
      return { ok: true, stdout: "" };
    },
  });

  assert.equal(downloadedFrom, "https://example.invalid/a.tar.gz");
  assert.equal(result.directory, path.join(parent, "pi-provider-manager-v0.3.7"));
  assert.equal(result.launcher, path.join(parent, "pi-provider-manager-v0.3.7", "bin", "pi-provider-manager-ui"));
  // The install it was run from is untouched, and the downloaded archive is not
  // left lying beside it.
  assert.equal(fs.readFileSync(path.join(projectDir, "server.mjs"), "utf8"), "// the running install\n");
  assert.equal(fs.existsSync(path.join(parent, "pi-provider-manager-v0.3.7-linux-wsl.tar.gz")), false);
});

test("archive updates reject missing checksums, bad digests, and escaping paths", async () => {
  const parent = temporaryDir("ppm-sibling-guard-");
  const projectDir = path.join(parent, "pi-provider-manager-v0.3.6");
  fs.mkdirSync(projectDir);
  const name = "pi-provider-manager-v0.3.7-linux-wsl.tar.gz";
  const archive = Buffer.from("x");
  const checksum = Buffer.from("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  " + name + "\n");

  await assert.rejects(() => downloadArchive({
    release: { tag: "v0.3.7", assets: [{ name, url: "archive", size: 1 }] },
    projectDir, platform: "linux", fetchBinary: async () => archive,
  }), /缺少.*sha256/);

  const release = { tag: "v0.3.7", assets: [
    { name, url: "archive", size: 1 },
    { name: name + ".sha256", url: "checksum", size: checksum.length },
  ] };
  await assert.rejects(() => downloadArchive({
    release, projectDir, platform: "linux",
    fetchBinary: async (url) => url === "checksum" ? Buffer.from("0".repeat(64) + "  " + name) : archive,
  }), /SHA-256 校验失败/);
  assert.equal(fs.existsSync(path.join(parent, name)), false);

  await assert.rejects(() => downloadArchive({
    release, projectDir, platform: "linux",
    fetchBinary: async (url) => url === "checksum" ? checksum : archive,
    run: async (command, args) => args[0] === "-tzf"
      ? { ok: true, stdout: "pi-provider-manager-v0.3.7/../escaped\n" }
      : { ok: true, stdout: "" },
  }), /目标目录之外/);
  assert.equal(fs.existsSync(path.join(parent, "escaped")), false);
});
test("an archive that is missing what a launcher needs is reported, not left half-installed", async () => {
  const archive2 = Buffer.from("x");
  const parent = temporaryDir("ppm-sibling-bad-");
  const projectDir = path.join(parent, "pi-provider-manager-v0.3.6");
  fs.mkdirSync(projectDir);
  const release = {
    tag: "v0.3.7",
    assets: [{ name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz", url: "https://example.invalid/a.tar.gz", size: 1 }, { name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz.sha256", url: "https://example.invalid/a.sha256", size: 100 }],
  };
  await assert.rejects(
    () => downloadArchive({
      release,
      projectDir,
      platform: "linux",
      fetchBinary: async (url) => url.endsWith(".sha256") ? Buffer.from("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  pi-provider-manager-v0.3.7-linux-wsl.tar.gz\n") : archive2,
      run: async (command, args) => {
        if (args[0] === "-tzf") return { ok: true, stdout: "pi-provider-manager-v0.3.7/\n" };
        fs.mkdirSync(path.join(args[3], "pi-provider-manager-v0.3.7"), { recursive: true });
        return { ok: true, stdout: "" };
      },
    }),
    /没有 server\.mjs，没有动当前安装/,
  );
  assert.equal(fs.existsSync(path.join(parent, "pi-provider-manager-v0.3.7-linux-wsl.tar.gz")), false);
  // And nothing half-unpacked is left to make the next attempt refuse the path.
  assert.equal(fs.existsSync(path.join(parent, "pi-provider-manager-v0.3.7")), false);
});

test("an existing destination is refused rather than merged into", async () => {
  const parent = temporaryDir("ppm-sibling-exists-");
  const projectDir = path.join(parent, "pi-provider-manager-v0.3.6");
  fs.mkdirSync(projectDir);
  fs.mkdirSync(path.join(parent, "pi-provider-manager-v0.3.7"));
  fs.writeFileSync(path.join(parent, "pi-provider-manager-v0.3.7", "mine.txt"), "someone's own files");
  let downloaded = false;
  await assert.rejects(
    () => downloadArchive({
      release: { tag: "v0.3.7", assets: [{ name: "x-linux-wsl.tar.gz", url: "u" }] },
      projectDir,
      platform: "linux",
      fetchBinary: async () => { downloaded = true; return Buffer.from("x"); },
      run: async () => ({ ok: true }),
    }),
    /目标目录已存在/,
  );
  // Refused before anything was fetched: there is no point spending the download.
  assert.equal(downloaded, false);
  assert.equal(fs.readFileSync(path.join(parent, "pi-provider-manager-v0.3.7", "mine.txt"), "utf8"), "someone's own files");
});

test("a platform with no archive in the release is told so", async () => {
  await assert.rejects(
    () => downloadArchive({
      release: { tag: "v0.3.7", assets: [{ name: "only-windows.zip", url: "u" }] },
      projectDir: temporaryDir("ppm-sibling-none-"),
      platform: "linux",
      fetchBinary: async () => Buffer.from("x"),
    }),
    /没有适用于 linux 的归档/,
  );
});

test("a checkout may pull without a version bump; an archive at the latest may not", () => {
  const checkout = (extra) => ({ kind: "checkout", canApply: true, reason: "", ...extra });
  // The case the asymmetry exists for: commits land after a release bump, so a
  // checkout at the current release number can still be behind its upstream.
  assert.equal(applyRefusal({ install: checkout(), newer: false, latestVersion: "0.3.6" }), "");
  assert.equal(applyRefusal({ install: checkout(), newer: true, latestVersion: "0.3.7" }), "");
  assert.match(
    applyRefusal({ install: checkout({ canApply: false, reason: "工作区有未提交的改动。" }), newer: true }),
    /未提交的改动/,
  );
  // A reason is always given, even where the caller did not supply one.
  assert.match(applyRefusal({ install: checkout({ canApply: false, reason: "" }), newer: true }), /不能自动升级/);

  // An archive install has nothing but the release it was unpacked from.
  assert.equal(applyRefusal({ install: { kind: "archive" }, newer: true, latestVersion: "0.3.7" }), "");
  assert.match(
    applyRefusal({ install: { kind: "archive" }, newer: false, latestVersion: "0.3.6" }),
    /已经是最新发布的版本了（0\.3\.6）/,
  );
  // Falls back to the running version when a check has somehow left no latest.
  assert.match(applyRefusal({ install: { kind: "archive" }, newer: false, appVersion: "0.3.6" }), /0\.3\.6/);

  // No check yet is its own answer, not an empty one.
  assert.match(applyRefusal({}), /先检查更新/);
});

test("a download whose connection is cut names the host and the reason", async () => {
  // Windows Node could not reach GitHub's object storage on one machine at all —
  // every attempt reset the TLS socket, while the same download from WSL on the
  // same machine worked — and what reached the panel was `fetch failed`, which
  // names neither the host nor the cause and so reads as a bug in the manager.
  // Staged with a listener that accepts and immediately destroys the socket,
  // which is the same failure: `read ECONNRESET` under a `TypeError`.
  const parent = temporaryDir("ppm-transport-");
  const projectDir = path.join(parent, "pi-provider-manager-v0.3.6");
  fs.mkdirSync(projectDir);
  const server = net.createServer((socket) => socket.destroy());
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const release = {
    tag: "v0.3.7",
    assets: [
      { name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz", url: `http://127.0.0.1:${port}/a.tar.gz`, size: 20 },
      { name: "pi-provider-manager-v0.3.7-linux-wsl.tar.gz.sha256", url: `http://127.0.0.1:${port}/a.sha256`, size: 100 },
    ],
  };
  try {
    // The module's own fetch is the thing under test, so nothing is substituted.
    await assert.rejects(() => downloadArchive({ release, projectDir, platform: "linux" }), (error) => {
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
      // undici reports either the errno or its own wrapper depending on where
      // the reset lands; both are specific enough to act on, and pinning one
      // would make this a test of undici's internals.
      assert.match(error.message, /ECONNRESET|UND_ERR_SOCKET|closed/);
      assert.match(error.message, /代理/);
      assert.equal(/fetch failed/.test(error.message), false);
      return true;
    });
    // Nothing was written on the way to that failure.
    assert.deepEqual(fs.readdirSync(parent), ["pi-provider-manager-v0.3.6"]);
  } finally {
    server.close();
  }
});
