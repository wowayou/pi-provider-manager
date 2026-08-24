// Validation shared by the Pi and Codex sides.

// A write whose revision no longer matches the files on disk. Carries the
// HTTP status so the request layer does not have to classify it again.
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
  }
}

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function normalizeUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("请输入 API 地址。");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    // new URL throws a bare English TypeError, and "api.example.com/v1" without a
    // scheme is a very common way to land here.
    throw new Error("API 地址格式无效，请填写完整地址，例如 https://api.example.com/v1。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("API 地址必须使用 http 或 https。");
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("远程 API 地址必须使用 HTTPS，避免 key 明文传输。");
  }
  return normalized;
}

// A stored credential that is really a URL. Versions before 0.3.0 could write
// the upstream address into the bridge's key slot, and nothing downstream could
// tell: the bridge simply authenticated with a URL and the upstream answered
// 401, far from the cause. Deliberately narrow — only an http(s) scheme counts,
// because a real key must never be rejected. Keys containing a URL, or starting
// with anything else, are somebody else's format to judge, not ours.
export function looksLikeUrlNotKey(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

// Only these three names are the local machine. Matching on a prefix or suffix
// would accept `127.0.0.1.attacker.example`, and accepting an arbitrary numeric
// form would accept the many spellings of 127.0.0.1 that a hostile page could
// use to aim a local probe somewhere else.
export function isLoopbackHostname(hostname) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(hostname).toLowerCase());
}
