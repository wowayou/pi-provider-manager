import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  isObject,
  parseJsonBytes,
  readJson,
  restore,
  snapshot,
  writeJsonAtomic,
} from "./lib/atomic-files.mjs";
import { createCodexConfig } from "./lib/codex-config.mjs";
import { builtUiProblem } from "./lib/built-ui.mjs";
import { createBridgeRunner } from "./lib/litellm-bridge.mjs";
import { createPromptLibrary } from "./lib/prompt-library.mjs";
import {
  applyCheckout,
  assetFor,
  compareVersions,
  describeInstall,
  downloadArchive,
  latestRelease,
  repositorySlug,
} from "./lib/self-update.mjs";
import { detectCodexVersion, detectPiVersion, liveVersion } from "./lib/version-detect.mjs";
import { ConflictError, PROVIDER_ID_PATTERN, isLoopbackHostname, normalizeUrl } from "./lib/validation.mjs";

const HOST = "127.0.0.1";
const SERVE_UI = process.env.PI_PROVIDER_MANAGER_SERVE_UI === "1";
const PORT = Number(
  process.env.PI_PROVIDER_MANAGER_PORT ||
  process.env.PI_PROVIDER_MANAGER_API_PORT ||
  (SERVE_UI ? 43127 : 43121),
);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PI_PROVIDER_MANAGER_PORT must be an integer between 1 and 65535.");
}
const SERVER_PATH = fileURLToPath(import.meta.url);
const PROJECT_DIR = path.dirname(SERVER_PATH);
const CLIENT_DIR = path.join(PROJECT_DIR, "dist", "client");
const AGENT_DIR = path.resolve(
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
);
const AGENT_DIR_SOURCE = process.env.PI_PROVIDER_MANAGER_AGENT_DIR_SOURCE || (
  process.env.PI_CODING_AGENT_DIR ? "PI_CODING_AGENT_DIR" : "default-home"
);
const AUTH_PATH = path.join(AGENT_DIR, "auth.json");
const MODELS_PATH = path.join(AGENT_DIR, "models.json");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const CODEX_DIR = path.resolve(
  process.env.PI_PROVIDER_MANAGER_CODEX_DIR || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
);
// The launcher resolves the directory itself and passes it explicitly, because
// the detached WSL process does not inherit the calling shell's environment.
// It reports the real origin separately so the compatibility panel does not
// claim an override the user never set.
const CODEX_DIR_SOURCE = process.env.PI_PROVIDER_MANAGER_CODEX_DIR_SOURCE || (
  process.env.PI_PROVIDER_MANAGER_CODEX_DIR
    ? "PI_PROVIDER_MANAGER_CODEX_DIR"
    : process.env.CODEX_HOME ? "CODEX_HOME" : "default-home"
);
const REVISION_KEY = crypto.randomBytes(32);
// Pi and Codex carry separate revisions on purpose: editing one must not
// invalidate an in-flight draft for the other.
const codex = createCodexConfig({ dir: CODEX_DIR, dirSource: CODEX_DIR_SOURCE, revisionKey: REVISION_KEY });
const bridge = createBridgeRunner({ dir: CODEX_DIR });

// Both agents read their global instructions from the directory this manager
// already owns, so one module serves both — each only declares which files it
// reads and what each one does. Verified against Pi's own README and, for
// Codex, by finding the text of $CODEX_HOME/AGENTS.md in `codex debug
// prompt-input`. These carry their own revisions, separate again from provider
// edits: rewriting a prompt must not invalidate a provider draft.
const prompts = {
  pi: createPromptLibrary({
    dir: AGENT_DIR,
    revisionKey: REVISION_KEY,
    subject: "Pi 提示词",
    slots: [
      { id: "agents", file: "AGENTS.md", label: "AGENTS.md", note: "与父目录、当前目录的 AGENTS.md 拼接后一起送给模型。" },
      { id: "system", file: "SYSTEM.md", label: "SYSTEM.md", note: "整体替换默认系统提示。写错会影响 Pi 的全部行为。" },
      { id: "append-system", file: "APPEND_SYSTEM.md", label: "APPEND_SYSTEM.md", note: "追加在默认系统提示之后，不替换它。" },
    ],
  }),
  codex: createPromptLibrary({
    dir: CODEX_DIR,
    revisionKey: REVISION_KEY,
    subject: "Codex 提示词",
    slots: [
      { id: "agents", file: "AGENTS.md", label: "AGENTS.md", note: "与项目里的 AGENTS.md 拼接后一起送给模型。" },
    ],
  }),
};

function promptLibrary(payload) {
  const library = prompts[String(payload.target || "")];
  if (!library) throw new Error("未知的目标（应为 pi 或 codex）。");
  return library;
}

// Keeps LiteLLM's config file in step with the store after any write that
// could have changed a provider's bridge or model list. A failure here must
// not undo a Codex write that already succeeded, so it is reported through
// state rather than thrown.
function syncBridgeConfig() {
  try {
    const spec = codex.bridgeSpec();
    if (spec) bridge.writeConfig(spec);
  } catch (error) {
    // The Codex write already succeeded; failing here must not undo it. Leave a
    // trace where the bridge's own problems are looked for rather than
    // swallowing it silently.
    try {
      fs.appendFileSync(bridge.logPath, `\n[pi-provider-manager] 无法生成桥的配置：${error.message}\n`);
    } catch {}
  }
}
const ALLOWED_APIS = new Set([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
]);
const ALLOWED_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ALLOWED_TRANSPORTS = new Set(["auto", "sse", "websocket"]);
const SETTINGS_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "hideThinkingBlock", "transport"];
const PACKAGE_MANIFEST = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "package.json"), "utf8"));
const APP_VERSION = PACKAGE_MANIFEST.version;
// The Pi release this manager was last validated against. Single source of truth:
// docs and release notes quote this, they do not carry their own copy.
const PI_VALIDATED_VERSION = PACKAGE_MANIFEST.piValidatedVersion || "unknown";
// Same contract for Codex: one recorded baseline, surfaced beside the version
// actually detected on the machine.
const CODEX_VALIDATED_VERSION = PACKAGE_MANIFEST.codexValidatedVersion || "unknown";

// Both are read through a self-refreshing cache rather than captured here: Pi
// and Codex can be upgraded while this manager keeps running, and a panel
// quoting the versions installed at startup is what sends people looking for a
// bug in an upgrade that actually worked. See lib/version-detect.mjs.
const piVersion = liveVersion(() => detectPiVersion());
const codexVersion = liveVersion(() => detectCodexVersion());

// The manager's own version is the opposite case, and stays the value read at
// startup: it names the code that is actually running, so re-reading the
// manifest would claim an upgrade this process has never loaded. Report what the
// manifest now says as well, so an old version on screen explains itself
// instead of looking like the upgrade did not take. Every release bumps this
// field, and carries the validated baselines with it, so it is the one
// comparison worth making.
// Whether the page being served was built from the sources now on disk. Only asked
// when this process is the one serving it: in development the UI comes from Vite,
// where the question is meaningless and the answer would be noise. A pull that has
// not been followed by a build is the case that matters — restarting there puts a
// new server behind an old page, and the panel is where that has to be said.
function readBundleProblem() {
  if (!SERVE_UI) return "";
  const problem = builtUiProblem(PROJECT_DIR);
  if (!problem || problem.kind !== "stale") return "";
  return "dist/client 比 src/ 旧：磁盘上的源码已经更新，但界面还没重新构建。先构建，再重启。";
}

function readPendingAppVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "package.json"), "utf8"));
    if (typeof manifest.version === "string" && manifest.version !== APP_VERSION) return manifest.version;
  } catch {}
  return "";
}

// Applying an upgrade means running different code, which no process can do to
// itself: this manager has to be replaced by one started from the files now on
// disk. Doing that from inside the process being replaced is only honest if a
// failure leaves the old one still serving — an upgrade that ends with nothing on
// the port, and no page left to explain it, is worse than one that never started.
// So the order is: stop listening, start the replacement, and wait for it to
// answer. Only then exit. If nothing answers, take the port back and keep the
// reason for the next reader.
let restarting = false;
let restartError = "";

// Answered by a different process id, which is the only proof that matters: this
// one has stopped listening, so anything replying on the port is the replacement.
function waitForReplacement(deadline, exited) {
  return new Promise((resolve) => {
    function retry() {
      // A replacement that has already exited will never answer. Waiting out the
      // deadline for it would only delay the recovery, and the exit code is a
      // better account of what went wrong than a timeout is.
      if (exited() || Date.now() >= deadline) {
        resolve(0);
        return;
      }
      setTimeout(attempt, 200).unref?.();
    }
    function attempt() {
      const request = http.get(
        { host: HOST, port: PORT, path: "/api/state", headers: { host: `${HOST}:${PORT}` } },
        (reply) => {
          const chunks = [];
          reply.on("data", (chunk) => chunks.push(chunk));
          reply.on("end", () => {
            try {
              const pid = JSON.parse(Buffer.concat(chunks).toString("utf8")).compatibility?.servicePid;
              if (Number.isInteger(pid) && pid !== process.pid) {
                resolve(pid);
                return;
              }
            } catch {}
            retry();
          });
        },
      );
      request.on("error", retry);
    }
    attempt();
  });
}

// A regular file or a character device (a terminal, /dev/null) is still there for
// the replacement to write to once this process is gone. A pipe or a socket is not.
function outlivesUs(fd) {
  try {
    const stats = fs.fstatSync(fd);
    return stats.isFile() || stats.isCharacterDevice() ? fd : "ignore";
  } catch {
    return "ignore";
  }
}

async function applyRestart() {
  restarting = true;
  restartError = "";
  // Releases the listening socket at once; the keep-alive connections the browser
  // holds would otherwise keep this process alive after its replacement is up.
  server.close();
  server.closeIdleConnections?.();
  const replacement = spawn(process.execPath, [SERVER_PATH], {
    cwd: PROJECT_DIR,
    // The replacement has to be handed the same machine. The port, both config
    // directories and the LiteLLM path all arrive through the environment, and
    // the launcher is not here to supply them a second time. The port is restated
    // rather than left to a default, so a defaulting rule that changes later
    // cannot move the replacement to another port.
    env: { ...process.env, PI_PROVIDER_MANAGER_PORT: String(PORT) },
    detached: true,
    // Inherited only where the destination outlives this process: the launcher
    // points its output at a log file and a developer's at a terminal, and that is
    // where a replacement's startup failure has to land. A pipe is the exception —
    // it belongs to whoever spawned this process, and holding its write end open
    // from a detached child leaves that reader waiting for an end that never comes.
    stdio: ["ignore", outlivesUs(1), outlivesUs(2)],
  });
  replacement.unref();
  let exit = null;
  replacement.once("exit", (code, signal) => { exit = { code, signal }; });
  replacement.once("error", (error) => { exit = { code: null, signal: null, message: error.message }; });

  const replacementPid = await waitForReplacement(Date.now() + 20_000, () => exit);
  if (replacementPid) {
    process.stdout.write(`Replaced by pid ${replacementPid}. Exiting ${process.pid}.\n`);
    process.exit(0);
  }

  try {
    replacement.kill();
  } catch {}
  restartError = exit
    ? `重启没有成功：新进程启动后立刻退出（${exit.message || `code ${exit.code}${exit.signal ? ` / ${exit.signal}` : ""}`}），仍在运行原来的版本。请查看日志。`
    : "重启没有成功：新进程没有在 20 秒内接管端口，仍在运行原来的版本。请查看日志后手动重启。";
  restarting = false;
  server.listen(PORT, HOST);
  process.stdout.write(`${restartError}\n`);
}

// Everything the panel knows about a newer release. Held here rather than fetched
// per read: a page load must not reach the network, so this stays empty until
// somebody asks, and then stays as the answer they got.
const updateState = {
  checkedAt: "",
  latestVersion: "",
  releaseUrl: "",
  newer: false,
  asset: "",
  install: null,
  running: false,
  steps: [],
  error: "",
  applied: "",
  downloaded: null,
};

let latestReleaseSeen = null;

async function checkForUpdate() {
  updateState.error = "";
  const release = await latestRelease({ slug: repositorySlug(PACKAGE_MANIFEST), version: APP_VERSION });
  latestReleaseSeen = release;
  const install = await describeInstall({ projectDir: PROJECT_DIR });
  const asset = assetFor(release);
  Object.assign(updateState, {
    checkedAt: new Date().toISOString(),
    latestVersion: release.version,
    releaseUrl: release.url,
    // Compared against the version this process is running, which is the one the
    // panel shows beside it. A checkout already pulled but not restarted reads as
    // "not newer" only after the restart, which is the honest order.
    newer: compareVersions(release.version, APP_VERSION) > 0,
    asset: asset ? asset.name : "",
    install,
  });
  return updateState;
}

// The upgrade runs in the background and reports through /api/state, the same place
// every other truth about this process lives. Two shapes, because the two kinds of
// install cannot be upgraded the same way: a checkout fast-forwards in place, an
// archive gets a sibling and a command to run.
async function runUpdate() {
  updateState.running = true;
  updateState.steps = [];
  updateState.error = "";
  updateState.applied = "";
  updateState.downloaded = null;
  try {
    if (updateState.install?.kind === "checkout") {
      const result = await applyCheckout({
        projectDir: PROJECT_DIR,
        onStep: (step) => {
          const existing = updateState.steps.findIndex((entry) => entry.name === step.name);
          if (existing >= 0) updateState.steps[existing] = step;
          else updateState.steps.push(step);
        },
      });
      if (!result.ok) throw new Error(`${result.failed}这一步失败了。`);
      // Deliberately not restarted from here: the new version is on disk and the
      // panel now has something to apply, which is a state someone can look at
      // before replacing the process they are talking to.
      updateState.applied = result.unchanged ? "unchanged" : readPendingAppVersion() || updateState.latestVersion;
    } else {
      if (!latestReleaseSeen) throw new Error("先检查一次更新，才知道要下载哪个版本。");
      updateState.steps.push({ name: "下载并解包到相邻目录", state: "running", ok: true, output: "" });
      const downloaded = await downloadArchive({ release: latestReleaseSeen, projectDir: PROJECT_DIR });
      updateState.steps[updateState.steps.length - 1] = {
        name: "下载并解包到相邻目录",
        state: "done",
        ok: true,
        output: downloaded.directory,
      };
      updateState.downloaded = downloaded;
    }
  } catch (error) {
    updateState.error = error.message;
    const last = updateState.steps[updateState.steps.length - 1];
    if (last && last.state === "running") updateState.steps[updateState.steps.length - 1] = { ...last, state: "failed", ok: false };
  } finally {
    updateState.running = false;
  }
}

// A broken or unreadable Codex directory must not take the whole state
// response down with it: the launcher probes /api/state to decide whether a
// port already belongs to this manager, and the Pi workflow does not depend
// on Codex at all.
function bridgeStatus() {
  try {
    const status = bridge.status();
    // Never expose the absolute log path's contents or the binary's resolution;
    // paths themselves are already visible in the compatibility panel.
    return status;
  } catch (error) {
    return { running: false, error: error.message };
  }
}

function codexState() {
  try {
    return { available: true, ...codex.publicState(), bridge: bridgeStatus() };
  } catch (error) {
    return {
      available: false,
      error: error.message,
      dir: CODEX_DIR,
      dirSource: CODEX_DIR_SOURCE,
      revision: "",
      providers: [],
      settings: {},
      settingsPresent: [],
    };
  }
}

function managedSnapshots() {
  return new Map([
    [AUTH_PATH, snapshot(AUTH_PATH)],
    [MODELS_PATH, snapshot(MODELS_PATH)],
    [SETTINGS_PATH, snapshot(SETTINGS_PATH)],
  ]);
}

function snapshotsEqual(left, right) {
  for (const filePath of [AUTH_PATH, MODELS_PATH, SETTINGS_PATH]) {
    const leftBytes = left.get(filePath);
    const rightBytes = right.get(filePath);
    if (leftBytes === null || rightBytes === null) {
      if (leftBytes !== rightBytes) return false;
    } else if (!leftBytes.equals(rightBytes)) {
      return false;
    }
  }
  return true;
}

function stableManagedSnapshots() {
  let previous = managedSnapshots();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = managedSnapshots();
    if (snapshotsEqual(previous, current)) return current;
    previous = current;
  }
  throw new ConflictError("Pi 配置正在被其他程序持续修改，请稍后重新读取。");
}

function configRevision(files = managedSnapshots()) {
  const hash = crypto.createHmac("sha256", REVISION_KEY);
  for (const filePath of [AUTH_PATH, MODELS_PATH, SETTINGS_PATH]) {
    const bytes = files.get(filePath);
    hash.update(path.basename(filePath));
    hash.update(bytes === null ? "\0missing\0" : `\0present:${bytes.length}\0`);
    if (bytes !== null) hash.update(bytes);
  }
  return hash.digest("hex");
}

function requireCurrentRevision(payload) {
  const expected = typeof payload.revision === "string" ? payload.revision : "";
  const files = stableManagedSnapshots();
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== configRevision(files)) {
    throw new ConflictError("Pi 配置已被其他程序或标签页修改。当前草稿尚未写入，请重新读取配置后再试。");
  }
  return expected;
}

function titleFromId(id) {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function publicState() {
  const files = stableManagedSnapshots();
  const auth = parseJsonBytes(AUTH_PATH, files.get(AUTH_PATH));
  const models = parseJsonBytes(MODELS_PATH, files.get(MODELS_PATH));
  const settings = parseJsonBytes(SETTINGS_PATH, files.get(SETTINGS_PATH));
  const providerMap = isObject(models.providers) ? models.providers : {};
  // Credentials may deliberately outlive a provider so they can be reused later.
  // Keep those IDs in authProviders, but do not render them as model providers.
  const ids = Object.keys(providerMap).sort();
  const providers = ids.map((id) => {
    const config = isObject(providerMap[id]) ? providerMap[id] : {};
    return {
      id,
      name: titleFromId(id),
      baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
      api: typeof config.api === "string" ? config.api : "",
      compat: isObject(config.compat) ? config.compat : {},
      models: Array.isArray(config.models) ? config.models : [],
      credentialConfigured: Boolean(auth[id]),
      isDefault: settings.defaultProvider === id,
    };
  });
  return {
    revision: configRevision(files),
    agentDir: AGENT_DIR,
    providers,
    authProviders: Object.keys(auth).sort(),
    settings: {
      defaultProvider: settings.defaultProvider || "",
      defaultModel: settings.defaultModel || "",
      defaultThinkingLevel: settings.defaultThinkingLevel || "medium",
      hideThinkingBlock: Boolean(settings.hideThinkingBlock),
      transport: ALLOWED_TRANSPORTS.has(settings.transport) ? settings.transport : "auto",
    },
    // Every settings value above is normalized, so a fallback is indistinguishable
    // from a stored value. Say which keys settings.json actually carries.
    settingsPresent: SETTINGS_KEYS.filter((key) => Object.hasOwn(settings, key)),
    codex: codexState(),
    // Empty unless a restart was asked for and did not take. The page that asked
    // is the one that needs to hear about it.
    restartError,
    update: updateState,
    prompts: { pi: prompts.pi.publicState(), codex: prompts.codex.publicState() },
    compatibility: {
      appVersion: APP_VERSION,
      pendingAppVersion: readPendingAppVersion(),
      bundleProblem: readBundleProblem(),
      piVersion: piVersion.get(),
      validatedPiVersion: PI_VALIDATED_VERSION,
      codexVersion: codexVersion.get(),
      validatedCodexVersion: CODEX_VALIDATED_VERSION,
      supportedApis: [...ALLOWED_APIS],
      configMode: "preserve-unknown-fields",
      configDirSource: AGENT_DIR_SOURCE,
      nodeVersion: process.version,
      servicePort: PORT,
      serviceHost: HOST,
      // So a launcher that finds this instance already running can offer to
      // stop exactly it, rather than pattern-matching a path it only assumed.
      servicePid: process.pid,
    },
  };
}

function normalizeModel(model, providerApi) {
  if (!isObject(model)) throw new Error("模型配置无效。");
  const id = String(model.id || "").trim();
  if (!id) throw new Error("模型 ID 不能为空。");
  const contextWindow = Number(model.contextWindow);
  const maxTokens = Number(model.maxTokens);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error(`${id} 的上下文容量无效。`);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens >= contextWindow) {
    throw new Error(`${id} 的最大输出必须小于上下文容量。`);
  }
  const reasoning = Boolean(model.reasoning);
  const maximumThinking = ALLOWED_THINKING.has(model.maximumThinking) ? model.maximumThinking : "high";
  const normalized = {
    id,
    name: String(model.name || id).trim() || id,
    reasoning,
    input: model.supportsImages ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
  };
  if (model.api && ALLOWED_APIS.has(model.api) && model.api !== providerApi) {
    normalized.api = model.api;
  }
  if (reasoning && maximumThinking === "xhigh") normalized.thinkingLevelMap = { xhigh: "xhigh" };
  if (reasoning && maximumThinking === "max") {
    normalized.thinkingLevelMap = { xhigh: "xhigh", max: "max" };
  }
  if (reasoning && model.forceAdaptiveThinking) {
    normalized.compat = { forceAdaptiveThinking: true };
  }
  return normalized;
}

function cleanCompat(api, compat) {
  if (!isObject(compat)) return undefined;
  const allowed =
    api === "anthropic-messages"
      ? ["supportsEagerToolInputStreaming", "supportsLongCacheRetention", "supportsCacheControlOnTools", "supportsStrictTools"]
      : ["supportsDeveloperRole", "supportsLongCacheRetention", "supportsStrictMode", "supportsStore", "supportsReasoningEffort", "supportsUsageInStreaming"];
  const result = {};
  for (const key of allowed) {
    if (typeof compat[key] === "boolean") result[key] = compat[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeExistingModel(existing, normalized, submitted, providerApi) {
  const merged = { ...(isObject(existing) ? existing : {}), ...normalized };
  const inheritsProviderApi = !submitted.api || submitted.api === "inherit" || submitted.api === providerApi;
  if (inheritsProviderApi) delete merged.api;
  if (!normalized.thinkingLevelMap) delete merged.thinkingLevelMap;

  const existingCompat = isObject(existing?.compat) ? existing.compat : {};
  // normalizeModel only sets this for reasoning models; the merge has to agree,
  // otherwise a model saved as 推理能力 = 不支持 still gets the flag written.
  if (submitted.forceAdaptiveThinking && normalized.reasoning) {
    merged.compat = { ...existingCompat, forceAdaptiveThinking: true };
  } else if (Object.keys(existingCompat).length > 0) {
    const preservedCompat = { ...existingCompat };
    delete preservedCompat.forceAdaptiveThinking;
    if (Object.keys(preservedCompat).length > 0) merged.compat = preservedCompat;
    else delete merged.compat;
  } else {
    delete merged.compat;
  }
  return merged;
}

function saveProvider(payload) {
  if (!isObject(payload)) throw new Error("请求内容无效。");
  const revision = requireCurrentRevision(payload);
  const providerId = String(payload.providerId || "").trim().replace(/[\\/]+$/, "");
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("供应商 ID 只能使用小写字母、数字、点、下划线和连字符。");
  }
  const api = String(payload.api || "");
  if (!ALLOWED_APIS.has(api)) throw new Error("请选择受支持的接口协议。");
  const baseUrl = normalizeUrl(payload.baseUrl);
  if (!Array.isArray(payload.models) || payload.models.length === 0) throw new Error("至少添加一个模型。");
  const normalizedModels = payload.models.map((model) => normalizeModel(model, api));
  if (new Set(normalizedModels.map((model) => model.id)).size !== normalizedModels.length) {
    throw new Error("模型 ID 不能重复。");
  }

  const auth = readJson(AUTH_PATH);
  const models = readJson(MODELS_PATH);
  const settings = readJson(SETTINGS_PATH);
  // models.json and settings.json have to stay in step: the submitted list replaces
  // the stored one wholesale, so dropping the model settings.json points at would
  // leave Pi with a default it cannot resolve. Only the setDefault branch below
  // rewrites settings, which makes this request the one that breaks the pair, and
  // it is reachable from a stale tab or a direct API call.
  if (
    !payload.setDefault &&
    settings.defaultProvider === providerId &&
    typeof settings.defaultModel === "string" &&
    settings.defaultModel !== "" &&
    !normalizedModels.some((model) => model.id === settings.defaultModel)
  ) {
    throw new Error(
      `Pi 当前的默认模型 ${settings.defaultModel} 不在这次提交的模型列表里。请用“保存并设为默认”指定新的默认模型。`,
    );
  }
  if (models.providers === undefined) models.providers = {};
  if (!isObject(models.providers)) throw new Error("models.json 中的 providers 必须是对象。");
  const existingProvider = isObject(models.providers[providerId]) ? models.providers[providerId] : {};
  const existingModels = new Map(
    (Array.isArray(existingProvider.models) ? existingProvider.models : [])
      .filter((model) => isObject(model) && typeof model.id === "string")
      .map((model) => [model.id, model]),
  );
  const mergedModels = normalizedModels.map((model, index) =>
    mergeExistingModel(existingModels.get(model.id), model, payload.models[index], api),
  );
  const providerConfig = { ...existingProvider, baseUrl, api, models: mergedModels };
  // Switching protocols leaves the previous protocol's flags behind, and
  // cleanCompat would reject them for the new api, so filter what we keep too.
  const keptCompat = cleanCompat(api, existingProvider.compat) || {};
  const submittedCompat = cleanCompat(api, payload.compat) || {};
  const mergedCompat = { ...keptCompat, ...submittedCompat };
  if (Object.keys(mergedCompat).length > 0) providerConfig.compat = mergedCompat;
  else delete providerConfig.compat;
  models.providers[providerId] = providerConfig;

  const credential = isObject(payload.credential) ? payload.credential : { mode: "keep" };
  if (credential.mode === "new") {
    const key = String(credential.apiKey || "").trim();
    if (!key) throw new Error("请输入 API Key。");
    auth[providerId] = { type: "api_key", key };
  } else if (credential.mode === "migrate") {
    const source = String(credential.fromProvider || "");
    // "__proto__", "constructor" and friends resolve through the prototype chain,
    // so a bare truthiness check accepts them and then overwrites a real key with {}.
    if (!PROVIDER_ID_PATTERN.test(source) || !Object.hasOwn(auth, source) || !isObject(auth[source])) {
      throw new Error("选择的已有凭据不存在。");
    }
    auth[providerId] = auth[source];
    if (credential.move && source !== providerId) delete auth[source];
  } else if (!auth[providerId]) {
    throw new Error("该供应商尚未配置凭据，请输入新 key 或从已有供应商迁移。");
  }

  if (payload.setDefault) {
    const defaultModelId = String(payload.defaultModelId || "");
    if (!normalizedModels.some((model) => model.id === defaultModelId)) throw new Error("默认模型不在模型列表中。");
    settings.defaultProvider = providerId;
    settings.defaultModel = defaultModelId;
    settings.defaultThinkingLevel = ALLOWED_THINKING.has(payload.defaultThinkingLevel)
      ? payload.defaultThinkingLevel
      : "high";
  }

  const originals = stableManagedSnapshots();
  if (revision !== configRevision(originals)) {
    throw new ConflictError("Pi 配置在保存期间发生了变化。当前草稿尚未写入，请重新读取配置后再试。");
  }
  try {
    writeJsonAtomic(MODELS_PATH, models);
    writeJsonAtomic(AUTH_PATH, auth);
    writeJsonAtomic(SETTINGS_PATH, settings);
  } catch (error) {
    for (const [filePath, bytes] of originals) restore(filePath, bytes);
    throw error;
  }
}

function deleteProvider(payload) {
  if (!isObject(payload)) throw new Error("请求内容无效。");
  const revision = requireCurrentRevision(payload);
  const providerId = String(payload.providerId || "").trim();
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("要删除的供应商 ID 无效。");
  }

  const auth = readJson(AUTH_PATH);
  const models = readJson(MODELS_PATH);
  const settings = readJson(SETTINGS_PATH);
  const providers = isObject(models.providers) ? models.providers : null;
  if (!providers || !Object.hasOwn(providers, providerId) || !isObject(providers[providerId])) {
    throw new Error("要删除的供应商不存在。");
  }

  if (settings.defaultProvider === providerId) {
    const replacementProviderId = String(payload.replacementProviderId || "").trim();
    const replacementModelId = String(payload.replacementModelId || "").trim();
    if (
      !PROVIDER_ID_PATTERN.test(replacementProviderId)
      || replacementProviderId === providerId
      || !Object.hasOwn(providers, replacementProviderId)
      || !isObject(providers[replacementProviderId])
    ) {
      throw new Error("删除 Pi 当前默认供应商前，请选择另一个有效供应商。");
    }
    const replacementModels = Array.isArray(providers[replacementProviderId].models)
      ? providers[replacementProviderId].models
      : [];
    if (!replacementModels.some((model) => isObject(model) && model.id === replacementModelId)) {
      throw new Error("替代模型不属于所选供应商。");
    }
    settings.defaultProvider = replacementProviderId;
    settings.defaultModel = replacementModelId;
  }

  delete providers[providerId];
  if (payload.keepCredential !== true) delete auth[providerId];

  const originals = stableManagedSnapshots();
  if (revision !== configRevision(originals)) {
    throw new ConflictError("Pi 配置在删除期间发生了变化。没有删除任何内容，请重新读取配置后再试。");
  }
  try {
    writeJsonAtomic(MODELS_PATH, models);
    writeJsonAtomic(AUTH_PATH, auth);
    writeJsonAtomic(SETTINGS_PATH, settings);
  } catch (error) {
    for (const [filePath, bytes] of originals) restore(filePath, bytes);
    throw error;
  }
}

function saveSettings(payload) {
  if (!isObject(payload)) throw new Error("设置内容无效。");
  const revision = requireCurrentRevision(payload);
  const models = readJson(MODELS_PATH);
  const settings = readJson(SETTINGS_PATH);
  const providers = isObject(models.providers) ? models.providers : {};
  const defaultProvider = String(payload.defaultProvider || "");
  const defaultModel = String(payload.defaultModel || "");
  if (!Object.hasOwn(providers, defaultProvider) || !isObject(providers[defaultProvider])) {
    throw new Error("默认供应商不存在。");
  }
  const providerModels = Array.isArray(providers[defaultProvider].models) ? providers[defaultProvider].models : [];
  if (!providerModels.some((model) => model?.id === defaultModel)) throw new Error("默认模型不属于该供应商。");

  settings.defaultProvider = defaultProvider;
  settings.defaultModel = defaultModel;
  settings.defaultThinkingLevel = ALLOWED_THINKING.has(payload.defaultThinkingLevel)
    ? payload.defaultThinkingLevel
    : "medium";
  settings.hideThinkingBlock = Boolean(payload.hideThinkingBlock);
  settings.transport = ALLOWED_TRANSPORTS.has(payload.transport) ? payload.transport : "auto";
  const current = stableManagedSnapshots();
  if (revision !== configRevision(current)) {
    throw new ConflictError("Pi 配置在保存期间发生了变化。当前设置尚未写入，请重新读取配置后再试。");
  }
  writeJsonAtomic(SETTINGS_PATH, settings);
}

// Reads whether anything is listening on a local port. It never sends a
// credential and never leaves the loopback interface: an endpoint that would
// reach an arbitrary URL on demand is a probe any page in the browser could aim
// at the user's own network.
//
// A TCP connect rather than an HTTP request, because "something is listening"
// is the entire claim. Asking for a path would assume the bridge implements it,
// and a bridge that answers 404 is no less running.
function probeBridge(payload) {
  if (!isObject(payload)) throw new Error("请求内容无效。");
  const target = new URL(normalizeUrl(payload.baseUrl));
  if (!isLoopbackHostname(target.hostname)) {
    throw new Error("只能探测本机地址（127.0.0.1、localhost 或 [::1]）。");
  }
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.hostname, port });
    const finish = (status) => {
      socket.destroy();
      resolve({ status });
    };
    socket.setTimeout(2000);
    socket.once("connect", () => finish("listening"));
    // Refused and timed out are the same answer to the user: nothing usable
    // replied. They are not even distinguishable everywhere — under WSL2
    // mirrored networking a connect to an unbound loopback port hangs rather
    // than being refused.
    socket.once("timeout", () => finish("no-answer"));
    socket.once("error", () => finish("no-answer"));
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

// The theme bootstrap has to run before first paint, so it cannot be bundled or
// deferred, which means the CSP has to name it by hash rather than allow inline
// scripts wholesale.
let cachedScriptSrc = { mtimeMs: -1, value: "'self'" };
function scriptSrc() {
  const indexPath = path.join(CLIENT_DIR, "index.html");
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(indexPath).mtimeMs;
  } catch {
    return "'self'";
  }
  if (cachedScriptSrc.mtimeMs === mtimeMs) return cachedScriptSrc.value;
  let value = "'self'";
  try {
    const html = fs.readFileSync(indexPath, "utf8");
    const hashes = [];
    for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      hashes.push(`'sha256-${crypto.createHash("sha256").update(match[1], "utf8").digest("base64")}'`);
    }
    if (hashes.length > 0) value = `'self' ${hashes.join(" ")}`;
  } catch {
    value = "'self'";
  }
  cachedScriptSrc = { mtimeMs, value };
  return value;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
  }[extension] || "application/octet-stream";
}

function sendStatic(response, requestUrl) {
  if (!fs.existsSync(path.join(CLIENT_DIR, "index.html"))) {
    sendJson(response, 503, { error: "UI build not found. Run npm run build." });
    return;
  }
  const url = new URL(requestUrl, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = path.resolve(CLIENT_DIR, requested);
  if (!filePath.startsWith(`${path.resolve(CLIENT_DIR)}${path.sep}`) && filePath !== path.resolve(CLIENT_DIR, "index.html")) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) filePath = path.join(CLIENT_DIR, "index.html");
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": body.length,
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'self'; script-src ${scriptSrc()}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// This API is reachable by any page the user's browser is pointed at, and it can
// write credentials, so requests have to prove they came from this app's origin.
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);

// Defeats DNS rebinding: an attacker who points their own name at 127.0.0.1
// becomes same-origin, so CORS never applies, but the Host header still carries
// their name.
function hostAllowed(request) {
  const host = request.headers.host;
  return typeof host === "string" && ALLOWED_HOSTS.has(host.toLowerCase());
}

// A cross-origin POST only escapes CORS preflight while it stays a "simple
// request", and application/json is not one. Requiring it forces any
// cross-origin attempt to preflight, and we answer no preflight.
function jsonContentType(request) {
  const value = request.headers["content-type"];
  return typeof value === "string"
    && value.split(";")[0].trim().toLowerCase() === "application/json";
}

const server = http.createServer(async (request, response) => {
  try {
    const isApi = typeof request.url === "string" && request.url.startsWith("/api/");
    if (isApi && !hostAllowed(request)) {
      sendJson(response, 403, { error: "Forbidden host." });
      return;
    }
    if (isApi && request.method === "POST" && !jsonContentType(request)) {
      sendJson(response, 415, { error: "Content-Type must be application/json." });
      return;
    }
    if (request.method === "GET" && request.url === "/api/state") {
      sendJson(response, 200, publicState());
      return;
    }
    if (request.method === "POST" && request.url === "/api/providers") {
      saveProvider(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/providers/delete") {
      deleteProvider(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/update/check") {
      // A POST because it has an effect off this machine: one request to
      // api.github.com, made because somebody pressed a button. Nothing here runs
      // on a timer or on page load.
      sendJson(response, 200, { ok: true, update: await checkForUpdate() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/update/apply") {
      if (updateState.running) {
        sendJson(response, 409, { error: "已经在更新中。" });
        return;
      }
      if (!updateState.checkedAt) {
        sendJson(response, 400, { error: "先检查更新。" });
        return;
      }
      if (updateState.install?.kind === "checkout" && !updateState.install.canApply) {
        sendJson(response, 409, { error: updateState.install.reason || "当前 checkout 不能自动升级。" });
        return;
      }
      updateState.running = true;
      sendJson(response, 202, { ok: true });
      response.on("finish", () => { runUpdate(); });
      return;
    }
    if (request.method === "POST" && request.url === "/api/restart") {
      if (restarting) {
        sendJson(response, 409, { error: "已经在重启中。" });
        return;
      }
      // Refused here as well as hidden in the button: a restart across a stale
      // bundle is the one outcome of an interrupted upgrade that looks like it
      // worked, and the page asking for it may be older than this rule.
      const bundleProblem = readBundleProblem();
      if (bundleProblem) {
        sendJson(response, 409, { error: bundleProblem });
        return;
      }
      // Answered before the handover begins: the port this reply travels over is
      // the one about to be handed to another process. The caller is told which
      // process it is replacing, so it can wait for a different one to answer.
      sendJson(response, 202, {
        ok: true,
        pid: process.pid,
        appVersion: APP_VERSION,
        pendingAppVersion: readPendingAppVersion(),
      });
      response.on("finish", () => {
        applyRestart().catch((error) => {
          restarting = false;
          restartError = `重启失败：${error.message}`;
          process.stdout.write(`${restartError}\n`);
          try {
            server.listen(PORT, HOST);
          } catch {}
        });
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/settings") {
      saveSettings(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/providers") {
      codex.saveProvider(await readBody(request));
      syncBridgeConfig();
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/providers/delete") {
      codex.deleteProvider(await readBody(request));
      syncBridgeConfig();
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/activate") {
      codex.activate(await readBody(request));
      syncBridgeConfig();
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/settings") {
      codex.saveSettings(await readBody(request));
      syncBridgeConfig();
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/bridge/start") {
      const body = await readBody(request);
      const spec = codex.bridgeSpec(String(body.providerId || ""));
      if (!spec) throw new Error("这个供应商没有配置本地桥。");
      bridge.writeConfig(spec);
      bridge.start(spec);
      sendJson(response, 200, { ok: true, bridge: bridgeStatus() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/bridge/stop") {
      const result = bridge.stop();
      sendJson(response, 200, { ok: true, stopped: result.stopped, bridge: bridgeStatus() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/prompts") {
      const body = await readBody(request);
      promptLibrary(body).saveDocument(body);
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/prompts/activate") {
      const body = await readBody(request);
      promptLibrary(body).activate(body);
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/prompts/delete") {
      const body = await readBody(request);
      promptLibrary(body).deleteDocument(body);
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/bridge-check") {
      sendJson(response, 200, await probeBridge(await readBody(request)));
      return;
    }
    if (request.method === "GET" && SERVE_UI && !request.url.startsWith("/api/")) {
      sendStatic(response, request.url);
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, Number.isInteger(error.statusCode) ? error.statusCode : 400, { error: error.message });
  }
});

// Detect once before accepting anything, so the first request is served from a
// warm cache: the launcher's readiness probe times out after a second, and
// detection can outlast that on a machine where it needs a login shell.
await Promise.all([piVersion.ready(), codexVersion.ready()]);

server.listen(PORT, HOST, () => {
  process.stdout.write(`Pi Provider Manager API listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`Pi agent directory: ${AGENT_DIR}\n`);
  process.stdout.write(`Codex directory: ${CODEX_DIR}\n`);
  if (SERVE_UI) process.stdout.write(`Serving built UI from ${CLIENT_DIR}\n`);
});
