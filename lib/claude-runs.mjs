// Per-run Claude settings snapshots carry a credential. The launcher creates
// one per session and removes it on exit; this module owns the rules for
// finding and removing the ones a forced kill left behind. It is shared by the
// launcher (before each launch) and the manager server (at startup).
import fs from "node:fs";
import path from "node:path";

export const RUNS = "pi-provider-manager-runs";
export const OWNER = "owner.json";
// A session directory without a readable owner record is either being created
// right now or was left by a launcher killed before writing one. Only age can
// tell those apart, so the unowned ones are kept for this long.
const UNOWNED_GRACE_MS = 10 * 60 * 1000;

// True only when the process provably no longer exists. EPERM means it exists
// under another account; anything unexpected is treated as still running.
export function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

// Why a runtime directory must not hold a credential, or "" when it may.
function unsafeReason(runtimeDir, stat) {
  if (!stat.isDirectory()) return `${runtimeDir} 不是普通目录，已拒绝在其中写入凭据快照。`;
  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) return `${runtimeDir} 属于其他用户，已拒绝在其中写入凭据快照。`;
  return "";
}

// The launcher's entry: create the directory if needed, refuse a symlink or a
// directory owned by another account, and tighten its permissions.
export function privateRuntimeDir(dir) {
  const runtimeDir = path.join(dir, RUNS);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(runtimeDir);
  const reason = unsafeReason(runtimeDir, stat);
  if (reason) throw new Error(reason);
  if (process.platform !== "win32" && (stat.mode & 0o077)) fs.chmodSync(runtimeDir, 0o700);
  return runtimeDir;
}

// A forced kill of the launcher (SIGKILL, a crash, Task Manager) skips its own
// cleanup. A session is removed only once both recorded processes are provably
// gone. A reused process id keeps a directory alive longer than needed, never
// the other way round.
export function sweepStaleRuns(runtimeDir, now = Date.now()) {
  const removed = [];
  let entries;
  try { entries = fs.readdirSync(runtimeDir, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const runDir = path.join(runtimeDir, entry.name);
    let stale;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(runDir, OWNER), "utf8"));
      // A launcher killed between spawning Claude and recording its id leaves
      // no claudePid. Claude reads --settings once at startup (measured on
      // 2.1.283), so removing that snapshot cannot redirect a running session.
      stale = processGone(owner.launcherPid) && (owner.claudePid === undefined || processGone(owner.claudePid));
    } catch {
      try { stale = now - fs.statSync(runDir).mtimeMs > UNOWNED_GRACE_MS; } catch { stale = false; }
    }
    if (!stale) continue;
    try { fs.rmSync(runDir, { recursive: true, force: true }); removed.push(entry.name); } catch { /* retried next time */ }
  }
  return removed;
}

// The manager's entry: never create the directory, and leave alone anything
// that is not a private directory of this account rather than follow it.
export function sweepExistingRuns(dir, now = Date.now()) {
  const runtimeDir = path.join(dir, RUNS);
  let stat;
  try { stat = fs.lstatSync(runtimeDir); } catch { return []; }
  if (unsafeReason(runtimeDir, stat)) return [];
  return sweepStaleRuns(runtimeDir, now);
}
