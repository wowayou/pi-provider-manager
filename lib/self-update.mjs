// Finding out that a newer release exists, and getting it onto disk. Applying it
// to the running process is a separate act with its own guarantees — see the
// restart handover in server.mjs — and keeping the two apart is deliberate: this
// file can leave the checkout upgraded and the manager still serving the version
// it started with, which is a state the panel can describe and a person can act on.
//
// Two rules shape everything here. Nothing reaches the network unless someone
// asked: startup, builds and page loads make no upstream request, and a check is
// a POST because it has an effect outside this machine. And nothing overwrites a
// directory the manager is running out of — an archive install is extended with a
// sibling, never replaced under its own feet.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Long enough for `npm ci` on a cold cache, which is the slowest thing here by an
// order of magnitude.
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;

export async function runStep(command, args, { cwd, timeout = STEP_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: stderr || "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
      code: typeof error.code === "number" ? error.code : null,
    };
  }
}

// The repository has one home — the manifest — for the same reason the validated
// Pi version does: a second copy in code is a second thing to keep in step.
export function repositorySlug(manifest) {
  const url = manifest?.repository?.url || "";
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  return match ? `${match[1]}/${match[2]}` : "";
}

// Compares release numbers, not strings: 0.3.10 is newer than 0.3.9, which every
// lexical comparison gets backwards.
export function compareVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/, "").split(/[.-]/).map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isInteger(number) ? number : 0;
  });
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export async function latestRelease({ slug, version, fetchJson = defaultFetchJson }) {
  if (!slug) throw new Error("package.json 没有记录 GitHub 仓库地址，无法检查更新。");
  const release = await fetchJson(`https://api.github.com/repos/${slug}/releases/latest`, version);
  const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
  if (!tag) throw new Error("GitHub 没有返回可用的发布信息。");
  return {
    tag,
    version: tag.replace(/^v/, ""),
    url: typeof release.html_url === "string" ? release.html_url : "",
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
    assets: Array.isArray(release.assets)
      ? release.assets
        .filter((asset) => typeof asset?.name === "string" && typeof asset?.browser_download_url === "string")
        .map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 }))
      : [],
  };
}

async function defaultFetchJson(url, version) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      // The REST API refuses requests without one, and naming the program is the
      // honest thing to send anyway.
      "user-agent": `pi-provider-manager-ui/${version || "unknown"}`,
    },
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub 拒绝了这次请求（可能是匿名调用的频率限制）。稍后再试。");
  }
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}。`);
  return response.json();
}

// What kind of install this is, and whether it can be upgraded in place. A git
// checkout can fast-forward; an archive cannot, and saying so is more useful than
// attempting something that would half-work.
export async function describeInstall({ projectDir, run = runStep } = {}) {
  const git = (...args) => run("git", ["-C", projectDir, ...args]);
  const inside = await git("rev-parse", "--is-inside-work-tree");
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { kind: "archive", canApply: false, reason: "这不是一个 git checkout，只能换一份新的发布归档。" };
  }
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
  const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  const status = await git("status", "--porcelain");
  const dirty = status.ok ? status.stdout.trim() !== "" : true;
  const install = {
    kind: "checkout",
    branch,
    upstream: upstream.ok ? upstream.stdout.trim() : "",
    dirty,
    canApply: false,
    reason: "",
  };
  if (!install.upstream) {
    install.reason = `分支 ${branch || "HEAD"} 没有对应的远端分支，拉取要指定来源。`;
    return install;
  }
  if (dirty) {
    // Named rather than counted: someone looking at this line wants to know which
    // file is in the way, and `git status` is one command away regardless.
    install.reason = "工作区有未提交的改动，拉取前请先提交或收起它们。";
    // Split without trimming the blob: porcelain's first two columns are the
    // status itself, and a leading space is " M" — modified, not staged.
    install.dirtyFiles = status.stdout.split("\n").filter((line) => line.trim() !== "").slice(0, 8);
    return install;
  }
  install.canApply = true;
  return install;
}

// Runs the upgrade as a sequence that stops at the first failure, and reports every
// step either way. The build is last on purpose: a source tree that is newer than
// its bundle is exactly the mismatch the test helper exists to catch, so a failed
// build must not be followed by a restart.
export async function applyCheckout({ projectDir, run = runStep, onStep = () => {} } = {}) {
  const steps = [];
  const record = async (name, command, args, options) => {
    const started = Date.now();
    onStep({ name, state: "running" });
    const result = await run(command, args, { cwd: projectDir, ...options });
    const step = {
      name,
      command: [command, ...args].join(" "),
      ok: result.ok,
      ms: Date.now() - started,
      // Tails only: a full `npm ci` transcript is thousands of lines, and the last
      // of them is where the reason is.
      output: tail(`${result.stdout || ""}${result.stderr || ""}`),
    };
    steps.push(step);
    onStep({ ...step, state: result.ok ? "done" : "failed" });
    return result;
  };

  const before = (await run("git", ["-C", projectDir, "rev-parse", "HEAD"])).stdout.trim();

  const fetched = await record("拉取远端提交", "git", ["-C", projectDir, "fetch", "--tags", "--prune"]);
  if (!fetched.ok) return { ok: false, steps, failed: "拉取远端提交" };

  const merged = await record("快进到远端版本", "git", ["-C", projectDir, "merge", "--ff-only", "@{upstream}"]);
  if (!merged.ok) {
    // git's own account of this is three lines of hints about merge and rebase,
    // which is advice for a different situation. Say what is in the way instead,
    // and count it after the fetch: before it, a commit already pushed from
    // somewhere else would read as local.
    const ahead = await run("git", ["-C", projectDir, "rev-list", "--count", "@{upstream}..HEAD"], { cwd: projectDir });
    const count = Number.parseInt(String(ahead.stdout || "").trim(), 10);
    if (Number.isInteger(count) && count > 0) {
      const last = steps[steps.length - 1];
      last.output = `本地有 ${count} 个远端没有的提交，无法快进。先把它们推送或收起，再升级。\n${last.output}`;
      onStep({ ...last, state: "failed" });
    }
    return { ok: false, steps, failed: "快进到远端版本" };
  }

  const after = (await run("git", ["-C", projectDir, "rev-parse", "HEAD"])).stdout.trim();
  if (before && after && before === after) {
    return { ok: true, steps, unchanged: true, head: after };
  }

  // Only when the lockfile actually moved: `npm ci` deletes and reinstalls
  // node_modules, which is the slowest and most disruptive thing this can do.
  const changed = await run("git", ["-C", projectDir, "diff", "--name-only", before, after]);
  const touchedDependencies = /(^|\n)(package-lock\.json|package\.json)(\n|$)/.test(changed.stdout || "");
  if (touchedDependencies) {
    const installed = await record("安装依赖", "npm", ["ci", "--ignore-scripts"]);
    if (!installed.ok) return { ok: false, steps, failed: "安装依赖", head: after };
  }

  const built = await record("构建界面", "npm", ["run", "build"]);
  if (!built.ok) return { ok: false, steps, failed: "构建界面", head: after };

  return { ok: true, steps, head: after, dependenciesReinstalled: touchedDependencies };
}

function tail(text, lines = 12) {
  const trimmed = String(text).replace(/\s+$/, "");
  if (!trimmed) return "";
  const all = trimmed.split("\n");
  return all.slice(-lines).join("\n");
}

// Whether an upgrade may be attempted, as a sentence to show rather than a boolean
// to interpret. Kept here beside the rest of the update policy, and away from the
// route, so every case can be stated without a server or a network.
//
// The asymmetry is deliberate. A checkout can be behind its upstream while the
// release number is unchanged — commits land after a release bump — and pulling
// those is exactly what it should still do. An archive install has nothing but the
// release, so fetching the one it is already running would leave a redundant copy
// of itself in the next directory along.
export function applyRefusal({ install, newer, latestVersion, appVersion } = {}) {
  if (!install) return "先检查更新。";
  if (install.kind === "checkout") {
    return install.canApply ? "" : (install.reason || "当前 checkout 不能自动升级。");
  }
  if (!newer) return `已经是最新发布的版本了（${latestVersion || appVersion || "unknown"}）。`;
  return "";
}

// The archive an install of this shape should get: one file per platform, named by
// what it runs on rather than by an index into the list.
export function assetFor(release, platform = process.platform) {
  const wanted = platform === "win32" ? "-windows.zip" : "-linux-wsl.tar.gz";
  return release.assets.find((asset) => asset?.name && asset.name.endsWith(wanted) && !asset.name.includes("/") && !asset.name.includes("\\") && !asset.name.includes("..") && !asset.name.includes("\0")) || null;
}

function assertArchiveTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("归档包含符号链接，已拒绝安装。");
    if (entry.isDirectory()) assertArchiveTree(entryPath);
    else if (!entry.isFile()) throw new Error("归档包含非常规文件，已拒绝安装。");
  }
}

// Downloads a release archive and unpacks it *beside* the current install, never
// over it: the directory this process is running out of is the one thing an
// upgrade must not rewrite. What comes back is a path and the command to run — the
// swap stays a decision someone makes, with the old version still there to go back
// to. Refuses an existing destination rather than merging into it.
export async function downloadArchive({
  release,
  projectDir,
  platform = process.platform,
  run = runStep,
  fetchBinary = defaultFetchBinary,
} = {}) {
  const tag = String(release?.tag || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) throw new Error("发布版本号不安全，已拒绝下载。");
  const asset = assetFor(release, platform);
  if (!asset) throw new Error(`这个发布里没有适用于 ${platform} 的归档。`);
  const parent = path.dirname(path.resolve(projectDir));
  const destination = path.join(parent, `pi-provider-manager-${release.tag}`);
  if (fs.existsSync(destination)) {
    throw new Error(`目标目录已存在：${destination}。请先移走或删除它。`);
  }

  const archivePath = path.join(parent, asset.name);
  if (fs.existsSync(archivePath)) throw new Error(`已经有一个同名文件：${archivePath}。`);
  if (!Number.isFinite(asset.size) || (asset.size > 0 && asset.size > MAX_ARCHIVE_BYTES)) throw new Error("发布归档超过 64 MiB 安全上限。");
  const checksumAsset = release.assets.find((candidate) => candidate?.name === asset.name + ".sha256");
  if (!checksumAsset) throw new Error("发布缺少 " + asset.name + ".sha256，无法验证下载完整性。");
  const archive = Buffer.from(await fetchBinary(asset.url, MAX_ARCHIVE_BYTES));
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("发布归档超过 64 MiB 安全上限。");
  const checksum = Buffer.from(await fetchBinary(checksumAsset.browser_download_url || checksumAsset.url, MAX_CHECKSUM_BYTES));
  if (checksum.length > MAX_CHECKSUM_BYTES) throw new Error("发布里的 SHA-256 文件过大。");
  const checksumParts = checksum.toString("utf8").trim().split(/\s+/);
  if (checksumParts.length < 2 || !/^[a-fA-F0-9]{64}$/.test(checksumParts[0]) || checksumParts[1].replace(/^\*/, "") !== asset.name) throw new Error("发布归档的 SHA-256 文件无效。");
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== checksumParts[0].toLowerCase()) throw new Error("发布归档的 SHA-256 校验失败，未写入磁盘。");
  let staging = "";
  try {
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    staging = fs.mkdtempSync(path.join(parent, ".pi-provider-manager-update-"));
    const listed = platform === "win32"
      ? await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('" + archivePath.replace(/'/g, "''") + "'); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }",
      ])
      : await run("tar", ["-tzf", archivePath]);
    if (!listed.ok) throw new Error("无法检查归档目录。");
    const rootPrefix = "pi-provider-manager-" + tag + "/";
    const entries = String(listed.stdout || "").split(/\r?\n/).filter(Boolean);
    if (entries.length === 0) throw new Error("归档目录为空，已拒绝解包。");
    for (const entry of entries) {
      const normalized = entry.replace(/\\/g, "/");
      if (!normalized.startsWith(rootPrefix) || normalized.includes("/../") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error("归档包含目标目录之外的路径，已拒绝解包。");
    }
    const extracted = platform === "win32"
      // Expand-Archive is present on any supported Windows; -LiteralPath keeps a
      // bracket or a backtick in the path from being read as a pattern.
      ? await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${staging.replace(/'/g, "''")}' -Force`,
      ])
      : await run("tar", ["-xzf", archivePath, "-C", staging]);
    if (!extracted.ok) throw new Error(`解包失败：${tail(extracted.stderr || extracted.stdout, 4) || "未知错误"}`);

    // The archive names its own directory by version; confirm it is the one this
    // release claims, and that it carries the two things a launcher needs. A
    // directory that fails this is cleared away: the destination was proven absent
    // before the download, so everything at that path came from this extraction —
    // and leaving half of it there would make the next attempt refuse the path it
    // just created.
    const unpacked = path.join(staging, "pi-provider-manager-" + tag);
    for (const entry of ["server.mjs", path.join("dist", "client", "index.html")]) {
      if (!fs.existsSync(path.join(unpacked, entry))) {
        try {
          fs.rmSync(unpacked, { recursive: true, force: true });
        } catch {}
        throw new Error(`解开的归档里没有 ${entry}，没有动当前安装。`);
      }
    }
    assertArchiveTree(unpacked);
    fs.renameSync(unpacked, destination);
    return {
      directory: destination,
      asset: asset.name,
      launcher: path.join(
        destination,
        "bin",
        platform === "win32" ? "pi-provider-manager.ps1" : "pi-provider-manager-ui",
      ),
    };
  } finally {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
    // The archive itself is not something to leave lying next to an install.
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {}
  }
}

async function defaultFetchBinary(url, maxBytes = MAX_ARCHIVE_BYTES) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error("下载失败：HTTP " + response.status + "。");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("下载内容超过安全上限。");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("下载内容超过安全上限。");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}
