export function changedPersistedModel(models) {
  return models.find((model) => {
    const persistedId = typeof model.persistedId === "string" ? model.persistedId : "";
    return persistedId && String(model.id || "").trim() !== persistedId;
  }) || null;
}

export function selectedNamedModel(models, defaultRowId) {
  return models.find((model) => model.rowId === defaultRowId && String(model.id || "").trim()) || null;
}

// An untouched UA means "preserve this provider" only while the draft still
// names the provider it was read from. Once its ID changes, the value belongs
// to the new target: safe literal/none states are explicit, while an external
// source value is not copied. A pre-existing target may keep its own external
// value; a new target gets an explicit clear instead of inheriting ambiguity.
export function userAgentSaveIntent(form, sourceProviderId, targetExists) {
  if (form.userAgentEdited) return { write: true, value: form.userAgent };
  const targetId = String(form.providerId || "").trim();
  // A new draft owns an explicit none state. Omitting the field here would preserve an old UA while the form says none.
  if (!sourceProviderId) return { write: true, value: form.userAgent || "" };
  if (targetId === sourceProviderId) return { write: false };
  if (form.userAgentKind === "external") return targetExists ? { write: false } : { write: true, value: "" };
  return { write: true, value: form.userAgent || "" };
}

// Model-level beta follows the source provider/model identity and target model.
export function anthropicBetaSaveIntent(model, sourceProviderId, targetProviderId, targetModelExists) {
  if (model.anthropicBetaEdited) return { write: true, value: model.anthropicBeta || "" };
  const sourceId = String(sourceProviderId || "").trim();
  const targetId = String(targetProviderId || "").trim();
  if (sourceId && targetId === sourceId && model.persistedId === model.id?.trim()) return { write: false };
  if (model.anthropicBetaKind === "external") return targetModelExists ? { write: false } : { write: true, value: "" };
  return { write: true, value: model.anthropicBeta || "" };
}
// A duplicated provider saves as a new row, so the draft needs an ID that is
// free: `<source>-copy`, then `-copy-2`, `-copy-3`, …
export function suggestCopyId(sourceId, takenIds) {
  const base = `${sourceId}-copy`;
  if (!takenIds.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!takenIds.includes(candidate)) return candidate;
  }
}

// Row keys only have to be unique for the life of the draft. Browsers have
// WebCrypto's randomUUID; Node 18, where the unit tests run, has no global
// crypto, so it falls back to a timestamp-and-random key.
function freshRowId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Everything but the credential carries over: the stored key never returns to
// the browser, so a copy is born asking for a new one — which is the workflow
// a duplicate exists for (same models, different gateway and key).
export function duplicatePiForm(form, takenIds) {
  // persistedId is storage identity, and a copy has none: every row is new to
  // disk. Carrying it over would mark the copy's IDs read-only and make the
  // identity-drift check refuse a draft that has drifted from nothing.
  let copiedExternalBeta = false;
  const models = form.models.map((model) => {
    const externalBeta = model.anthropicBetaKind === "external";
    copiedExternalBeta ||= externalBeta;
    return {
      ...model,
      rowId: freshRowId(),
      persistedId: "",
      anthropicBeta: externalBeta ? "" : (model.anthropicBeta || ""),
      anthropicBetaKind: externalBeta ? "none" : (model.anthropicBetaKind || "none"),
      anthropicBetaEdited: true,
    };
  });
  const sourceDefault = form.models.find((model) => model.rowId === form.defaultRowId);
  const sourceUserAgentKind = form.userAgentKind || (form.userAgent ? "literal" : "none");
  const canCopyUserAgent = sourceUserAgentKind === "literal" || sourceUserAgentKind === "none";
  return {
    ...form,
    providerId: suggestCopyId(form.providerId, takenIds),
    credentialMode: "new",
    apiKey: "",
    // Reusing an existing credential must not move it: the source provider is
    // still there and still needs its key.
    moveCredential: false,
    models,
    defaultRowId: (models.find((model) => model.id === sourceDefault?.id) || models[0]).rowId,
    // A copy is a new provider, so its UA intent must be explicit. Dynamic or
    // ambiguous source values stay out of the draft and ask the user to fill
    // them again rather than copying an expression we cannot inspect safely.
    userAgent: canCopyUserAgent && sourceUserAgentKind === "literal" ? form.userAgent : "",
    userAgentKind: canCopyUserAgent && sourceUserAgentKind === "literal" ? "literal" : "none",
    userAgentEdited: canCopyUserAgent,
    hasModelUserAgentOverride: Boolean(form.hasModelUserAgentOverride),
    copiedExternalUserAgent: sourceUserAgentKind === "external",
    copiedExternalBeta,
  };
}

// The advanced "配置 JSON" editor works on the draft, not on disk: it renders the
// credential-free provider fields as JSON, and maps an edited copy back into the
// form so the normal Save path — with its default-model check, identity-drift
// guard, and the server's revision/409 — still runs. The credential and the
// provider ID are deliberately absent: the ID is storage identity owned by step
// two, and the key never travels to the browser at all.
const PI_THINKING_VALUES = new Set(["off", "on", "xhigh", "max"]);

export function piFormToConfigJson(form) {
  const models = form.models.filter((model) => String(model.id || "").trim()).map((model) => {
    const entry = {
      id: String(model.id).trim(),
      name: model.name || String(model.id).trim(),
      contextWindow: Number(model.contextWindow),
      maxTokens: Number(model.maxTokens),
      supportsImages: Boolean(model.supportsImages),
      thinking: PI_THINKING_VALUES.has(model.maximumThinking) ? model.maximumThinking : "on",
      api: model.api || "inherit",
    };
    if (model.forceAdaptiveThinking) entry.forceAdaptiveThinking = true;
    // Only a literal override is shown. An external value is never surfaced
    // (the app never brings it back to the browser), and "none" is the default.
    if (model.anthropicBetaKind === "literal" && model.anthropicBeta) entry.anthropicBeta = model.anthropicBeta;
    return entry;
  });
  return JSON.stringify(
    { baseUrl: form.baseUrl || "", api: form.api || "openai-responses", compat: form.compat || {}, models },
    null,
    2,
  );
}

export function piConfigJsonToForm(parsed, form) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置必须是一个 JSON 对象。");
  }
  const rawModels = Array.isArray(parsed.models) ? parsed.models : null;
  if (!rawModels || rawModels.length === 0) {
    throw new Error("models 必须是至少包含一个模型的数组。");
  }
  const byId = new Map(form.models.map((model) => [String(model.id || "").trim(), model]));
  const usedRowIds = new Set();
  const seenIds = new Set();
  const models = rawModels.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`第 ${index + 1} 个模型不是对象。`);
    }
    const id = String(raw.id || "").trim();
    if (!id) throw new Error(`第 ${index + 1} 个模型缺少 id。`);
    if (seenIds.has(id)) throw new Error(`模型 ID 重复：${id}。`);
    seenIds.add(id);
    // Reuse the matching row's rowId and persistedId so the draft's identity
    // tracking survives a round trip: a model kept under the same ID keeps its
    // storage identity, and the drift check still sees an unchanged persistedId.
    const prior = byId.get(id);
    const rowId = prior && !usedRowIds.has(prior.rowId) ? prior.rowId : freshRowId();
    if (prior) usedRowIds.add(prior.rowId);
    const contextWindow = Number(raw.contextWindow);
    const maxTokens = Number(raw.maxTokens);
    let anthropicBeta = prior?.anthropicBeta || "";
    let anthropicBetaKind = prior?.anthropicBetaKind || "none";
    let anthropicBetaEdited = prior ? Boolean(prior.anthropicBetaEdited) : false;
    // Omission preserves whatever the row carried (including an external value);
    // an explicit string sets a literal override, an empty string clears it.
    if (Object.hasOwn(raw, "anthropicBeta")) {
      const value = String(raw.anthropicBeta || "");
      anthropicBeta = value;
      anthropicBetaKind = value ? "literal" : "none";
      anthropicBetaEdited = true;
    }
    return {
      rowId,
      persistedId: prior ? prior.persistedId : "",
      id,
      name: raw.name ? String(raw.name) : id,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : (prior?.contextWindow || 128000),
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : (prior?.maxTokens || 16384),
      supportsImages: Object.hasOwn(raw, "supportsImages") ? Boolean(raw.supportsImages) : Boolean(prior?.supportsImages),
      maximumThinking: PI_THINKING_VALUES.has(raw.thinking) ? raw.thinking : (prior?.maximumThinking || "on"),
      api: typeof raw.api === "string" ? raw.api : (prior?.api || "inherit"),
      forceAdaptiveThinking: Object.hasOwn(raw, "forceAdaptiveThinking") ? Boolean(raw.forceAdaptiveThinking) : Boolean(prior?.forceAdaptiveThinking),
      anthropicBeta,
      anthropicBetaKind,
      anthropicBetaEdited,
    };
  });
  // Keep the default on the same model ID it was on, when that ID survives.
  const previousDefaultId = form.models.find((model) => model.rowId === form.defaultRowId)?.id.trim();
  const defaultRow = models.find((model) => model.id === previousDefaultId) || models[0];
  return {
    ...form,
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : form.baseUrl,
    api: typeof parsed.api === "string" ? parsed.api : form.api,
    compat: parsed.compat && typeof parsed.compat === "object" && !Array.isArray(parsed.compat) ? parsed.compat : (form.compat || {}),
    models,
    defaultRowId: defaultRow.rowId,
  };
}

export function duplicateCodexForm(form, takenIds) {
  const models = form.models.map((model) => ({ ...model, rowId: freshRowId() }));
  const sourceDefault = form.models.find((model) => model.rowId === form.defaultRowId);
  return {
    ...form,
    providerId: suggestCopyId(form.providerId, takenIds),
    credentialMode: "new",
    apiKey: "",
    // The bridge's upstream address is configuration and carries over; the
    // bridge's held key is a secret and does not, for the same reason.
    bridgeApiKey: "",
    models,
    defaultRowId: (models.find((model) => model.id === sourceDefault?.id) || models[0]).rowId,
  };
}
