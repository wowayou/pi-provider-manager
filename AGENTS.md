# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Selected Product Direction

- Use the beginner-friendly three-step flow from visual option 2 as the overall framework.
- Combine the provider/model master-detail clarity from visual option 3, especially the multi-model table and default-model selection.
- Keep compatibility flags collapsed and clearly labeled as normally unnecessary.
- Never return an existing API key to the browser. The UI may show only whether a credential is configured.
- The normal user should be able to finish setup without knowing context limits, cache settings, strict tools, or adaptive-thinking terminology.
- Treat a provider as an API gateway/router similar to OpenRouter: one Base URL and credential can contain many upstream model families.
- Keep a default wire protocol at provider level, while allowing an advanced per-model protocol override for gateways that expose mixed APIs.
