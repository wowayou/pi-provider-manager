// Whether the bundle being served was built from the sources now on disk.
//
// This started as a test helper: the UI suite serves dist/client, which is
// gitignored and so is never updated by a checkout or a pull, and a stale bundle
// fails in the least helpful way available — selectors for elements the current
// source renders are simply absent, so the assertion that trips is unrelated to
// the actual problem.
//
// The upgrade path made it a runtime question too. Pulling gives every changed
// file a current mtime, so between the pull and the build the source tree really is
// newer than the bundle; restarting there would put a new server behind an old
// page, which is the same mismatch with nobody watching for it. One copy of the
// rule, used by both.

import fs from "node:fs";
import path from "node:path";

// What determines the markup and selectors in the bundle. package.json is
// deliberately absent: editing a script or bumping the version does not change the
// bundle, and a guard that cries wolf over an unrelated edit is a guard people
// learn to ignore. A release archive carries none of these, which is exactly right
// — there is nothing there to be out of step with.
const SOURCES = ["src", "index.html", "vite.config.mjs"];

function newestMtime(target) {
  const stats = fs.statSync(target);
  if (!stats.isDirectory()) return stats.mtimeMs;
  return fs.readdirSync(target)
    .map((entry) => newestMtime(path.join(target, entry)))
    .reduce((newest, mtime) => Math.max(newest, mtime), stats.mtimeMs);
}

// Returns null when the built UI is usable, otherwise { kind, message }. The two
// kinds are worth telling apart: a missing bundle can reasonably be treated as an
// unsupported environment, a stale one is a mistake in this checkout.
export function builtUiProblem(projectRoot) {
  const builtIndex = path.join(projectRoot, "dist", "client", "index.html");
  if (!fs.existsSync(builtIndex)) {
    return { kind: "missing", message: "built UI required; run npm run build" };
  }

  const builtAt = newestMtime(builtIndex);
  const stale = SOURCES
    .map((entry) => path.join(projectRoot, entry))
    .filter((entry) => fs.existsSync(entry) && newestMtime(entry) > builtAt);
  if (stale.length === 0) return null;

  const names = stale.map((entry) => path.relative(projectRoot, entry)).join(", ");
  return {
    kind: "stale",
    message: `dist/client is older than ${names}; run npm run build`,
  };
}
