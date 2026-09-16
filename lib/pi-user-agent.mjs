// User-Agent is a provider-level compatibility setting. Keep the parser small
// and deliberately stricter than Pi's resolver: this editor only handles a
// literal value, and never evaluates a command or environment expression.

const USER_AGENT_KEY = "user-agent";
const MAX_USER_AGENT_BYTES = 512;

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function isUserAgentKey(key) {
  return typeof key === "string" && key.toLowerCase() === USER_AGENT_KEY;
}

function isHeaderObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateUserAgent(value) {
  if (typeof value !== "string") throw new Error("供应商 UA 必须是字符串。");
  if (byteLength(value) > MAX_USER_AGENT_BYTES) throw new Error("供应商 UA 最多 512 字节。");
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code > 0x7e) {
      throw new Error("供应商 UA 只能包含可打印 ASCII 字符，不能包含换行、制表符或中文。");
    }
  }
  if (value.includes("$")) throw new Error("供应商 UA 不能包含 $ 或动态表达式。");
  const normalized = value.trim();
  if (normalized.startsWith("!")) throw new Error("供应商 UA 不能以 ! 开头或执行命令。");
  return normalized;
}

export function readUserAgent(headers) {
  if (headers === undefined) return { kind: "none" };
  if (!isHeaderObject(headers)) return { kind: "external" };
  const entries = Object.entries(headers).filter(([key]) => isUserAgentKey(key));
  if (entries.length === 0) return { kind: "none" };
  if (entries.length !== 1 || typeof entries[0][1] !== "string") return { kind: "external" };
  try {
    const value = validateUserAgent(entries[0][1]);
    return value ? { kind: "literal", value } : { kind: "none" };
  } catch {
    return { kind: "external" };
  }
}

// `payload` is the complete provider save payload. Omitting userAgent is a
// preserve operation; an own property, including the empty string, is explicit.
// The original object is never mutated.
export function applyUserAgent(existing, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("供应商 UA 请求无效。");
  }
  if (!Object.hasOwn(payload, "userAgent")) return existing;
  const value = validateUserAgent(payload.userAgent);
  if (existing !== undefined && !isHeaderObject(existing)) {
    throw new Error("供应商 headers 结构无效，无法安全修改 UA。");
  }
  const next = { ...(existing || {}) };
  for (const key of Object.keys(next)) {
    if (isUserAgentKey(key)) delete next[key];
  }
  if (value) next["User-Agent"] = value;
  return Object.keys(next).length > 0 ? next : undefined;
}

export { MAX_USER_AGENT_BYTES };
