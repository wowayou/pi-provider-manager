// Claude Code has one user-level gateway. Alternatives and their credentials
// live in our private store; settings.json always wins when another tool edits it.
import path from "node:path";
import { isObject, parseJsonBytes, writeJsonAtomic } from "./atomic-files.mjs";
import { createFileGuard } from "./managed-files.mjs";
import { CLAUDE_ALIASES, CLAUDE_EFFORTS, claudeAliasEnv, validateClaudeProvider, validateClaudeCredential } from "./claude-shared.mjs";

const AUTH_ENV = { token: "ANTHROPIC_AUTH_TOKEN", "api-key": "ANTHROPIC_API_KEY" };
const PROVIDER_FLAGS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"];
const SETTINGS_KEYS = ["language", "effortLevel", "alwaysThinkingEnabled"];
const has = (object, key) => Object.hasOwn(object, key);
const text = (value) => typeof value === "string" ? value : "";

export function createClaudeConfig({ dir, dirSource = "default-home", revisionKey }) {
  const settingsPath = path.join(dir, "settings.json");
  const storePath = path.join(dir, "pi-provider-manager-store.json");
  const guard = createFileGuard({ paths: [settingsPath, storePath], revisionKey, subject: "Claude Code 配置" });

  function load() {
    const files = guard.stableSnapshots();
    const parse = (file) => {
      // JSON syntax diagnostics can quote credentials from the source. Never
      // forward a parser's input excerpt to /api/state or an error response.
      try { return parseJsonBytes(file, files.get(file)); }
      catch { throw new Error(`${path.basename(file)} 不是有效的 JSON 对象，请先修复文件。`); }
    };
    const settings = parse(settingsPath);
    if (has(settings, "env") && !isObject(settings.env)) throw new Error("Claude Code settings.json 的 env 必须是对象。");
    const raw = parse(storePath);
    if (has(raw, "version") && raw.version !== 1) throw new Error("不支持此 Claude Code 供应商存储版本，请升级管理器。");
    if ((has(raw, "providers") && !isObject(raw.providers)) || (has(raw, "credentials") && !isObject(raw.credentials))) throw new Error("Claude Code 供应商存储格式无效。");
    const store = { ...raw, version: 1, providers: { ...raw.providers }, credentials: { ...raw.credentials } };
    if (Object.values(store.providers).some((value) => !isObject(value)) || Object.values(store.credentials).some((value) => typeof value !== "string")) throw new Error("Claude Code 供应商存储条目格式无效。");
    return { files, settings, store };
  }

  function blockers(settings) {
    const env = settings.env || {};
    const activeFlags = PROVIDER_FLAGS.filter((key) => env[key] && !["0", "false"].includes(String(env[key]).toLowerCase()));
    if (settings.apiKeyHelper) activeFlags.push("apiKeyHelper");
    return activeFlags;
  }

  function fromSettings(settings) {
    const env = settings.env || {};
    if (!text(env.ANTHROPIC_BASE_URL)) return null;
    const authType = text(env.ANTHROPIC_AUTH_TOKEN) ? "token" : "api-key";
    return {
      baseUrl: text(env.ANTHROPIC_BASE_URL), authType,
      model: text(env.ANTHROPIC_MODEL) || text(settings.model) || text(env.ANTHROPIC_DEFAULT_MODEL) || "sonnet",
      aliases: Object.fromEntries(CLAUDE_ALIASES.flatMap((alias) => text(env[claudeAliasEnv(alias)]) ? [[alias, env[claudeAliasEnv(alias)]]] : [])),
      credential: text(env[AUTH_ENV[authType]]),
    };
  }

  function resolve(settings, store) {
    const providers = { ...store.providers };
    const credentials = { ...store.credentials };
    const disk = fromSettings(settings);
    let activeProviderId = "";
    let adoptedId = "";
    if (disk && blockers(settings).length === 0) {
      const matches = (id) => {
        const item = providers[id];
        return isObject(item) && item.baseUrl === disk.baseUrl && item.authType === disk.authType && item.model === disk.model
          && CLAUDE_ALIASES.every((alias) => (item.aliases?.[alias] || "") === (disk.aliases[alias] || ""))
          && text(credentials[id]) === disk.credential;
      };
      activeProviderId = has(providers, store.activeProviderId || "") && matches(store.activeProviderId)
        ? store.activeProviderId : Object.keys(providers).find(matches) || "";
      if (!activeProviderId) {
        adoptedId = "existing";
        for (let n = 2; has(providers, adoptedId) || has(credentials, adoptedId); n += 1) adoptedId = `existing-${n}`;
        const { credential, ...config } = disk;
        providers[adoptedId] = { ...config, name: "现有 Claude Code 网关" };
        if (credential) credentials[adoptedId] = credential;
        activeProviderId = adoptedId;
      }
    }
    return { providers, credentials, activeProviderId, adoptedId };
  }

  function materialize(settings, store) {
    const { adoptedId: _adoptedId, ...view } = resolve(settings, store);
    return { ...store, ...view };
  }

  function publicState() {
    const { files, settings, store } = load();
    const view = resolve(settings, store);
    return {
      dir, dirSource, revision: guard.revisionOf(files), activeProviderId: view.activeProviderId,
      blockers: blockers(settings),
      providers: Object.keys(view.providers).sort().map((id) => {
        const config = view.providers[id];
        // Vendor files can contain a key embedded in the URL even though our
        // form refuses it. Do not return those native-file credentials either.
        try {
          const url = new URL(config.baseUrl);
          if (url.username || url.password || url.search || url.hash) throw new Error();
        } catch { throw new Error("Claude Code 网关地址无效或包含凭据、查询参数、片段，请先在原文件处理。"); }
        return { id, name: text(config.name) || id, baseUrl: text(config.baseUrl), authType: config.authType,
          model: text(config.model), aliases: Object.fromEntries(CLAUDE_ALIASES.map((alias) => [alias, text(config.aliases?.[alias])])),
          credentialConfigured: Boolean(view.credentials[id]), adopted: view.adoptedId === id, isActive: view.activeProviderId === id };
      }),
      credentialProviders: Object.keys(view.credentials),
      settings: Object.fromEntries(SETTINGS_KEYS.filter((key) => has(settings, key) && (key === "alwaysThinkingEnabled" ? typeof settings[key] === "boolean" : typeof settings[key] === "string")).map((key) => [key, settings[key]])),
    };
  }

  function writeActive(settings, store) {
    const blocked = blockers(settings);
    if (blocked.length) throw new Error(`检测到 ${blocked.join("、")}。当前仅支持静态凭据的 Anthropic Messages 网关，请先在 Claude Code 用户设置中处理这些配置，再重新读取。`);
    const id = store.activeProviderId;
    if (!has(store.providers, id)) throw new Error("要启用的供应商不存在。");
    const config = validateClaudeProvider({ ...store.providers[id], providerId: id });
    const credential = validateClaudeCredential(store.credentials[id]);
    const env = { ...settings.env, ANTHROPIC_BASE_URL: config.baseUrl };
    // Both auth slots must be owned: leaving the previous token behind would
    // keep authenticating as the old gateway after selecting an API key.
    delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_MODEL; delete env.ANTHROPIC_DEFAULT_MODEL;
    env[AUTH_ENV[config.authType]] = credential;
    for (const alias of CLAUDE_ALIASES) {
      delete env[claudeAliasEnv(alias)];
      if (config.aliases[alias]) env[claudeAliasEnv(alias)] = config.aliases[alias];
    }
    writeJsonAtomic(settingsPath, { ...settings, env, model: config.model });
  }

  function saveProvider(payload) {
    const revision = guard.requireCurrentRevision(payload);
    const { settings, store: raw } = load();
    const store = materialize(settings, raw);
    const { id, ...config } = validateClaudeProvider(payload);
    const source = text(payload.renameFrom);
    if (source && source !== id && (!has(store.providers, source) || has(store.providers, id) || has(store.credentials, id))) throw new Error("改名来源不存在或供应商 ID 已被占用。");
    const owner = source || id;
    const mode = payload.credential?.mode;
    const credential = mode === "new" ? validateClaudeCredential(payload.credential.value)
      : mode === "keep" ? validateClaudeCredential(store.credentials[owner]) : (() => { throw new Error("请选择凭据来源。"); })();
    store.providers[id] = { ...(has(store.providers, owner) ? store.providers[owner] : {}), ...config };
    store.credentials[id] = credential;
    if (source && source !== id) { delete store.providers[source]; delete store.credentials[source]; }
    const activated = payload.setActive === true || store.activeProviderId === owner;
    if (activated) store.activeProviderId = id;
    guard.writeAll(revision, () => {
      if (activated) writeActive(settings, store);
      writeJsonAtomic(storePath, store);
    });
    return { providerId: id, activated };
  }

  function activate(payload) {
    const revision = guard.requireCurrentRevision(payload);
    const { settings, store: raw } = load();
    const store = materialize(settings, raw);
    store.activeProviderId = text(payload.providerId);
    guard.writeAll(revision, () => { writeActive(settings, store); writeJsonAtomic(storePath, store); });
  }

  function deleteProvider(payload) {
    const revision = guard.requireCurrentRevision(payload);
    const { settings, store: raw } = load();
    const store = materialize(settings, raw);
    const id = text(payload.providerId);
    if (!has(store.providers, id)) throw new Error("要删除的供应商不存在。");
    const wasActive = id === store.activeProviderId;
    if (wasActive) {
      const replacement = text(payload.replacementProviderId);
      if (replacement === id || !has(store.providers, replacement)) throw new Error("请先添加并指定一个替代供应商，再删除当前生效项。");
      store.activeProviderId = replacement;
    }
    delete store.providers[id];
    if (payload.keepCredential !== true) delete store.credentials[id];
    guard.writeAll(revision, () => { if (wasActive) writeActive(settings, store); writeJsonAtomic(storePath, store); });
  }

  function saveSettings(payload) {
    const revision = guard.requireCurrentRevision(payload);
    const { settings } = load();
    for (const key of SETTINGS_KEYS) {
      if (!has(payload, key)) continue;
      const value = payload[key];
      if (value === null) { delete settings[key]; continue; }
      if (key === "effortLevel" && !CLAUDE_EFFORTS.includes(value) && value !== settings[key]) throw new Error("不支持的思考强度。");
      if (key === "alwaysThinkingEnabled" && typeof value !== "boolean") throw new Error("思考设置必须为布尔值。");
      if (key === "language" && (typeof value !== "string" || !value.trim() || value.length > 100)) throw new Error("请填写有效语言（最多 100 字符）。");
      settings[key] = value;
    }
    guard.writeAll(revision, () => writeJsonAtomic(settingsPath, settings));
  }

  // Local launcher only. Never put this value in an HTTP response: it contains
  // the secret. The per-run file outranks user/project settings without copying
  // or changing permissions, hooks, plugins or organization policy.
  function launchSettings(providerId) {
    const { settings, store } = load();
    const blocked = blockers(settings);
    if (blocked.length) throw new Error("请先处理用户配置中的 " + blocked.join("、") + "，再使用静态网关启动命令。");
    const view = resolve(settings, store);
    if (!has(view.providers, providerId)) throw new Error("供应商不存在，请重新读取管理器并选择已保存的供应商。");
    const config = validateClaudeProvider({ ...view.providers[providerId], providerId });
    const credential = validateClaudeCredential(view.credentials[providerId]);
    return {
      model: config.model,
      apiKeyHelper: "",
      env: {
        ANTHROPIC_BASE_URL: config.baseUrl,
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        [AUTH_ENV[config.authType]]: credential,
        ANTHROPIC_MODEL: config.model,
        ANTHROPIC_DEFAULT_MODEL: "",
        ...Object.fromEntries(CLAUDE_ALIASES.map((alias) => [claudeAliasEnv(alias), config.aliases[alias] || ""])),
        ...Object.fromEntries(PROVIDER_FLAGS.map((flag) => [flag, "0"])),
      },
    };
  }

  return { settingsPath, storePath, publicState, saveProvider, activate, deleteProvider, saveSettings, launchSettings };
}
