import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
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
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
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

function detectPiVersion() {
  const nvmNodes = path.join(os.homedir(), ".nvm", "versions", "node");
  if (fs.existsSync(nvmNodes)) {
    const versions = [];
    for (const nodeVersion of fs.readdirSync(nvmNodes)) {
      const packagePath = path.join(
        nvmNodes,
        nodeVersion,
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      );
      try {
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        if (typeof packageJson.version === "string") versions.push(packageJson.version);
      } catch {}
    }
    if (versions.length > 0) {
      return versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    }
  }
  const commands = process.platform === "win32"
    ? [["pi", ["--version"]]]
    : [["/bin/bash", ["-lic", "pi --version"]], ["pi", ["--version"]]];
  for (const [command, args] of commands) {
    try {
      const output = execFileSync(command, args, {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = output.match(/\d+\.\d+\.\d+/);
      if (match) return match[0];
    } catch {}
  }
  return "unknown";
}

const PI_VERSION = detectPiVersion();

// Codex is a single binary rather than an npm package, so unlike Pi there is
// no install tree to inspect — only the command itself.
function detectCodexVersion() {
  const commands = process.platform === "win32"
    ? [["codex", ["--version"]]]
    : [["/bin/bash", ["-lic", "codex --version"]], ["codex", ["--version"]]];
  for (const [command, args] of commands) {
    try {
      const output = execFileSync(command, args, {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = output.match(/\d+\.\d+\.\d+/);
      if (match) return match[0];
    } catch {}
  }
  return "unknown";
}

const CODEX_VERSION = detectCodexVersion();

// A broken or unreadable Codex directory must not take the whole state
// response down with it: the launcher probes /api/state to decide whether a
// port already belongs to this manager, and the Pi workflow does not depend
// on Codex at all.
function codexState() {
  try {
    return { available: true, ...codex.publicState() };
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
    compatibility: {
      appVersion: APP_VERSION,
      piVersion: PI_VERSION,
      validatedPiVersion: PI_VALIDATED_VERSION,
      codexVersion: CODEX_VERSION,
      validatedCodexVersion: CODEX_VALIDATED_VERSION,
      supportedApis: [...ALLOWED_APIS],
      configMode: "preserve-unknown-fields",
      configDirSource: AGENT_DIR_SOURCE,
      nodeVersion: process.version,
      servicePort: PORT,
      serviceHost: HOST,
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

// Reads whether *something* is answering on a local bridge port. It never sends
// a credential and never leaves the loopback interface: an endpoint that would
// fetch an arbitrary URL on demand is a probe any page in the browser could aim
// at the user's own network.
function probeBridge(payload) {
  if (!isObject(payload)) throw new Error("请求内容无效。");
  const baseUrl = normalizeUrl(payload.baseUrl);
  const target = new URL(`${baseUrl}/models`);
  if (!isLoopbackHostname(target.hostname)) {
    throw new Error("只能探测本机地址（127.0.0.1、localhost 或 [::1]）。");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("探测地址必须使用 http 或 https。");
  }
  const secure = target.protocol === "https:";
  const client = secure ? https : http;
  return new Promise((resolve) => {
    const request = client.request(
      {
        host: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: target.pathname,
        method: "GET",
        timeout: 2000,
        // A bridge running on localhost over TLS almost always has a
        // self-signed certificate. Nothing secret is sent and nothing but
        // reachability is reported, so refusing it would only produce a
        // misleading "not running".
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
        // Any HTTP answer at all — 401 included — means a server is listening.
        // Saying more than that would be claiming the bridge is the right one.
        resolve({ status: "listening", httpStatus: response.statusCode });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ status: "timeout" });
    });
    request.on("error", () => resolve({ status: "refused" }));
    request.end();
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
    if (request.method === "POST" && request.url === "/api/settings") {
      saveSettings(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/providers") {
      codex.saveProvider(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/providers/delete") {
      codex.deleteProvider(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/activate") {
      codex.activate(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    if (request.method === "POST" && request.url === "/api/codex/settings") {
      codex.saveSettings(await readBody(request));
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

server.listen(PORT, HOST, () => {
  process.stdout.write(`Pi Provider Manager API listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`Pi agent directory: ${AGENT_DIR}\n`);
  process.stdout.write(`Codex directory: ${CODEX_DIR}\n`);
  if (SERVE_UI) process.stdout.write(`Serving built UI from ${CLIENT_DIR}\n`);
});
