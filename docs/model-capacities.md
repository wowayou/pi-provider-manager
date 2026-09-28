# Model capacity seeds

`src/model-catalog.mjs` supplies offline starting values for new Pi model rows.
These values do not establish what a particular gateway accepts. Reading a page
does not fetch vendor documentation or import Pi's model catalogue at runtime.

## Generation checks — 2026-09-28

The OpenAI generation split was checked against the actual official model pages,
including the separate GPT-4.1 mini/nano pages. Values below are exact token counts,
not rounded labels from the UI.

| Model generation | Context | Maximum output | Official source |
|---|---:|---:|---|
| GPT-4.1 | 1047576 | 32768 | [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1) |
| GPT-4.1 mini / nano | 1047576 | 32768 | [mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano) |
| GPT-4o | 128000 | 16384 | [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o) |
| GPT-5 / 5.1 / 5.2 | 400000 | 128000 | [GPT-5](https://developers.openai.com/api/docs/models/gpt-5), [5.1](https://developers.openai.com/api/docs/models/gpt-5.1), [5.2](https://developers.openai.com/api/docs/models/gpt-5.2) |
| GPT-5.4 / 5.6-sol | 1050000 | 128000 | [5.4](https://developers.openai.com/api/docs/models/gpt-5.4), [5.6-sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) |
| o3 / o4-mini | 200000 | 100000 | [o3](https://developers.openai.com/api/docs/models/o3), [o4-mini](https://developers.openai.com/api/docs/models/o4-mini) |

Additional generation distinctions were checked against the following pages.
This is a record of those checks, not a claim that every variant or gateway was
independently verified.

| Model | Context | Maximum output | Official source |
|---|---:|---:|---|
| Claude Sonnet 4.5 / Opus 4.5 / Haiku 4.5 | 200000 | 64000 | [Sonnet](https://platform.claude.com/docs/en/models/sonnet-4-5/overview), [Opus](https://platform.claude.com/docs/en/models/opus-4-5/overview), [Haiku](https://platform.claude.com/docs/en/models/haiku-4-5/overview) |
| Claude Sonnet 4.6 | 1000000 | 128000 | [Sonnet 4.6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview) |
| Gemini 2.0 Flash | 1048576 | 8192 | [Gemini 2.0 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.0-flash) |
| Gemini 2.5 Pro / Flash | 1048576 | 65536 | [Pro](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro), [Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash) |
| Gemini 3 Flash preview | 1048576 | 65536 | [Gemini 3 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview) |
| DeepSeek Flash / V4 Pro | 1000000 | 384000 | [Models and pricing](https://api-docs.deepseek.com/quick_start/pricing) |

Match known generations at a model-name boundary, allowing gateway prefixes,
textual suffixes, and dated snapshots such as `gpt-4.1-2025-04-14` or
`claude-3-5-sonnet-20241022`. Do not infer a new numeric generation from an older
one, treat `sol` inside an unrelated name as GPT, or infer a beta-enabled context
from a `[1M]` label. Unmatched IDs use the existing `128000 / 32000` starting pair;
the separate conservative control uses `128000 / 16384`.

## One seed rule for all add paths

`seedModelLimits` resolves manual entry, bulk paste, and model discovery in order:

1. A valid learned pair for the exact provider ID and model ID.
2. Bounded integer capacities reported by discovery, completed from generation defaults.
3. The generation defaults when no more specific data exists.

The generated pair must satisfy `0 < maxTokens < contextWindow`. If combining a
partial listing with defaults would violate this, retain the gateway's context
and use `min(16384, floor(contextWindow / 2))` for output. For example, a listing
with only `context_length: 8192` becomes `8192 / 4096`, not `8192 / 32000`.
Conflicting reported pairs use the same rule. A reported context of one token
cannot hold any positive output and is ignored as unusable metadata. Valid
learned pairs retain both numbers unchanged.

An automatically seeded row stays automatic after import. Changing its ID uses
the new ID's hint/default and discards the old ID's discovery metadata. A manual
edit to either capacity, or applying conservative values, stops reseeding both
fields. Focusing and leaving a field without changing its value does not. Loaded
stored rows retain their saved numbers. `limitsAuto` is draft-only and is neither
saved nor included in the dirty signature.

Applying an unchanged draft through the advanced JSON editor also preserves the
automatic flag; changing either capacity there stops it. Cache keys are literal
IDs, even when named `constructor` or `__proto__`. Malformed timestamps are ignored,
invalid capacity pairs are dropped, and the cache retains at most 1000 entries.
A failed cache write cannot turn an already committed provider save into an error.

Production-browser regression coverage saves and deletes a model through the
real API to populate the cache, then exercises manual re-add, bulk import, and a
loopback discovery gateway. It verifies both manual-edit guards and that a
partial-capacity model reaches the success screen and the expected disk values.
