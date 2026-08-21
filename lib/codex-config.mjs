// Codex CLI configuration, as this manager sees it.
//
// Codex is shaped very differently from Pi. It has exactly one credential slot
// (auth.json's OPENAI_API_KEY) and, in the single-table layout this project
// uses, exactly one manager-owned [model_providers.<id>] table. Switching
// providers therefore rewrites that one table and swaps the key, which means
// the full definition of every *other* provider has to live somewhere else:
// this module's own store file. config.toml stays the truth for what Codex
// will actually do; the store is the truth for what else you have configured.
//
// Everything the manager does not own — comments, unrelated keys, and any
// [model_providers.*] table the user wrote by hand — is preserved byte for
// byte by lib/toml-document.mjs.

import crypto from "node:crypto";
import path from "node:path";

import {
  isObject,
  parseJsonBytes,
  restore,
  snapshot,
  writeJsonAtomic,
  writeTextAtomic,
} from "./atomic-files.mjs";
import { TomlDocument } from "./toml-document.mjs";
import { ConflictError, isLoopbackHostname, normalizeUrl } from "./validation.mjs";

// Codex 0.149.0 only accepts "responses"; "chat" was removed in February 2026
// and writing it makes the whole config.toml fail to parse.
export const CODEX_WIRE_API = "responses";
export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_VERBOSITIES = ["low", "medium", "high"];
export const DEFAULT_REASONING_EFFORT = "high";
export const DEFAULT_OWNED_PROVIDER_ID = "custom";

// Built-in ids Codex refuses to let a user table override.
export const CODEX_RESERVED_PROVIDER_IDS = new Set([
  "openai",
  "ollama",
  "ollama-chat",
  "lmstudio",
  "amazon-bedrock",
  "amazon-bedrock-runtime",
]);

// No dots: the id becomes part of a [profiles.<id>-<model>] header, and a dot
// there would silently create a nested table instead of a flat profile.
export const CODEX_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const TOP_LEVEL_KEYS = [
  "model",
  "model_provider",
  "model_reasoning_effort",
  "plan_mode_reasoning_effort",
  "model_verbosity",
  "model_context_window",
];

const MAX_CONTEXT_WINDOW = 100_000_000;

function titleFromId(id) {
  return id
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isLoopbackUrl(value) {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function profileSlug(modelId) {
  return String(modelId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeEffort(value, fallback = DEFAULT_REASONING_EFFORT) {
  return CODEX_REASONING_EFFORTS.includes(value) ? value : fallback;
}

function normalizeModels(raw) {
  if (!Array.isArray(raw)) return [];
  const models = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry.trim() : String(entry?.id || "").trim();
    if (!id) continue;
    models.push({ id, reasoningEffort: normalizeEffort(entry?.reasoningEffort) });
  }
  return models;
}

function normalizeStoredProvider(raw) {
  const models = normalizeModels(raw.models);
  const defaultModelId = models.some((model) => model.id === raw.defaultModelId)
    ? raw.defaultModelId
    : models[0]?.id || "";
  const credential =
    isObject(raw.credential) && typeof raw.credential.key === "string" && raw.credential.key !== ""
      ? { type: "api_key", key: raw.credential.key }
      : null;
  return {
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : "",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    upstream: raw.upstream === "bridge" ? "bridge" : "direct",
    requiresAuth: raw.requiresAuth !== false,
    models,
    defaultModelId,
    credential,
  };
}

function normalizeStore(raw) {
  const source = isObject(raw) ? raw : {};
  const ownedProviderId =
    typeof source.ownedProviderId === "string"
    && CODEX_ID_PATTERN.test(source.ownedProviderId)
    && !CODEX_RESERVED_PROVIDER_IDS.has(source.ownedProviderId)
      ? source.ownedProviderId
      : DEFAULT_OWNED_PROVIDER_ID;
  const providers = {};
  if (isObject(source.providers)) {
    for (const [id, value] of Object.entries(source.providers)) {
      if (!CODEX_ID_PATTERN.test(id) || !isObject(value)) continue;
      providers[id] = normalizeStoredProvider(value);
    }
  }
  return {
    version: 1,
    ownedProviderId,
    activeProviderId: typeof source.activeProviderId === "string" ? source.activeProviderId : "",
    generateProfiles: source.generateProfiles !== false,
    // Which profile tables this manager wrote last time. Deleting by this list
    // rather than by name prefix is what keeps a hand-written profile that
    // happens to share the prefix from being swept away.
    generatedProfiles: Array.isArray(source.generatedProfiles)
      ? source.generatedProfiles.filter((name) => typeof name === "string")
      : [],
    providers,
  };
}

function uniqueId(base, taken) {
  const seed = CODEX_ID_PATTERN.test(base) ? base : DEFAULT_OWNED_PROVIDER_ID;
  if (!taken[seed]) return seed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${seed}-${suffix}`;
    if (!taken[candidate]) return candidate;
  }
}

export function createCodexConfig({ dir, dirSource, revisionKey }) {
  const configPath = path.join(dir, "config.toml");
  const authPath = path.join(dir, "auth.json");
  const storePath = path.join(dir, "pi-provider-manager-store.json");
  const managedPaths = [configPath, authPath, storePath];

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

  function stableSnapshots() {
    let previous = snapshots();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = snapshots();
      if (snapshotsEqual(previous, current)) return current;
      previous = current;
    }
    throw new ConflictError("Codex 配置正在被其他程序持续修改，请稍后重新读取。");
  }

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
      throw new ConflictError("Codex 配置已被其他程序或标签页修改。当前草稿尚未写入，请重新读取配置后再试。");
    }
    return expected;
  }

  function load() {
    const files = stableSnapshots();
    const document = TomlDocument.parse(files.get(configPath)?.toString("utf8") ?? "");
    const auth = parseJsonBytes(authPath, files.get(authPath));
    const store = normalizeStore(parseJsonBytes(storePath, files.get(storePath)));
    return { files, document, auth, store };
  }

  // The manager-owned table as it exists on disk right now. This is what Codex
  // will really use, so it outranks anything the store believes.
  function liveTable(document, ownedProviderId) {
    const keys = document.tableKeys(`model_providers.${ownedProviderId}`);
    if (!keys) return null;
    return {
      name: typeof keys.name === "string" ? keys.name : "",
      baseUrl: typeof keys.base_url === "string" ? keys.base_url : "",
      requiresAuth: keys.requires_openai_auth === true,
      wireApi: typeof keys.wire_api === "string" ? keys.wire_api : CODEX_WIRE_API,
    };
  }

  function readSettings(document) {
    return {
      model: typeof document.getTopLevel("model") === "string" ? document.getTopLevel("model") : "",
      modelProvider:
        typeof document.getTopLevel("model_provider") === "string" ? document.getTopLevel("model_provider") : "",
      reasoningEffort: normalizeEffort(document.getTopLevel("model_reasoning_effort"), "medium"),
      planModeReasoningEffort: normalizeEffort(document.getTopLevel("plan_mode_reasoning_effort"), "medium"),
      verbosity: CODEX_VERBOSITIES.includes(document.getTopLevel("model_verbosity"))
        ? document.getTopLevel("model_verbosity")
        : "medium",
      contextWindow: Number.isSafeInteger(document.getTopLevel("model_context_window"))
        ? document.getTopLevel("model_context_window")
        : 0,
      disableResponseStorage: document.getTopLevel("disable_response_storage") === true,
    };
  }

  // Resolves which stored provider the live table corresponds to, adopting the
  // live table as a new entry when nothing matches. Adoption is derived on the
  // read path and never written here: opening the page must not rewrite the
  // user's files.
  function resolve({ document, auth, store }) {
    const providers = {};
    for (const [id, provider] of Object.entries(store.providers)) providers[id] = { ...provider };
    const live = liveTable(document, store.ownedProviderId);
    const settings = readSettings(document);
    if (!live || !live.baseUrl) {
      return { providers, activeProviderId: "", adoptedProviderId: "", live, settings };
    }

    const candidates = Object.keys(providers).filter((id) => providers[id].baseUrl === live.baseUrl);
    let activeProviderId = candidates.includes(store.activeProviderId) ? store.activeProviderId : candidates[0] || "";
    let adoptedProviderId = "";

    if (!activeProviderId) {
      adoptedProviderId = uniqueId(profileSlug(live.name) || store.ownedProviderId, providers);
      providers[adoptedProviderId] = {
        name: live.name || titleFromId(store.ownedProviderId),
        baseUrl: live.baseUrl,
        upstream: isLoopbackUrl(live.baseUrl) ? "bridge" : "direct",
        requiresAuth: live.requiresAuth,
        models: settings.model ? [{ id: settings.model, reasoningEffort: settings.reasoningEffort }] : [],
        defaultModelId: settings.model,
        credential:
          typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY !== ""
            ? { type: "api_key", key: auth.OPENAI_API_KEY }
            : null,
        adopted: true,
      };
      activeProviderId = adoptedProviderId;
    } else if (settings.model && !providers[activeProviderId].models.some((model) => model.id === settings.model)) {
      // config.toml points at a model the store never recorded. Show what Codex
      // will actually run rather than quietly contradicting the file.
      providers[activeProviderId] = {
        ...providers[activeProviderId],
        models: [
          ...providers[activeProviderId].models,
          { id: settings.model, reasoningEffort: settings.reasoningEffort },
        ],
      };
    }
    return { providers, activeProviderId, adoptedProviderId, live, settings };
  }

  function publicProvider(id, provider, activeProviderId) {
    return {
      id,
      name: provider.name || titleFromId(id),
      baseUrl: provider.baseUrl,
      upstream: provider.upstream,
      requiresAuth: provider.requiresAuth,
      models: provider.models.map((model) => ({ id: model.id, reasoningEffort: model.reasoningEffort })),
      defaultModelId: provider.defaultModelId,
      // The stored key never leaves this process. The browser learns only
      // whether one exists.
      credentialConfigured: Boolean(provider.credential?.key),
      adopted: provider.adopted === true,
      isActive: id === activeProviderId,
    };
  }

  function publicState() {
    const loaded = load();
    const { providers, activeProviderId, adoptedProviderId, settings } = resolve(loaded);
    const document = loaded.document;
    return {
      dir,
      dirSource,
      revision: revisionOf(loaded.files),
      configured: loaded.files.get(configPath) !== null,
      ownedProviderId: loaded.store.ownedProviderId,
      activeProviderId,
      adoptedProviderId,
      generateProfiles: loaded.store.generateProfiles,
      providers: Object.keys(providers)
        .sort()
        .map((id) => publicProvider(id, providers[id], activeProviderId)),
      settings,
      // Every settings value above is normalized, so a fallback is
      // indistinguishable from a stored value. Say which keys config.toml
      // actually carries.
      settingsPresent: [...TOP_LEVEL_KEYS, "disable_response_storage"].filter((key) => document.hasTopLevel(key)),
      wireApi: CODEX_WIRE_API,
      reasoningEfforts: CODEX_REASONING_EFFORTS,
    };
  }

  function profilePlan(store, provider) {
    if (!store.generateProfiles || !provider.defaultModelId) return [];
    const owned = store.ownedProviderId;
    const plan = [];
    const taken = new Set();
    const add = (name, model) => {
      let candidate = name;
      for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${name}-${suffix}`;
      taken.add(candidate);
      plan.push({ name: candidate, model });
    };
    const primary = provider.models.find((model) => model.id === provider.defaultModelId);
    if (primary) add(owned, primary);
    for (const model of provider.models) {
      if (model.id === provider.defaultModelId) continue;
      const slug = profileSlug(model.id);
      add(slug ? `${owned}-${slug}` : owned, model);
    }
    return plan;
  }

  // Writes `providerId` into config.toml as the manager-owned table and makes
  // it the active provider. Mutates `store` so the caller persists the same
  // decisions that were written to disk.
  function applyActive(document, store, providerId, { requireCredential = true } = {}) {
    const provider = store.providers[providerId];
    if (!provider) throw new Error("要启用的供应商不存在。");
    if (!provider.baseUrl) throw new Error("该供应商还没有填写 API 地址。");
    // Switching to a provider whose key we do not have would leave auth.json
    // holding the previous provider's key while config.toml points at this one.
    // Rewriting the table for the provider already in use has no such hazard.
    if (requireCredential && provider.requiresAuth && !provider.credential?.key) {
      throw new Error("该供应商需要 API Key，请先填写后再启用。");
    }
    const owned = store.ownedProviderId;

    document.replaceTable(`model_providers.${owned}`, {
      name: provider.name || titleFromId(providerId),
      base_url: provider.baseUrl,
      wire_api: CODEX_WIRE_API,
      requires_openai_auth: provider.requiresAuth,
    });
    document.setTopLevel("model_provider", owned);
    const primary = provider.models.find((model) => model.id === provider.defaultModelId);
    if (primary) {
      document.setTopLevel("model", primary.id);
      document.setTopLevel("model_reasoning_effort", primary.reasoningEffort);
    }

    // Remove exactly the profiles we generated last time, then rebuild.
    for (const name of store.generatedProfiles) document.removeTable(`profiles.${name}`);
    const plan = profilePlan(store, provider);
    for (const { name, model } of plan) {
      document.replaceTable(`profiles.${name}`, {
        model_provider: owned,
        model: model.id,
        model_reasoning_effort: model.reasoningEffort,
      });
    }
    store.generatedProfiles = plan.map((entry) => entry.name);
    store.activeProviderId = providerId;
    return provider;
  }

  function applyAuth(auth, provider) {
    // A provider that Codex will not authenticate has no business touching
    // auth.json — the user may have a ChatGPT login sitting in it. The same
    // goes for one we hold no key for: leave whatever is there.
    if (!provider.requiresAuth || !provider.credential?.key) return auth;
    return { ...auth, auth_mode: "apikey", OPENAI_API_KEY: provider.credential.key };
  }

  function needsAuthWrite(provider) {
    return provider.requiresAuth && Boolean(provider.credential?.key);
  }

  // All three files move together or not at all.
  function commit(revision, document, auth, store, writeAuth) {
    const rendered = document.render();
    // A round-trip through our own parser is the only self-check available
    // without adding a TOML dependency; it catches a serializer that produced
    // something we could not read back.
    TomlDocument.parse(rendered);
    const originals = stableSnapshots();
    if (revision !== revisionOf(originals)) {
      throw new ConflictError("Codex 配置在保存期间发生了变化。当前草稿尚未写入，请重新读取配置后再试。");
    }
    try {
      writeTextAtomic(configPath, rendered, (written) => TomlDocument.parse(written));
      if (writeAuth) writeJsonAtomic(authPath, auth);
      writeJsonAtomic(storePath, store);
    } catch (error) {
      for (const [filePath, bytes] of originals) restore(filePath, bytes);
      throw error;
    }
  }

  function validateProviderPayload(payload, store, providerId) {
    const name = String(payload.name || "").trim();
    if (!name) throw new Error("请填写供应商名称。");
    const baseUrl = normalizeUrl(payload.baseUrl);
    const upstream = payload.upstream === "bridge" ? "bridge" : "direct";
    if (upstream === "bridge" && !isLoopbackUrl(baseUrl)) {
      throw new Error("本地桥地址必须指向 127.0.0.1、localhost 或 [::1]。");
    }
    const requiresAuth = payload.requiresAuth !== false;
    const models = normalizeModels(payload.models);
    if (models.length === 0) throw new Error("至少添加一个模型。");
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      throw new Error("模型 ID 不能重复。");
    }
    const defaultModelId = String(payload.defaultModelId || "");
    if (!models.some((model) => model.id === defaultModelId)) {
      throw new Error("请选择一个模型作为该供应商的默认模型。");
    }

    const existing = store.providers[providerId];
    const credential = isObject(payload.credential) ? payload.credential : { mode: "keep" };
    let resolvedCredential = existing?.credential || null;
    if (credential.mode === "new") {
      const key = String(credential.apiKey || "").trim();
      if (!key) throw new Error("请输入 API Key。");
      resolvedCredential = { type: "api_key", key };
    } else if (credential.mode === "migrate") {
      const source = String(credential.fromProvider || "");
      // Object.hasOwn rather than truthiness: "__proto__" and friends resolve
      // through the prototype chain and would otherwise pass.
      if (!Object.hasOwn(store.providers, source) || !store.providers[source]?.credential?.key) {
        throw new Error("选择的已有凭据不存在。");
      }
      resolvedCredential = { ...store.providers[source].credential };
    }
    if (requiresAuth && !resolvedCredential?.key) {
      throw new Error("该供应商尚未配置凭据，请输入新 key 或从已有供应商迁移。");
    }

    return {
      name,
      baseUrl,
      upstream,
      requiresAuth,
      models,
      defaultModelId,
      credential: resolvedCredential,
    };
  }

  function saveProvider(payload) {
    if (!isObject(payload)) throw new Error("请求内容无效。");
    const revision = requireCurrentRevision(payload);
    const providerId = String(payload.providerId || "").trim();
    if (!CODEX_ID_PATTERN.test(providerId)) {
      throw new Error("供应商 ID 只能使用小写字母、数字、下划线和连字符。");
    }

    const loaded = load();
    const resolved = resolve(loaded);
    const store = loaded.store;
    // An adopted entry only exists in the read path until something writes it.
    // Persist it now so saving next to it does not make it disappear.
    for (const [id, provider] of Object.entries(resolved.providers)) {
      if (!store.providers[id]) store.providers[id] = { ...provider, adopted: undefined };
    }
    if (!store.activeProviderId) store.activeProviderId = resolved.activeProviderId;

    store.providers[providerId] = validateProviderPayload(payload, store, providerId);

    const shouldActivate = payload.setActive === true || store.activeProviderId === providerId;
    let writeAuth = false;
    if (shouldActivate) {
      const provider = applyActive(loaded.document, store, providerId);
      writeAuth = needsAuthWrite(provider);
      loaded.auth = applyAuth(loaded.auth, provider);
    }
    commit(revision, loaded.document, loaded.auth, store, writeAuth);
    return { providerId, activated: shouldActivate };
  }

  function activate(payload) {
    if (!isObject(payload)) throw new Error("请求内容无效。");
    const revision = requireCurrentRevision(payload);
    const providerId = String(payload.providerId || "").trim();
    const loaded = load();
    const resolved = resolve(loaded);
    const store = loaded.store;
    for (const [id, provider] of Object.entries(resolved.providers)) {
      if (!store.providers[id]) store.providers[id] = { ...provider, adopted: undefined };
    }
    if (!Object.hasOwn(store.providers, providerId)) throw new Error("要启用的供应商不存在。");

    const provider = applyActive(loaded.document, store, providerId);
    const auth = applyAuth(loaded.auth, provider);
    commit(revision, loaded.document, auth, store, needsAuthWrite(provider));
    return { providerId };
  }

  function deleteProvider(payload) {
    if (!isObject(payload)) throw new Error("请求内容无效。");
    const revision = requireCurrentRevision(payload);
    const providerId = String(payload.providerId || "").trim();
    const loaded = load();
    const resolved = resolve(loaded);
    const store = loaded.store;
    for (const [id, provider] of Object.entries(resolved.providers)) {
      if (!store.providers[id]) store.providers[id] = { ...provider, adopted: undefined };
    }
    if (!Object.hasOwn(store.providers, providerId)) throw new Error("要删除的供应商不存在。");

    let auth = loaded.auth;
    let writeAuth = false;
    const wasActive = resolved.activeProviderId === providerId;
    if (wasActive) {
      const replacementId = String(payload.replacementProviderId || "").trim();
      if (replacementId === providerId || !Object.hasOwn(store.providers, replacementId)) {
        throw new Error("删除当前生效的供应商前，请选择另一个已配置的供应商接替它。");
      }
      const provider = applyActive(loaded.document, store, replacementId);
      auth = applyAuth(auth, provider);
      writeAuth = needsAuthWrite(provider);
    }
    delete store.providers[providerId];
    if (store.activeProviderId === providerId) store.activeProviderId = "";
    commit(revision, loaded.document, auth, store, writeAuth);
    return { providerId, replacedActive: wasActive };
  }

  function saveSettings(payload) {
    if (!isObject(payload)) throw new Error("设置内容无效。");
    const revision = requireCurrentRevision(payload);
    const loaded = load();
    const resolved = resolve(loaded);
    const store = loaded.store;
    for (const [id, provider] of Object.entries(resolved.providers)) {
      if (!store.providers[id]) store.providers[id] = { ...provider, adopted: undefined };
    }
    store.activeProviderId = resolved.activeProviderId;

    const ownedProviderId = String(payload.ownedProviderId || store.ownedProviderId);
    if (!CODEX_ID_PATTERN.test(ownedProviderId)) {
      throw new Error("Codex 供应商表名只能使用小写字母、数字、下划线和连字符。");
    }
    if (CODEX_RESERVED_PROVIDER_IDS.has(ownedProviderId)) {
      throw new Error(`Codex 保留了内建供应商 ${ownedProviderId}，请换一个表名。`);
    }
    const renamed = ownedProviderId !== store.ownedProviderId;
    if (renamed) {
      loaded.document.removeTable(`model_providers.${store.ownedProviderId}`);
      for (const name of store.generatedProfiles) loaded.document.removeTable(`profiles.${name}`);
      store.generatedProfiles = [];
      store.ownedProviderId = ownedProviderId;
    }
    store.generateProfiles = payload.generateProfiles !== false;

    loaded.document.setTopLevel("model_reasoning_effort", normalizeEffort(payload.reasoningEffort, "medium"));
    loaded.document.setTopLevel(
      "plan_mode_reasoning_effort",
      normalizeEffort(payload.planModeReasoningEffort, "medium"),
    );
    loaded.document.setTopLevel(
      "model_verbosity",
      CODEX_VERBOSITIES.includes(payload.verbosity) ? payload.verbosity : "medium",
    );
    const contextWindow = Number(payload.contextWindow);
    if (Number.isSafeInteger(contextWindow) && contextWindow > 0 && contextWindow <= MAX_CONTEXT_WINDOW) {
      loaded.document.setTopLevel("model_context_window", contextWindow);
    } else if (!payload.contextWindow) {
      loaded.document.removeTopLevel("model_context_window");
    } else {
      throw new Error("上下文容量无效。");
    }
    // Removed from Codex's config schema, and `store` is hard-coded false in
    // current builds. Kept only so an existing file can retain it.
    if (payload.disableResponseStorage === true) loaded.document.setTopLevel("disable_response_storage", true);
    else loaded.document.removeTopLevel("disable_response_storage");

    let auth = loaded.auth;
    let writeAuth = false;
    const activeId = String(payload.activeProviderId || resolved.activeProviderId || "");
    if (activeId && Object.hasOwn(store.providers, activeId)) {
      // model_reasoning_effort is one key, and the active model owns it. Record
      // the submitted value on that model too, so rewriting the table below
      // writes the same number the user just chose rather than reverting it.
      const active = store.providers[activeId];
      const effort = normalizeEffort(payload.reasoningEffort, "medium");
      active.models = active.models.map((model) =>
        model.id === active.defaultModelId ? { ...model, reasoningEffort: effort } : model);
      const switching = activeId !== resolved.activeProviderId;
      const provider = applyActive(loaded.document, store, activeId, { requireCredential: switching });
      auth = applyAuth(auth, provider);
      writeAuth = switching && needsAuthWrite(provider);
    }
    commit(revision, loaded.document, auth, store, writeAuth);
  }

  return {
    paths: { dir, configPath, authPath, storePath },
    publicState,
    saveProvider,
    activate,
    deleteProvider,
    saveSettings,
  };
}
