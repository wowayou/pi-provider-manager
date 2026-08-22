// Codex vocabulary that both the server and the browser need.
//
// Deliberately free of node imports: lib/codex-config.mjs reaches the
// filesystem and so can never be bundled for the client, but the wizard has to
// offer the same reasoning efforts and slug ids the same way the server does.
// Two copies of either would drift silently.

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

// No dots: the id becomes the [model_providers.<id>] header, and a dot there
// would silently create a nested table instead of the flat one Codex looks for.
export const CODEX_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// Reduced to something usable as a bare TOML key.
export function idSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
