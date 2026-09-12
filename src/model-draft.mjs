export function changedPersistedModel(models) {
  return models.find((model) => {
    const persistedId = typeof model.persistedId === "string" ? model.persistedId : "";
    return persistedId && String(model.id || "").trim() !== persistedId;
  }) || null;
}

export function selectedNamedModel(models, defaultRowId) {
  return models.find((model) => model.rowId === defaultRowId && String(model.id || "").trim()) || null;
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

// Everything but the credential carries over: the stored key never returns to
// the browser, so a copy is born asking for a new one — which is the workflow
// a duplicate exists for (same models, different gateway and key).
export function duplicatePiForm(form, takenIds) {
  const models = form.models.map((model) => ({ ...model, rowId: crypto.randomUUID() }));
  const sourceDefault = form.models.find((model) => model.rowId === form.defaultRowId);
  return {
    ...form,
    providerId: suggestCopyId(form.providerId, takenIds),
    credentialMode: "new",
    apiKey: "",
    models,
    defaultRowId: (models.find((model) => model.id === sourceDefault?.id) || models[0]).rowId,
  };
}

export function duplicateCodexForm(form, takenIds) {
  const models = form.models.map((model) => ({ ...model, rowId: crypto.randomUUID() }));
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
