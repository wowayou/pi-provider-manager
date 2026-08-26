// The rule itself lives in lib/built-ui.mjs, because the server needs it too: an
// upgrade that pulls and fails to build leaves a source tree newer than its bundle,
// and restarting there would put a new server behind an old page. One copy, two
// readers.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { builtUiProblem as problemIn } from "../../lib/built-ui.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function builtUiProblem() {
  return problemIn(projectRoot);
}

// For tests whose whole subject is the built bundle. Throws rather than skips: a
// skip would report success for a bundle that was never tested.
export function requireFreshBuiltUi() {
  const problem = builtUiProblem();
  if (problem) throw new Error(problem.message);
}
