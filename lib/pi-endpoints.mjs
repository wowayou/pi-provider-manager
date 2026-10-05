import { normalizeUrl } from "./validation.mjs";

// Native models.json model.baseUrl; an empty submitted value removes the
// override. URLs containing credentials or query data must never be read back
// as an editable field. Unmanaged values remain on disk when omitted.
export function normalizeModelBaseUrl(value) {
  if (typeof value !== "string") throw new Error("模型 API 地址必须是文本。");
  if (!value.trim()) return "";
  const normalized = normalizeUrl(value);
  const url = new URL(normalized);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("模型 API 地址只填写协议、主机与路径，不包含凭据、查询参数或片段。");
  }
  return normalized;
}

export function readModelBaseUrl(model) {
  if (!Object.hasOwn(model, "baseUrl")) return { kind: "none" };
  try {
    const value = normalizeModelBaseUrl(model.baseUrl);
    // An existing empty/invalid value is not the same as Pi's absent override.
    return value ? { kind: "literal", value: model.baseUrl } : { kind: "external" };
  } catch {
    return { kind: "external" };
  }
}

export function effectiveModelApi(model, providerApi) {
  return model.api && model.api !== "inherit" ? model.api : providerApi;
}

export function endpointHint(api) {
  if (api === "anthropic-messages") return "Anthropic 通常不带末尾 /v1；Pi 会追加 /v1/messages。网关若有 /anthropic 等前缀，请保留。";
  if (api === "openai-completions") return "OpenAI 通常需要末尾 /v1；Pi 只追加 /chat/completions。以网关文档为准。";
  if (api === "openai-responses") return "OpenAI 通常需要末尾 /v1；Pi 只追加 /responses。以网关文档为准。";
  return "填写网关提供的 Gemini 基础地址，包含其要求的版本路径。";
}

// A preview only, never an address normalizer. In particular, /v1 is neither
// inserted nor stripped: the SDK appends its resource path to the given base.
export function piRequestUrl(api, baseUrl) {
  const suffix = {
    "anthropic-messages": "/v1/messages",
    "openai-completions": "/chat/completions",
    "openai-responses": "/responses",
  }[api];
  if (!suffix) return "";
  try {
    const base = normalizeModelBaseUrl(baseUrl);
    return base ? `${base}${suffix}` : "";
  } catch {
    return "";
  }
}
