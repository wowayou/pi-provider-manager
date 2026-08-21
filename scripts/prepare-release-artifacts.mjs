import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function prepareReleaseArtifacts() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const bundleName = `pi-provider-manager-v${manifest.version}`;
  const artifactDir = path.join(projectRoot, "artifacts");
  const stageDir = path.join(artifactDir, bundleName);
  const entries = [
    ["server.mjs", "server.mjs"],
    // server.mjs imports these directly; the release ships the dependency-free
    // sources rather than a bundle, so they have to travel with it.
    ["lib", "lib"],
    ["package.json", "package.json"],
    ["LICENSE", "LICENSE"],
    ["README.md", "README.md"],
    ["README.zh-CN.md", "README.zh-CN.md"],
    ["SECURITY.md", "SECURITY.md"],
    ["docs/release-install.md", "INSTALL.md"],
    ["docs/architecture.md", "docs/architecture.md"],
    ["docs/compatibility.md", "docs/compatibility.md"],
    ["bin/pi-provider-manager-ui", "bin/pi-provider-manager-ui"],
    ["bin/pi-provider-manager.ps1", "bin/pi-provider-manager.ps1"],
    ["dist/client", "dist/client"],
  ];

  if (!fs.existsSync(path.join(projectRoot, "dist", "client", "index.html"))) {
    throw new Error("Built UI not found. Run npm run build before preparing release artifacts.");
  }
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const [source, destination] of entries) {
    const sourcePath = path.join(projectRoot, source);
    const destinationPath = path.join(stageDir, destination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  }
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(stageDir, "bin", "pi-provider-manager-ui"), 0o755);
  }
  return { artifactDir, bundleName, stageDir, version: manifest.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { stageDir } = prepareReleaseArtifacts();
  process.stdout.write(`Prepared release staging directory: ${stageDir}\n`);
}
