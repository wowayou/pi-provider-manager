// Tests that drive the production UI serve `dist/client`, which is gitignored
// and therefore never updated by a checkout or a pull. A stale bundle fails in
// the least helpful way available: selectors for elements the current source
// renders are simply absent, so the assertion that trips is unrelated to the
// actual problem. Compare the bundle against its sources and say so instead.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const builtIndex = path.join(projectRoot, "dist", "client", "index.html");

// What determines the markup and selectors in the bundle. The bundle is stale if
// any of it is newer. package.json is deliberately absent: editing a script or
// bumping the version does not change the bundle, and a guard that cries wolf
// over an unrelated edit is a guard people learn to ignore.
const sources = ["src", "index.html", "vite.config.mjs"];

function newestMtime(target) {
  const stats = fs.statSync(target);
  if (!stats.isDirectory()) return stats.mtimeMs;
  return fs.readdirSync(target)
    .map((entry) => newestMtime(path.join(target, entry)))
    .reduce((newest, mtime) => Math.max(newest, mtime), stats.mtimeMs);
}

// Returns null when the built UI is usable, otherwise { kind, message }. The
// two kinds are worth telling apart: a missing bundle can reasonably be treated
// as an unsupported environment, a stale one is a mistake in this checkout.
export function builtUiProblem() {
  if (!fs.existsSync(builtIndex)) {
    return { kind: "missing", message: "built UI required; run npm run build" };
  }

  const builtAt = newestMtime(builtIndex);
  const stale = sources
    .map((entry) => path.join(projectRoot, entry))
    .filter((entry) => fs.existsSync(entry) && newestMtime(entry) > builtAt);
  if (stale.length === 0) return null;

  const names = stale.map((entry) => path.relative(projectRoot, entry)).join(", ");
  return {
    kind: "stale",
    message: `dist/client is older than ${names}; run npm run build`,
  };
}

// For tests whose whole subject is the built bundle. Throws rather than skips:
// a skip would report success for a bundle that was never tested.
export function requireFreshBuiltUi() {
  const problem = builtUiProblem();
  if (problem) throw new Error(problem.message);
}
