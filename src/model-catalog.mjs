// Offline starting values for a known model generation. These are not proof of
// a relay's limits: saved gateway hints and discovery metadata take precedence.
// Verified generation sources and seeding policy: docs/model-capacities.md.
// No runtime dependency on Pi or a vendor's availability.
export const CONSERVATIVE = { contextWindow: 128_000, maxTokens: 16_384 };
const UNKNOWN = { contextWindow: 128_000, maxTokens: 32_000 };
const MAX_CAPACITY = 100_000_000;

// A relay prefix may precede the model, but a substring inside a different name
// (e.g. "sol" in "consolidated") is not a family. Dated snapshots and textual
// relay suffixes are allowed; an unrecognised numeric generation is not.
const family = (pattern, contextWindow, maxTokens) => ({
  test: new RegExp(`(?:^|[/.:])(?:${pattern})(?=$|[-_:](?:[a-z]|[0-9]{4}(?:[0-9]{4}|-[0-9]{2}-[0-9]{2})(?:\\D|$))|\\[)`, "i"),
  contextWindow,
  maxTokens,
});

const FAMILIES = [
  family("claude-3[-.]5-(?:sonnet|haiku)", 200_000, 8_192),
  family("claude-3[-.]7-sonnet", 200_000, 64_000),
  family("claude-3-(?:opus|sonnet|haiku)", 200_000, 4_096),
  family("claude-opus-4(?:[-.][01])?", 200_000, 32_000),
  family("claude-sonnet-4(?:[-.]0)?", 200_000, 64_000),
  family("claude-(?:opus|sonnet|haiku)-4[-.]5", 200_000, 64_000),
  family("claude-opus-4[-.][678]|claude-sonnet-4[-.]6", 1_000_000, 128_000),
  family("claude-opus-5(?:[-.]5)?|claude-sonnet-5|claude-fable-5(?:[-.]1)?", 1_000_000, 128_000),

  family("gpt-?4[.]1(?:-(?:mini|nano))?", 1_047_576, 32_768),
  family("gpt-?4o(?:-mini)?", 128_000, 16_384),
  family("gpt-?5[.]4(?:-pro)?|gpt-?5[.]6(?:-sol)?", 1_050_000, 128_000),
  family("gpt-?5(?:[.][12])?(?:-(?:mini|nano|pro|codex(?:-mini|-max)?))?", 400_000, 128_000),
  family("o3(?:-mini|-pro)?|o4-mini", 200_000, 100_000),

  family("gemini-2[.]0-flash(?:-lite)?", 1_048_576, 8_192),
  family("gemini-2[.]5-(?:pro|flash(?:-lite)?)|gemini-3(?:[.][15678])?-(?:pro|flash(?:-lite)?)", 1_048_576, 65_536),
  family("deepseek-flash|deepseek-v4(?:[.]1)?-(?:flash|pro)", 1_000_000, 384_000),
  family("qwen3-max", 262_144, 65_536),
  family("glm-4[.]5(?:-air|-flash)?", 131_072, 98_304),
  family("glm-4[.][67]", 204_800, 131_072),
  family("minimax-m2[.][17]", 204_800, 131_072),
  family("grok-4(?:-1)?-fast(?:-non-reasoning)?", 2_000_000, 30_000),
  family("grok-4", 256_000, 64_000),
];

export function recommendedDefaults(modelId = "") {
  const id = String(modelId || "").trim();
  // These variants do not share their text-chat family's limits.
  if (!/(?:^|[-_])(?:image|live|audio|tts|chat)(?:[-_:]|$)/i.test(id)) {
    for (const entry of FAMILIES) {
      if (entry.test.test(id)) return { contextWindow: entry.contextWindow, maxTokens: entry.maxTokens };
    }
  }
  return { ...UNKNOWN };
}

const validCapacity = (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_CAPACITY;

// One rule for typed IDs, bulk paste and discovery. A learned pair is deliberate
// and already saveable. A partial gateway answer can make a family fallback too
// large, so use a conservative output that leaves at least half the context for
// input, without inflating the reported context. A one-token context cannot
// hold any positive output and is unusable metadata.
export function seedModelLimits(modelId, { hint, discovered } = {}) {
  if (validCapacity(hint?.contextWindow) && validCapacity(hint?.maxTokens) && hint.maxTokens < hint.contextWindow) {
    return { contextWindow: hint.contextWindow, maxTokens: hint.maxTokens };
  }
  const base = recommendedDefaults(modelId);
  const contextWindow = validCapacity(discovered?.contextWindow) && discovered.contextWindow > 1
    ? discovered.contextWindow : base.contextWindow;
  const maxTokens = validCapacity(discovered?.maxTokens) ? discovered.maxTokens : base.maxTokens;
  return {
    contextWindow,
    maxTokens: maxTokens < contextWindow ? maxTokens : Math.min(CONSERVATIVE.maxTokens, Math.floor(contextWindow / 2)),
  };
}
