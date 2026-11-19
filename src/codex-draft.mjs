import { titleFromId } from "./model-draft.mjs";

export function blankCodexModel(id = "") {
  return { rowId: crypto.randomUUID(), id, reasoningEffort: "high" };
}

export function blankCodexForm() {
  const first = blankCodexModel("gpt-5.6-sol");
  return {
    providerId: "",
    name: "",
    baseUrl: "",
    upstream: "direct",
    requiresAuth: true,
    credentialMode: "new",
    apiKey: "",
    migrateFrom: "",
    // Filled in only when step one picks the chat/completions path: the
    // upstream's own address and key, which the local bridge will hold.
    bridgeUpstreamUrl: "",
    bridgeApiKey: "",
    models: [first],
    // Keyed by row rather than by model id, for the same reason as the Pi side:
    // the id is editable and keying on it drops the default on a typo fix.
    defaultRowId: first.rowId,
  };
}

export function codexProviderToForm(provider, codex) {
  const models = provider.models.length
    ? provider.models.map((model) => ({
        rowId: crypto.randomUUID(),
        id: model.id,
        reasoningEffort: model.reasoningEffort || "high",
      }))
    : [blankCodexModel()];
  const sources = codex.providers.filter((item) => item.id !== provider.id && item.credentialConfigured);
  return {
    providerId: provider.id,
    name: provider.name || titleFromId(provider.id),
    baseUrl: provider.baseUrl,
    // Only used to highlight a card in step one. The address is the sole
    // evidence available for a provider that came from config.toml.
    upstream: provider.bridge ? "bridge" : "direct",
    requiresAuth: provider.requiresAuth !== false,
    credentialMode: provider.credentialConfigured ? "keep" : "new",
    apiKey: "",
    migrateFrom: sources[0]?.id || "",
    bridgeUpstreamUrl: provider.bridge?.upstreamBaseUrl || "",
    bridgeApiKey: "",
    models,
    defaultRowId: (models.find((model) => model.id === provider.defaultModelId) || models[0]).rowId,
  };
}
