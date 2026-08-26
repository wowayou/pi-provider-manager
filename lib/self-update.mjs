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

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Long enough for `npm ci` on a cold cache, which is the slowest thing here by an
// order of magnitude.
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

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
  if (!merged.ok) return { ok: false, steps, failed: "快进到远端版本" };

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

// The archive an install of this shape should get: one file per platform, named by
// what it runs on rather than by an index into the list.
export function assetFor(release, platform = process.platform) {
  const wanted = platform === "win32" ? "-windows.zip" : "-linux-wsl.tar.gz";
  return release.assets.find((asset) => asset.name.endsWith(wanted)) || null;
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
  const asset = assetFor(release, platform);
  if (!asset) throw new Error(`这个发布里没有适用于 ${platform} 的归档。`);
  const parent = path.dirname(path.resolve(projectDir));
  const destination = path.join(parent, `pi-provider-manager-${release.tag}`);
  if (fs.existsSync(destination)) {
    throw new Error(`目标目录已存在：${destination}。请先移走或删除它。`);
  }

  const archivePath = path.join(parent, asset.name);
  if (fs.existsSync(archivePath)) throw new Error(`已经有一个同名文件：${archivePath}。`);
  fs.writeFileSync(archivePath, await fetchBinary(asset.url), { mode: 0o600 });

  try {
    const extracted = platform === "win32"
      // Expand-Archive is present on any supported Windows; -LiteralPath keeps a
      // bracket or a backtick in the path from being read as a pattern.
      ? await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${parent.replace(/'/g, "''")}' -Force`,
      ])
      : await run("tar", ["-xzf", archivePath, "-C", parent]);
    if (!extracted.ok) throw new Error(`解包失败：${tail(extracted.stderr || extracted.stdout, 4) || "未知错误"}`);

    // The archive names its own directory by version; confirm it is the one this
    // release claims, and that it carries the two things a launcher needs. A
    // directory that fails this is cleared away: the destination was proven absent
    // before the download, so everything at that path came from this extraction —
    // and leaving half of it there would make the next attempt refuse the path it
    // just created.
    const unpacked = path.join(parent, `pi-provider-manager-${release.tag}`);
    for (const entry of ["server.mjs", path.join("dist", "client", "index.html")]) {
      if (!fs.existsSync(path.join(unpacked, entry))) {
        try {
          fs.rmSync(unpacked, { recursive: true, force: true });
        } catch {}
        throw new Error(`解开的归档里没有 ${entry}，没有动当前安装。`);
      }
    }
    return {
      directory: unpacked,
      asset: asset.name,
      launcher: path.join(
        unpacked,
        "bin",
        platform === "win32" ? "pi-provider-manager.ps1" : "pi-provider-manager-ui",
      ),
    };
  } finally {
    // The archive itself is not something to leave lying next to an install.
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {}
  }
}

async function defaultFetchBinary(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}。`);
  return Buffer.from(await response.arrayBuffer());
}
