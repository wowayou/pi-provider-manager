// Each adapter owns validation and its transaction. The HTTP endpoint returns
// the public snapshot taken immediately after that synchronous transaction.
export function providerRoutes({ pi, codex, claude, checkClaudeDirectory, afterCodexWrite, publicState }) {
  const routes = new Map();
  function register(prefix, actions, apply) {
    for (const [route, action] of Object.entries(actions)) routes.set(prefix + route, body => {
      const result = apply(action, body);
      return { ok: true, ...result, state: publicState() };
    });
  }
  register("/api/", {
    providers: pi.saveProvider, "providers/set-default": pi.setDefaultModel,
    "providers/delete": pi.deleteProvider, "providers/delete-bulk": pi.deleteProvidersBulk, settings: pi.saveSettings,
  }, (action, body) => { action(body); });
  register("/api/codex/", {
    providers: codex.saveProvider, activate: codex.activate, settings: codex.saveSettings,
    "providers/delete": codex.deleteProvider, "providers/delete-bulk": codex.deleteProvidersBulk,
  }, (action, body) => { afterCodexWrite(action(body)); });
  register("/api/claude/", {
    providers: claude.saveProvider, activate: claude.activate, settings: claude.saveSettings,
    "providers/delete": claude.deleteProvider,
  }, (action, body) => { checkClaudeDirectory(); return { result: action(body) }; });
  return routes;
}
