# Anthropic Beta Header Compatibility

Design record for the model-level `anthropic-beta` override. Live rules are in `AGENTS.md`; user-facing
behaviour in `docs/usage.zh-CN.md`; the compatibility contract in `docs/compatibility.md`. This file keeps the
reasoning and the sources so the decision can be re-checked after a Pi upgrade.

## Decision

Zed's `extra_beta_headers: ["context-1m-2025-08-07"]` is the HTTP `anthropic-beta` header. In Pi the same
thing is the model's `headers["anthropic-beta"]`, so that is what the manager writes — no new field, no
Zed import. The value is a comma-separated ASCII token list, normalized and deduplicated; only
`anthropic-messages` models accept a non-empty value; `""` removes every casing of the key; omission
preserves what is on disk. The browser sees `{ kind: "none" | "literal" | "external", value? }`, the same
three-state contract as the provider User-Agent.

Not inferred from a `[1M]` ID or a context window: Pi *replaces* its automatic beta list (tool streaming,
interleaved thinking, OAuth) with the model's own, so a guessed header would silently drop those, and
Anthropic no longer requires the token for 1M models. That replacement was read off `getBetaFeatures` first
and has since been measured on the wire: with thinking on, the model beside the override sends
`interleaved-thinking-2025-05-14` while the override model sends its own two tokens and does not send it, and
clearing the override hands the automatic list back. Gateways the user administers (NewAPI) are better
served by the gateway's own per-model header rules; the manager only edits Pi's side.

## Sources

- Pi `0.85.1`, `packages/ai/src/api/anthropic-messages.ts` (`getBetaFeatures`, `createClient`): a custom
  `anthropic-beta` header wins over the derived list; `model.headers` is merged into the client's defaults.
- Pi `packages/coding-agent/docs/models.md`: model-level `headers` is a documented field.
- Zed `docs/src/ai/use-api-access.md`: `extra_beta_headers` semantics.
- NewAPI `relay/channel/claude/adaptor.go` and `setting/model_setting/claude.go` (`WriteHeaders`).
- Anthropic context-windows documentation: 1M-capable models need no beta by default.

## Evidence

| Claim | Where it is checked |
| --- | --- |
| Normalization, three read states, canonical write, other headers preserved | `tests/pi-anthropic-beta.test.mjs` |
| HTTP boundary: preserve on omit, remove on `""`, refuse non-Anthropic, no leak, 409 on stale revision | `tests/server.test.mjs` |
| Draft intent on save, duplicate never copies an external value | `tests/model-draft.test.mjs` |
| Browser flow: edit, save, reload, clear with undo, invalid value refocuses the field | `tests/model-deletion-ui.test.mjs` |
| Wire: override sent exactly, sibling keeps Pi's list, `[1M]` ID sent as-is, clearing restores Pi's list | `tests/pi-anthropic-beta-real.test.mjs` (`npm run test:pi-real`, real installed Pi, loopback gateway) |
| Wire, the replacement itself: Pi has an automatic list (`interleaved-thinking-2025-05-14`) and the override model sends the override alone, then gets that list back when cleared | `tests/pi-anthropic-beta-real.test.mjs`, second test (`npm run test:pi-real`, thinking on — with it off there is no automatic list to replace, which is what made this row necessary) |

Dated results live in `design-qa.md`. Still unverified by design: whether a specific relay (Anyrouter, a given
NewAPI deployment) accepts the token or rewrites it — that is the gateway's behaviour, not the manager's.
