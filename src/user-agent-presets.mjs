// Fixed examples only. They are fill-in starting points, not persisted preset
// selections and not a promise that a particular gateway accepts the value.
// The shapes are based on the clients' public UA conventions:
// Claude Code: https://github.com/anthropics/claude-code
// Codex CLI: https://github.com/openai/codex
// Gemini CLI: https://github.com/google-gemini/gemini-cli
// Grok Build: https://github.com/xai-org/grok-build
export const USER_AGENT_PRESETS = [
  { id: "claude-code", label: "Claude Code", value: "claude-cli/2.1.197 (external, cli)" },
  { id: "codex-cli", label: "Codex CLI", value: "codex_cli_rs/0.154.0 (linux; x86_64; codex)" },
  { id: "gemini-cli", label: "Gemini CLI", value: "GeminiCLI/0.34.0/gemini-pro (linux; x64; terminal)" },
  // The official Grok Build client identifies itself as grok-shell.
  // Source: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-sampler/src/client.rs
  { id: "grok-build", label: "Grok Build", value: "grok-shell/1.0.0 (linux; x86_64)" },
];
