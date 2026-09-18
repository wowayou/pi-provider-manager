// Reads a gateway's model catalogue so the user can pick IDs instead of typing
// them (the "获取模型" affordance CC Switch users know). This module is the
// pure part — which URL to ask, with which headers, and how to read the answer —
// so it can be tested without a network. server.mjs owns the request itself.
//
// The URL mirrors what Pi does with the same baseUrl, so a listing that works
// here is evidence the chat endpoint will resolve too: Pi hands an Anthropic
// baseUrl to the Anthropic SDK, which appends `/v1/messages`, whereas the OpenAI
// SDK and Google client treat the baseUrl as already carrying its version path.

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

export function discoveryRequest(api, baseUrl, key) {
  const root = normalizeUrl(baseUrl);
  const credential = String(key || "");
  if (!credential) throw new Error("获取模型列表需要一个 API Key。");
  if (api === "anthropic-messages") {
    // Bearer, not `x-api-key`, whatever the key looks like. Pi chooses between
    // the two for the chat endpoint, but a listing is aimed at relays, and the
    // relays this is for (Anyrouter, NewAPI) answer `x-api-key` on /v1/models
    // with 401 "未提供令牌" while accepting Bearer — measured against
    // anyrouter.top. Anthropic's own API accepts Bearer as well.
    return {
      url: `${root}/v1/models?limit=1000`,
      headers: { authorization: `Bearer ${credential}`, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" },
    };
  }
  if (api === "google-generative-ai") {
    return { url: `${root}/models?pageSize=1000`, headers: { "x-goog-api-key": credential, accept: "application/json" } };
  }
  if (api === "openai-responses" || api === "openai-completions") {
    return { url: `${root}/models`, headers: { authorization: `Bearer ${credential}`, accept: "application/json" } };
  }
  throw new Error("请选择受支持的接口协议。");
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
