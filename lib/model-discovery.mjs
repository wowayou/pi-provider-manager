// Reads a gateway's model catalogue so the user can pick IDs instead of typing
// them (the "获取模型" affordance CC Switch users know). This module is the
// pure part — which URL to ask, with which headers, and how to read the answer —
// so it can be tested without a network. server.mjs owns the request itself.
//
// The default URL mirrors what Pi does with the same baseUrl, so a listing that
// works is evidence the chat endpoint will resolve too: Pi hands an Anthropic
// baseUrl to the Anthropic SDK, which appends `/v1/messages`, whereas the OpenAI
// SDK and Google client treat the baseUrl as already carrying its version path.
//
// Relays do not agree on where a catalogue lives, so the path is overridable. An
// override is resolved *against the baseUrl* and must stay on its origin: this
// request carries a stored credential, so a path that could change host, port or
// scheme would turn the feature into a way to send someone's key elsewhere.

import { normalizeUrl } from "./validation.mjs";

export const ANTHROPIC_VERSION = "2023-06-01";
export const MAX_MODELS = 2000;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 160;
// A model ID is an opaque gateway token, but a control character or whitespace
// inside one is never real: it would be a header-injection or a display bug.
const ID_PATTERN = /^[\x21-\x7e]+$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// What each protocol asks for when the user has not said otherwise. Exported so
// the browser can show it as the placeholder rather than keeping a second copy.
export function defaultDiscoveryPath(api) {
  if (api === "anthropic-messages") return "/v1/models?limit=1000";
  if (api === "google-generative-ai") return "/models?pageSize=1000";
  if (api === "openai-responses" || api === "openai-completions") return "/models";
  throw new Error("请选择受支持的接口协议。");
}

// Resolves an override against the gateway root and refuses anything that would
// send the credential to a different origin. Standard `new URL(path, root)`
// semantics do the work: an absolute URL, a protocol-relative "//host", userinfo
// and a different port all resolve to something whose origin we can compare,
// which is safer than pattern-matching the string ourselves. Nothing is stripped
// first — silently turning "//host/x" into a path segment would accept a string
// the user clearly meant as a host and answer it with a 404 instead of a reason.
//
// Same origin is the whole boundary, deliberately. The path is *not* required to
// sit under the baseUrl: relays routinely serve the catalogue outside the chat
// prefix (a provider on `https://api.deepseek.com/anthropic` lists at `/models`),
// and a prefix rule would refuse a real layout while protecting nothing — the
// host is already the one every chat request hands this same key to.
export function resolveDiscoveryUrl(root, path) {
  // Trimmed first: a value pasted from documentation often carries a trailing
  // newline, and that is a typo to absorb rather than an attack to report.
  const candidate = String(path || "").trim();
  if (!candidate) throw new Error("模型列表路径不能为空。");
  if (/[\s\u0000-\u001f\u007f]/.test(candidate)) throw new Error("模型列表路径不能包含空白或控制字符。");
  // The trailing slash makes the root a directory, so "models" resolves under it
  // rather than replacing its last segment.
  const base = new URL(`${root}/`);
  let resolved;
  try {
    resolved = new URL(candidate, base);
  } catch {
    throw new Error("模型列表路径无效。请填写相对路径，例如 /v1/models。");
  }
  if (resolved.origin !== base.origin || resolved.username || resolved.password) {
    throw new Error("模型列表路径必须与 API 地址同源，不能指向其他主机。为避免凭据被发往别处，已拒绝。");
  }
  return resolved.toString();
}

function discoveryHeaders(api, credential) {
  if (api === "anthropic-messages") {
    return { authorization: `Bearer ${credential}`, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" };
  }
  if (api === "google-generative-ai") return { "x-goog-api-key": credential, accept: "application/json" };
  if (api === "openai-responses" || api === "openai-completions") {
    return { authorization: `Bearer ${credential}`, accept: "application/json" };
  }
  throw new Error("请选择受支持的接口协议。");
}

export function discoveryRequest(api, baseUrl, key, path = "") {
  const root = normalizeUrl(baseUrl);
  const credential = String(key || "");
  if (!credential) throw new Error("获取模型列表需要一个 API Key。");
  // Order matters: the protocol is validated by discoveryHeaders before an
  // override is resolved, so an unsupported api is one error rather than two.
  const headers = discoveryHeaders(api, credential);
  const custom = String(path || "").trim();
  const url = custom ? resolveDiscoveryUrl(root, custom) : `${root}${defaultDiscoveryPath(api)}`;
  return { url, headers };
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NAME_LENGTH);
}

// Accepts the three list shapes in the wild — OpenAI/Anthropic `{ data: [...] }`,
// Google `{ models: [{ name: "models/…" }] }`, and a bare array some gateways
// return — and reduces each entry to an ID and an optional display name. Nothing
// else from the body reaches the browser.
export function parseModelList(body) {
  const items = Array.isArray(body) ? body
    : isObject(body) && Array.isArray(body.data) ? body.data
      : isObject(body) && Array.isArray(body.models) ? body.models
        : null;
  if (!items) throw new Error("网关返回的内容不是模型列表。请手动填写模型 ID。");
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const raw = isObject(item) ? (typeof item.id === "string" ? item.id : item.name) : item;
    if (typeof raw !== "string") continue;
    const id = raw.trim().replace(/^models\//, "");
    if (!id || id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = isObject(item) ? cleanName(item.display_name ?? item.displayName ?? "") : "";
    models.push(name && name !== id ? { id, name } : { id });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

// The message for a status the gateway answered with. The key is never part of
// it, and neither is the body: a gateway's error page is not ours to relay.
export function describeDiscoveryStatus(status) {
  if (status === 401 || status === 403) return `网关拒绝了这个凭据（HTTP ${status}）。请检查 key 是否正确、是否有权访问模型列表。`;
  if (status === 404) return "网关没有提供模型列表接口（HTTP 404）。请手动填写模型 ID。";
  if (status >= 300 && status < 400) return `网关对模型列表接口返回了重定向（HTTP ${status}）。为避免凭据被转发，已停止；请填写最终地址。`;
  return `网关返回 HTTP ${status}，没有拿到模型列表。`;
}
