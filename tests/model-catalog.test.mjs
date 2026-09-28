import assert from "node:assert/strict";
import test from "node:test";

import { CONSERVATIVE, recommendedDefaults, seedModelLimits } from "../src/model-catalog.mjs";

test("distinguishes model generations instead of sharing one vendor-wide ceiling", () => {
  // The source ledger in docs/model-capacities.md is independent of these
  // assertions. In particular GPT-4.1 is not a 400k/128k GPT-5 variant.
  const cases = [
    ["gpt-4.1", 1_047_576, 32_768],
    ["gpt-4.1-mini", 1_047_576, 32_768],
    ["gpt-4.1-nano-2025-04-14", 1_047_576, 32_768],
    ["openai/gpt-4.1-2025-04-14", 1_047_576, 32_768],
    ["gpt-5.6-sol", 1_050_000, 128_000],
    ["gpt-5.4", 1_050_000, 128_000],
    ["gpt-5.1-codex", 400_000, 128_000],
    ["gpt-5", 400_000, 128_000],
    ["gpt-5-2025-08-07", 400_000, 128_000],
    ["o3", 200_000, 100_000],
    ["o4-mini", 200_000, 100_000],
    ["claude-3-5-sonnet-20241022", 200_000, 8_192],
    ["claude-3-5-haiku", 200_000, 8_192],
    ["claude-3-opus-20240229", 200_000, 4_096],
    ["claude-3-7-sonnet", 200_000, 64_000],
    ["claude-opus-4-1", 200_000, 32_000],
    ["claude-opus-4-20250514", 200_000, 32_000],
    ["claude-sonnet-4-5", 200_000, 64_000],
    ["claude-sonnet-4-6", 1_000_000, 128_000],
    ["claude-opus-4-8", 1_000_000, 128_000],
    ["claude-sonnet-5", 1_000_000, 128_000],
    ["gemini-2.0-flash", 1_048_576, 8_192],
    ["gemini-2.5-pro", 1_048_576, 65_536],
    ["gemini-3-pro-preview", 1_048_576, 65_536],
    ["deepseek-v4-pro", 1_000_000, 384_000],
    ["qwen3-max", 262_144, 65_536],
    ["glm-4.5", 131_072, 98_304],
    ["glm-4.7", 204_800, 131_072],
    ["MiniMax-M2.7", 204_800, 131_072],
    ["grok-4", 256_000, 64_000],
    ["grok-4-fast", 2_000_000, 30_000],
  ];
  for (const [id, contextWindow, maxTokens] of cases) {
    assert.deepEqual(recommendedDefaults(id), { contextWindow, maxTokens }, id);
  }
});

test("matches relay prefixes and suffixes without matching unrelated substrings or future generations", () => {
  assert.deepEqual(recommendedDefaults("OpenAI/GPT-5-Mini"), { contextWindow: 400_000, maxTokens: 128_000 });
  assert.deepEqual(recommendedDefaults("relay/Claude-OPUS-4-8:thinking"), { contextWindow: 1_000_000, maxTokens: 128_000 });
  assert.deepEqual(recommendedDefaults("claude-sonnet-4-5[1M]"), { contextWindow: 200_000, maxTokens: 64_000 }, "a tag must not imply a beta-enabled context");
  for (const id of ["consolidated/mystery", "not-claude-opus", "sol", "claude-opus-latest", "claude-opus-4-9", "gpt-5.99", "gpt-50", "qwen2.5-7b", "gemini-2.5-flash-image", "gemini-2.5-flash-preview-tts", "gpt-5-chat-latest"]) {
    assert.deepEqual(recommendedDefaults(id), recommendedDefaults(""), id);
  }
});

test("keeps unknown and conservative starting values distinct", () => {
  assert.deepEqual(recommendedDefaults("mystery-model"), { contextWindow: 128_000, maxTokens: 32_000 });
  assert.deepEqual(CONSERVATIVE, { contextWindow: 128_000, maxTokens: 16_384 });
  assert.deepEqual(recommendedDefaults(""), recommendedDefaults("   "));
});

test("uses learned pairs before gateway capacities and family defaults", () => {
  const hint = { contextWindow: 64000, maxTokens: 8192 };
  const discovered = { contextWindow: 200000, maxTokens: 32000 };
  assert.deepEqual(seedModelLimits("gpt-5", { hint, discovered }), hint);
  assert.deepEqual(seedModelLimits("gpt-5", { discovered }), discovered);
  assert.deepEqual(seedModelLimits("gpt-5"), recommendedDefaults("gpt-5"));
  assert.deepEqual(seedModelLimits("gpt-5", { discovered: { maxTokens: 8192 } }), { contextWindow: 400000, maxTokens: 8192 });
});

test("reconciles partial or conflicting metadata without increasing the gateway's context", () => {
  for (const discovered of [{ contextWindow: 8192 }, { contextWindow: 8192, maxTokens: 8192 }, { contextWindow: 8192, maxTokens: 100000 }]) {
    assert.deepEqual(seedModelLimits("gpt-5", { discovered }), { contextWindow: 8192, maxTokens: 4096 });
  }
  assert.deepEqual(seedModelLimits("gpt-5", { discovered: { contextWindow: 2 } }), { contextWindow: 2, maxTokens: 1 });
  for (const value of [1, 0, -1, "8192", 4.5, 100000001, Infinity, NaN]) {
    assert.deepEqual(seedModelLimits("gpt-5", { discovered: { contextWindow: value } }), recommendedDefaults("gpt-5"));
  }
  assert.deepEqual(seedModelLimits("gpt-5", { hint: { contextWindow: 10, maxTokens: 10 } }), recommendedDefaults("gpt-5"));
});
