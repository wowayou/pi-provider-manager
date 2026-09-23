// Codex vocabulary that both the server and the browser need.
//
// Deliberately free of node imports: lib/codex-config.mjs reaches the
// filesystem and so can never be bundled for the client, but the wizard has to
// offer the same reasoning efforts and slug ids the same way the server does.
// Two copies of either would drift silently.

export const CODEX_WIRE_API = "responses";
// Codex 0.151.0's ReasoningEffort, in its order. `persistent` arrived after
// 0.149.0; the enum also carries a Custom(String) variant for efforts a model
// defines and the client does not know, which is why an unrecognised value in
// config.toml is kept rather than corrected — see adoptableEffort.
export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];
export const CODEX_VERBOSITIES = ["low", "medium", "high"];
export const DEFAULT_REASONING_EFFORT = "high";
export const DEFAULT_OWNED_PROVIDER_ID = "custom";

// An effort this manager does not know but Codex may: its ReasoningEffort has a
// Custom(String) variant, so the list above is what we can offer, never what
// Codex will accept. A value shaped like one of these is left alone instead of
// being rewritten to a default, because rewriting it would silently undo a Codex
// setting the user made — the same rule the rest of the file follows for keys we
// do not own. The shape is deliberately narrow: it is written back into
// config.toml, so it stays a plain lowercase identifier.
const CUSTOM_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

export function adoptableEffort(value) {
  return typeof value === "string" && !CODEX_REASONING_EFFORTS.includes(value) && CUSTOM_EFFORT.test(value);
}

// The efforts a control should offer: the ones we know, plus whatever is
// currently in force. Without the second part a select cannot even display an
// adopted value, and the first change would drop it.
export function effortOptions(...current) {
  const options = [...CODEX_REASONING_EFFORTS];
  for (const value of current) if (adoptableEffort(value)) options.push(value);
  return options;
}

// Built-in ids Codex refuses to let a user table override.
export const CODEX_RESERVED_PROVIDER_IDS = new Set([
  "openai",
  "ollama",
  "ollama-chat",
  "lmstudio",
  "amazon-bedrock",
  "amazon-bedrock-runtime",
]);

// No dots: the id becomes the [model_providers.<id>] header, and a dot there
// would silently create a nested table instead of the flat one Codex looks for.
export const CODEX_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// Reduced to something usable as a bare TOML key.
export function idSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Row keys only have to be unique for the life of the draft; Node's test
// environment has no global crypto before 19, so fall back to a timestamp key.
function codexRowId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// The Codex "配置 JSON" editor, mirroring the Pi one but in Codex's own
// vocabulary: name, the address, whether Codex authenticates, and the model
// list with per-model reasoning effort. The credential never appears — a
// direct provider's key and a bridge's upstream key both stay out — and
// applying it maps back into the draft so the normal Save still runs its
// checks. Lives here rather than in the browser view so it shares the effort
// list with the server and can be unit-tested without a JSX transform.
const CODEX_JSON_EFFORTS = new Set(CODEX_REASONING_EFFORTS);

export function codexFormToConfigJson(form) {
  const isBridge = form.upstream === "bridge";
  const config = { name: form.name || "" };
  if (isBridge) {
    config.upstreamBaseUrl = form.bridgeUpstreamUrl || "";
  } else {
    config.baseUrl = form.baseUrl || "";
    config.requiresAuth = form.requiresAuth !== false;
  }
  config.models = form.models
    .filter((model) => String(model.id || "").trim())
    .map((model) => ({ id: String(model.id).trim(), reasoningEffort: model.reasoningEffort || "high" }));
  return JSON.stringify(config, null, 2);
}

export function codexConfigJsonToForm(parsed, form) {
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
    const prior = byId.get(id);
    const rowId = prior && !usedRowIds.has(prior.rowId) ? prior.rowId : codexRowId();
    if (prior) usedRowIds.add(prior.rowId);
    const effort = CODEX_JSON_EFFORTS.has(raw.reasoningEffort) ? raw.reasoningEffort : (prior?.reasoningEffort || "high");
    return { rowId, id, reasoningEffort: effort };
  });
  const isBridge = form.upstream === "bridge";
  const previousDefaultId = form.models.find((model) => model.rowId === form.defaultRowId)?.id.trim();
  const defaultRow = models.find((model) => model.id === previousDefaultId) || models[0];
  return {
    ...form,
    name: typeof parsed.name === "string" ? parsed.name : form.name,
    baseUrl: !isBridge && typeof parsed.baseUrl === "string" ? parsed.baseUrl : form.baseUrl,
    bridgeUpstreamUrl: isBridge && typeof parsed.upstreamBaseUrl === "string" ? parsed.upstreamBaseUrl : form.bridgeUpstreamUrl,
    requiresAuth: !isBridge && typeof parsed.requiresAuth === "boolean" ? parsed.requiresAuth : form.requiresAuth,
    models,
    defaultRowId: defaultRow.rowId,
  };
}
