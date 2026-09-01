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
