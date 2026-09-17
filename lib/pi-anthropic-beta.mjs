const KEY = "anthropic-beta";
const MAX_BYTES = 2048;
const MAX_ITEMS = 32;
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function byteLength(value) { return new TextEncoder().encode(value).length; }
export function normalizeAnthropicBeta(value) {
  if (typeof value !== "string") throw new Error("Anthropic Beta 请求头必须是文本。");
  if (byteLength(value) > MAX_BYTES || /[\u0000-\u001f\u007f-\u009f]/.test(value) || /[!$]/.test(value) || /[^\x00-\x7f]/.test(value)) throw new Error("Anthropic Beta 请求头格式无效。请使用不含动态表达式的 ASCII token 列表。");
  if (!value.trim()) return "";
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.length > MAX_ITEMS || tokens.some((token) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(token))) throw new Error("Anthropic Beta 请求头格式无效。请使用逗号分隔的 token 列表。");
  return [...new Set(tokens)].join(", ");
}
function headerKeys(headers) { if (headers === undefined) return []; if (!isObject(headers)) return null; return Object.keys(headers).filter((key) => key.toLowerCase() === KEY); }
export function readAnthropicBeta(headers) {
  const keys = headerKeys(headers);
  if (!keys) return { kind: "external" };
  if (keys.length === 0) return { kind: "none" };
  if (keys.length !== 1 || typeof headers[keys[0]] !== "string") return { kind: "external" };
  const raw = headers[keys[0]];
  if (!raw.trim() || /[!$]/.test(raw)) return { kind: "external" };
  try { return { kind: "literal", value: normalizeAnthropicBeta(raw) }; } catch { return { kind: "external" }; }
}
export function applyAnthropicBeta(headers, value) {
  if (headers !== undefined && !isObject(headers)) throw new Error("Pi 模型 headers 结构无效，无法安全修改 Anthropic Beta 请求头。");
  const next = isObject(headers) ? { ...headers } : {};
  for (const key of Object.keys(next)) if (key.toLowerCase() === KEY) delete next[key];
  const normalized = normalizeAnthropicBeta(value);
  if (normalized) next[KEY] = normalized;
  return Object.keys(next).length > 0 ? next : undefined;
}
