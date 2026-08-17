import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PI_PROVIDER_MANAGER_API_PORT || 43121);
const AGENT_DIR = path.resolve(
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
);
const AUTH_PATH = path.join(AGENT_DIR, "auth.json");
const MODELS_PATH = path.join(AGENT_DIR, "models.json");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const ALLOWED_APIS = new Set([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
]);
const ALLOWED_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error(`${path.basename(filePath)} must contain a JSON object.`);
  return parsed;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    JSON.parse(fs.readFileSync(temporaryPath, "utf8"));
    replaceFile(temporaryPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function replaceFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (process.platform !== "win32" || !fs.existsSync(destination)) throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

function snapshot(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restore(filePath, bytes) {
  if (bytes === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  const temp = `${filePath}.rollback.${process.pid}`;
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  replaceFile(temp, filePath);
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

function titleFromId(id) {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function publicState() {
  const auth = readJson(AUTH_PATH);
  const models = readJson(MODELS_PATH);
  const settings = readJson(SETTINGS_PATH);
  const providerMap = isObject(models.providers) ? models.providers : {};
  const ids = [...new Set([...Object.keys(providerMap), ...Object.keys(auth)])].sort();
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
    agentDir: AGENT_DIR,
    providers,
    authProviders: Object.keys(auth).sort(),
    settings: {
      defaultProvider: settings.defaultProvider || "",
      defaultModel: settings.defaultModel || "",
      defaultThinkingLevel: settings.defaultThinkingLevel || "medium",
    },
  };
}

function normalizeUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("API 地址必须使用 http 或 https。");
  if (
    parsed.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("远程 API 地址必须使用 HTTPS，避免 key 明文传输。");
  }
  return normalized;
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

function saveProvider(payload) {
  if (!isObject(payload)) throw new Error("请求内容无效。");
  const providerId = String(payload.providerId || "").trim().replace(/[\\/]+$/, "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
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
  if (models.providers === undefined) models.providers = {};
  if (!isObject(models.providers)) throw new Error("models.json 中的 providers 必须是对象。");
  const existingProvider = isObject(models.providers[providerId]) ? models.providers[providerId] : {};
  const providerConfig = { ...existingProvider, baseUrl, api, models: normalizedModels };
  const compat = cleanCompat(api, payload.compat);
  if (compat) providerConfig.compat = compat;
  else delete providerConfig.compat;
  models.providers[providerId] = providerConfig;

  const credential = isObject(payload.credential) ? payload.credential : { mode: "keep" };
  if (credential.mode === "new") {
    const key = String(credential.apiKey || "").trim();
    if (!key) throw new Error("请输入 API Key。");
    auth[providerId] = { type: "api_key", key };
  } else if (credential.mode === "migrate") {
    const source = String(credential.fromProvider || "");
    if (!auth[source]) throw new Error("选择的已有凭据不存在。");
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

  const originals = new Map([
    [MODELS_PATH, snapshot(MODELS_PATH)],
    [AUTH_PATH, snapshot(AUTH_PATH)],
    [SETTINGS_PATH, snapshot(SETTINGS_PATH)],
  ]);
  try {
    writeJsonAtomic(MODELS_PATH, models);
    writeJsonAtomic(AUTH_PATH, auth);
    writeJsonAtomic(SETTINGS_PATH, settings);
  } catch (error) {
    for (const [filePath, bytes] of originals) restore(filePath, bytes);
    throw error;
  }
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

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/state") {
      sendJson(response, 200, publicState());
      return;
    }
    if (request.method === "POST" && request.url === "/api/providers") {
      saveProvider(await readBody(request));
      sendJson(response, 200, { ok: true, state: publicState() });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Pi Provider Manager API listening on http://${HOST}:${PORT}\n`);
  process.stdout.write(`Pi agent directory: ${AGENT_DIR}\n`);
});
