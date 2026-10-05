# Pi update and mixed-protocol endpoints — 2026-10-05

Scope: owner-requested correction for one gateway exposing several protocols;
retain the existing three-step flow and visual language.

Evidence: installed/released Pi 1.0.2; official v1.0.0…v1.0.2 diff adds
`samplingParamsByThinkingLevel` without changing managed settings/auth contracts.
`provider-composer` resolves a custom model's `baseUrl` before the provider's.

Implementation and acceptance:

- [x] Preserve the provider default; expose native model `api` + optional `baseUrl`
  together next to the model catalogue, outside compatibility flags.
- [x] Show the OpenAI/Anthropic request URL and protocol-specific `/v1` guidance.
  No implicit path rewrite or inferred protocol from a model name.
- [x] Round-trip explicit model addresses, preserve omitted fields and unknown
  sampling metadata, clear overrides explicitly, and validate before any write.
  Preserve credential privacy and revision/default-model guards.
- [x] Cover draft/JSON/duplicate behavior, API failures and production-browser
  editing; run real Pi against a keyless loopback gateway to verify mixed paths,
  advertised model commands and sampling preservation.
- [x] Run required compatibility checks, update live baseline only after passing,
  and record evidence in design-qa.md and behavior in existing usage docs.

No runtime Pi dependency, proxy, new target, or production configuration mutation.

Completed locally and released as v0.5.3. Dated evidence: [design-qa.md](../../design-qa.md#pi-102-and-mixed-protocol-addresses--2026-10-05). Full `npm test` passed 300 of 302 for the release candidate.
