import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareReleaseArtifacts } from "../scripts/prepare-release-artifacts.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release staging contains runnable launchers and no local Pi data", () => {
  const { stageDir, version } = prepareReleaseArtifacts();
  const manifest = JSON.parse(fs.readFileSync(path.join(stageDir, "package.json"), "utf8"));
  assert.equal(manifest.version, version);
  for (const entry of [
    "server.mjs",
    "dist/client/index.html",
    "bin/pi-provider-manager-ui",
    "bin/pi-provider-manager.ps1",
    "INSTALL.md",
  ]) {
    assert.equal(fs.existsSync(path.join(stageDir, entry)), true, `${entry} must be packaged`);
  }
  for (const entry of ["auth.json", "models.json", "settings.json", "node_modules", "tests", ".env"]) {
    assert.equal(fs.existsSync(path.join(stageDir, entry)), false, `${entry} must not be packaged`);
  }
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(stageDir, "bin", "pi-provider-manager-ui")).mode & 0o111, 0o111);
  }
});
