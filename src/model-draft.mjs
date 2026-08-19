export function changedPersistedModel(models) {
  return models.find((model) => {
    const persistedId = typeof model.persistedId === "string" ? model.persistedId : "";
    return persistedId && String(model.id || "").trim() !== persistedId;
  }) || null;
}

export function selectedNamedModel(models, defaultRowId) {
  return models.find((model) => model.rowId === defaultRowId && String(model.id || "").trim()) || null;
}
