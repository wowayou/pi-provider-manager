// Concurrency guard for a set of files this manager owns together.
//
// Every managed group needs the same three things: a revision that changes when
// any file in the group changes, a read that is stable against a file being
// rewritten underneath it, and an all-or-nothing write. Pi's three JSON files,
// Codex's config plus store, and each agent's prompt files are all the same
// shape, so the machinery lives here once. Separate groups keep separate
// revisions on purpose — editing one must never invalidate a draft for another.

import crypto from "node:crypto";
import path from "node:path";

import { restore, snapshot } from "./atomic-files.mjs";
import { ConflictError } from "./validation.mjs";

export function createFileGuard({ paths, revisionKey, subject }) {
  const managedPaths = [...paths];

  function snapshots() {
    return new Map(managedPaths.map((filePath) => [filePath, snapshot(filePath)]));
  }

  function snapshotsEqual(left, right) {
    for (const filePath of managedPaths) {
      const a = left.get(filePath);
      const b = right.get(filePath);
      if (a === null || b === null) {
        if (a !== b) return false;
      } else if (!a.equals(b)) {
        return false;
      }
    }
    return true;
  }

  // Two identical reads in a row, so a revision is never computed from a group
  // caught halfway through someone else's write.
  function stableSnapshots() {
    let previous = snapshots();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = snapshots();
      if (snapshotsEqual(previous, current)) return current;
      previous = current;
    }
    throw new ConflictError(`${subject}正在被其他程序持续修改，请稍后重新读取。`);
  }

  // Keyed by a per-process secret so a revision cannot be forged from the file
  // contents alone. Length is mixed in as well as the bytes, so two files
  // swapping content cannot collide.
  function revisionOf(files = snapshots()) {
    const hash = crypto.createHmac("sha256", revisionKey);
    for (const filePath of managedPaths) {
      const bytes = files.get(filePath);
      hash.update(path.basename(filePath));
      hash.update(bytes === null ? "\0missing\0" : `\0present:${bytes.length}\0`);
      if (bytes !== null) hash.update(bytes);
    }
    return hash.digest("hex");
  }

  function requireCurrentRevision(payload) {
    const expected = typeof payload.revision === "string" ? payload.revision : "";
    const files = stableSnapshots();
    if (!/^[a-f0-9]{64}$/.test(expected) || expected !== revisionOf(files)) {
      throw new ConflictError(`${subject}已被其他程序或标签页修改。当前草稿尚未写入，请重新读取配置后再试。`);
    }
    return expected;
  }

  // Re-checks the revision immediately before writing, then rolls every file in
  // the group back if any single write fails: a half-applied group is worse
  // than a rejected one.
  function writeAll(revision, write) {
    const originals = stableSnapshots();
    if (revision !== revisionOf(originals)) {
      throw new ConflictError(`${subject}在保存期间发生了变化。当前草稿尚未写入，请重新读取配置后再试。`);
    }
    try {
      write();
    } catch (error) {
      for (const [filePath, bytes] of originals) restore(filePath, bytes);
      throw error;
    }
  }

  return { paths: managedPaths, snapshots, stableSnapshots, revisionOf, requireCurrentRevision, writeAll };
}
