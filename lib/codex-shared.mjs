// Codex vocabulary that both the server and the browser need.
//
// Deliberately free of node imports: lib/codex-config.mjs reaches the
// filesystem and so can never be bundled for the client, but the wizard has to
// offer the same reasoning efforts and derive the same profile names the server
// writes. Two copies of either would drift silently.

export const CODEX_WIRE_API = "responses";
export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_VERBOSITIES = ["low", "medium", "high"];
export const DEFAULT_REASONING_EFFORT = "high";
export const DEFAULT_OWNED_PROVIDER_ID = "custom";

// Built-in ids Codex refuses to let a user table override.
export const CODEX_RESERVED_PROVIDER_IDS = new Set([
  "openai",
  "ollama",
  "ollama-chat",
  "lmstudio",
  "amazon-bedrock",
  "amazon-bedrock-runtime",
]);

// No dots: the id becomes part of a [profiles.<id>-<model>] header, and a dot
// there would silently create a nested table instead of a flat profile.
export const CODEX_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// Model ids reduced to something usable as a bare TOML key and typeable after
// `codex --profile`.
export function profileSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
