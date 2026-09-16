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
  const models = form.models.map((model) => ({ ...model, rowId: freshRowId(), persistedId: "" }));
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
