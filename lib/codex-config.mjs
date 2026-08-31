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

import path from "node:path";

import {
  isObject,
  parseJsonBytes,
  writeJsonAtomic,
  writeTextAtomic,
} from "./atomic-files.mjs";
import {
  CODEX_ID_PATTERN,
  CODEX_REASONING_EFFORTS,
  CODEX_RESERVED_PROVIDER_IDS,
  adoptableEffort,
  effortOptions,
  CODEX_VERBOSITIES,
  CODEX_WIRE_API,
  DEFAULT_OWNED_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  idSlug,
} from "./codex-shared.mjs";
import { DEFAULT_BRIDGE_PORT, bridgeBaseUrl } from "./litellm-bridge.mjs";
import { createFileGuard } from "./managed-files.mjs";
import { TomlDocument } from "./toml-document.mjs";
import { looksLikeUrlNotKey, normalizeUrl } from "./validation.mjs";

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

// What this manager offers. Anything else submitted falls back, because a value
// Codex rejects makes the whole config fail to load.
function normalizeEffort(value, fallback = DEFAULT_REASONING_EFFORT) {
  if (CODEX_REASONING_EFFORTS.includes(value)) return value;
  // A model-defined effort already stored by this manager stays: it came from a
  // config.toml we adopted, and Codex's ReasoningEffort accepts values this list
  // cannot enumerate.
  return adoptableEffort(value) ? value : fallback;
}

// Which effort to write. A submitted value we know is written; one we do not is
// written only when it is the value already in the file — the browser was shown
// that value and echoing it back is not a request to change anything. Otherwise
// whatever is on disk is left in place, since replacing an effort Codex accepts
// with our default would silently undo a setting we do not own.
function chooseEffort(submitted, onDisk, fallback) {
  if (CODEX_REASONING_EFFORTS.includes(submitted)) return submitted;
  if (adoptableEffort(submitted) && submitted === onDisk) return submitted;
  if (CODEX_REASONING_EFFORTS.includes(onDisk) || adoptableEffort(onDisk)) return onDisk;
  return fallback;
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
    requiresAuth: raw.requiresAuth !== false,
    models,
    defaultModelId,
    credential,
    bridge: normalizeBridge(raw.bridge),
  };
}

// A provider whose upstream only speaks Chat Completions reaches it through a
// LiteLLM proxy this manager configures. `baseUrl` then points at that proxy,
// and the upstream's own address and key live here.
function normalizeBridge(raw) {
  if (!isObject(raw) || typeof raw.upstreamBaseUrl !== "string" || raw.upstreamBaseUrl === "") return null;
  const port = Number.isSafeInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_BRIDGE_PORT;
  // A key that is really a URL was writable before 0.3.0. Treating it as no key
  // at all is what makes the mistake visible: the UI then asks for one, which is
  // the only thing that actually fixes it. Silently keeping it would start a
  // proxy that authenticates with an address.
  const storedKey =
    isObject(raw.credential) && typeof raw.credential.key === "string" ? raw.credential.key : "";
  const credential =
    storedKey !== "" && !looksLikeUrlNotKey(storedKey)
      ? { type: "api_key", key: storedKey }
      : null;
  const models = {};
  if (isObject(raw.models)) {
    for (const [id, upstreamId] of Object.entries(raw.models)) {
      if (typeof upstreamId === "string" && upstreamId.trim() !== "") models[id] = upstreamId.trim();
    }
  }
  return { upstreamBaseUrl: raw.upstreamBaseUrl, port, credential, models };
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
    // Profile tables written by v0.2.0/v0.2.1, kept only so the next save can
    // remove exactly those. Deleting by this list rather than by name prefix is
    // what keeps a hand-written profile that happens to share the prefix from
    // being swept away. Always empty once a save has run.
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

  const guard = createFileGuard({ paths: managedPaths, revisionKey, subject: "Codex 配置" });
  const { stableSnapshots, revisionOf, requireCurrentRevision } = guard;

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
      adoptedProviderId = uniqueId(idSlug(live.name) || store.ownedProviderId, providers);
      providers[adoptedProviderId] = {
        name: live.name || titleFromId(store.ownedProviderId),
        baseUrl: live.baseUrl,
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
      requiresAuth: provider.requiresAuth,
      models: provider.models.map((model) => ({ id: model.id, reasoningEffort: model.reasoningEffort })),
      defaultModelId: provider.defaultModelId,
      // The stored key never leaves this process. The browser learns only
      // whether one exists.
      credentialConfigured: Boolean(provider.credential?.key),
      // The upstream key is never serialized either; only whether one exists.
      bridge: provider.bridge
        ? {
            upstreamBaseUrl: provider.bridge.upstreamBaseUrl,
            port: provider.bridge.port,
            credentialConfigured: Boolean(provider.bridge.credential?.key),
            models: provider.bridge.models,
          }
        : null,
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
      providers: Object.keys(providers)
        .sort()
        .map((id) => publicProvider(id, providers[id], activeProviderId)),
      settings,
      // Every settings value above is normalized, so a fallback is
      // indistinguishable from a stored value. Say which keys config.toml
      // actually carries.
      settingsPresent: [...TOP_LEVEL_KEYS, "disable_response_storage"].filter((key) => document.hasTopLevel(key)),
      // Codex refuses to load the whole config when any provider table omits
      // `name`. This manager always writes one, but it preserves hand-written
      // tables byte for byte, and a broken one there takes Codex down with no
      // hint as to which table is at fault.
      providerTablesMissingName: document
        .tableNames("model_providers")
        .filter((id) => {
          const keys = document.tableKeys(`model_providers.${id}`);
          return typeof keys?.name !== "string" || keys.name.trim() === "";
        }),
      wireApi: CODEX_WIRE_API,
      // The known list, plus whatever this file is actually using: an adopted
      // effort has to be reportable or the browser cannot show it.
      reasoningEfforts: effortOptions(settings.reasoningEffort, settings.planModeReasoningEffort),
    };
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
    // v0.2.0 and v0.2.1 generated `[profiles.*]` tables here so that a second
    // model could be reached with `codex --profile`. Codex 0.149.0 treats those
    // as legacy and refuses the flag outright while a matching table is
    // present — "Error loading config.toml: --profile `x` cannot be used
    // while ... contains legacy ... [profiles.x]" — which broke exactly the
    // command this manager told people to run. Any save clears the ones it
    // wrote. Removal goes by the recorded list and never by name prefix, so a
    // profile the user wrote themselves survives untouched.
    for (const name of store.generatedProfiles) document.removeTable(`profiles.${name}`);
    store.generatedProfiles = [];
    const rendered = document.render();
    // A round-trip through our own parser is the only self-check available
    // without adding a TOML dependency; it catches a serializer that produced
    // something we could not read back.
    TomlDocument.parse(rendered);
    guard.writeAll(revision, () => {
      writeTextAtomic(configPath, rendered, (written) => TomlDocument.parse(written));
      if (writeAuth) writeJsonAtomic(authPath, auth);
      writeJsonAtomic(storePath, store);
    });
  }

  function validateProviderPayload(payload, store, providerId) {
    const name = String(payload.name || "").trim();
    if (!name) throw new Error("请填写供应商名称。");
    const existing = store.providers[providerId];
    const bridge = readBridgePayload(payload, existing);
    // With a bridge in front, Codex talks to the proxy on this machine and
    // carries no credential: the upstream key belongs to LiteLLM.
    const baseUrl = bridge ? bridgeBaseUrl(bridge.port) : normalizeUrl(payload.baseUrl);
    const requiresAuth = bridge ? false : payload.requiresAuth !== false;
    const models = normalizeModels(payload.models);
    if (models.length === 0) throw new Error("至少添加一个模型。");
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      throw new Error("模型 ID 不能重复。");
    }
    const defaultModelId = String(payload.defaultModelId || "");
    if (!models.some((model) => model.id === defaultModelId)) {
      throw new Error("请选择一个模型作为该供应商的默认模型。");
    }

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
      requiresAuth,
      models,
      defaultModelId,
      credential: resolvedCredential,
      bridge,
    };
  }

  function readBridgePayload(payload, existing) {
    if (!isObject(payload.bridge)) return null;
    const upstreamBaseUrl = normalizeUrl(payload.bridge.upstreamBaseUrl);
    const port = Number(payload.bridge.port) || existing?.bridge?.port || DEFAULT_BRIDGE_PORT;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("桥的端口无效。");
    let credential = existing?.bridge?.credential || null;
    const submitted = String(payload.bridge.apiKey || "").trim();
    if (submitted) credential = { type: "api_key", key: submitted };
    if (!credential?.key) throw new Error("请填写上游的 API Key —— 它由本地桥保管，不会写进 Codex 的配置。");
    // The two bridge fields sit next to each other in the form, and a URL in the
    // key slot is accepted by every layer below this one: the proxy starts, and
    // only the upstream's 401 hints at it. Refuse it where the mistake is still
    // attributable.
    if (looksLikeUrlNotKey(credential.key)) {
      throw new Error("上游 API Key 看起来是一个网址。请填写 key 本身，地址填在上面那一栏。");
    }
    const models = {};
    if (isObject(payload.bridge.models)) {
      for (const [id, upstreamId] of Object.entries(payload.bridge.models)) {
        if (typeof upstreamId === "string" && upstreamId.trim() !== "") models[id] = upstreamId.trim();
      }
    }
    return { upstreamBaseUrl, port, credential, models };
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
      store.ownedProviderId = ownedProviderId;
    }

    const effortOnDisk = loaded.document.getTopLevel("model_reasoning_effort");
    const planEffortOnDisk = loaded.document.getTopLevel("plan_mode_reasoning_effort");
    loaded.document.setTopLevel("model_reasoning_effort", chooseEffort(payload.reasoningEffort, effortOnDisk, "medium"));
    loaded.document.setTopLevel(
      "plan_mode_reasoning_effort",
      chooseEffort(payload.planModeReasoningEffort, planEffortOnDisk, "medium"),
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
      const effort = chooseEffort(payload.reasoningEffort, effortOnDisk, "medium");
      active.models = active.models.map((model) =>
        model.id === active.defaultModelId ? { ...model, reasoningEffort: effort } : model);
      const switching = activeId !== resolved.activeProviderId;
      const provider = applyActive(loaded.document, store, activeId, { requireCredential: switching });
      auth = applyAuth(auth, provider);
      writeAuth = switching && needsAuthWrite(provider);
    }
    commit(revision, loaded.document, auth, store, writeAuth);
  }

  // Server-side only: carries the upstream key, so it must never be reached
  // from a response body. It exists so the bridge runner can write LiteLLM's
  // config and start the process without the store leaking through the API.
  // Omit `providerId` for whichever provider is currently active. One read of
  // the three files answers both, so callers never have to ask twice.
  function bridgeSpec(providerId) {
    const loaded = load();
    const resolved = resolve(loaded);
    const id = providerId || resolved.activeProviderId;
    const provider = resolved.providers[id] || loaded.store.providers[id];
    if (!provider?.bridge) return null;
    return {
      providerId: id,
      upstreamBaseUrl: provider.bridge.upstreamBaseUrl,
      port: provider.bridge.port,
      upstreamKey: provider.bridge.credential?.key || "",
      models: provider.models.map((model) => ({ id: model.id, upstreamId: provider.bridge.models[model.id] })),
    };
  }

  return {
    paths: { dir, configPath, authPath, storePath },
    publicState,
    bridgeSpec,
    saveProvider,
    activate,
    deleteProvider,
    saveSettings,
  };
}
