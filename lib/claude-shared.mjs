// Browser-safe vocabulary for the user-level Claude Code gateway adapter.
import { PROVIDER_ID_PATTERN, normalizeUrl, looksLikeUrlNotKey } from "./validation.mjs";

export const CLAUDE_ALIASES = ["sonnet", "opus", "haiku", "fable"];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh"];
export const claudeAliasEnv = (alias) => `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;

// Command paths may contain spaces, quotes and shell syntax. Quote every token;
// no credential ever enters the command line. Windows commands target PowerShell.
export function claudeLaunchCommand(launcher, providerId) {
  if (!launcher) return "";
  const quote = launcher.shell === "powershell"
    ? (value) => "'" + String(value).replaceAll("'", "''") + "'"
    : (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  return (launcher.shell === "powershell" ? "& " : "") + [launcher.node, launcher.script, "--config-dir", launcher.dir, "--provider", providerId].map(quote).join(" ");
}

// Plain `claude` follows user settings.json while it runs (measured on 2.1.283:
// the next request after a rewrite goes to the new gateway). Name the config
// directory only when it is not Claude's own default, so the terminal reads the
// file this manager writes.
export function claudeFollowCommand(launcher, dirSource) {
  if (!launcher) return "";
  if (dirSource === "default-home") return "claude";
  return launcher.shell === "powershell"
    ? "$env:CLAUDE_CONFIG_DIR = '" + String(launcher.dir).replaceAll("'", "''") + "'; claude"
    : "CLAUDE_CONFIG_DIR='" + String(launcher.dir).replaceAll("'", "'\\''") + "' claude";
}

const invalid = (field, message) => { throw Object.assign(new Error(message), { field }); };

export function validateClaudeConnection(input) {
  const id = String(input.providerId || "").trim();
  if (!PROVIDER_ID_PATTERN.test(id) || id.length > 100) invalid("providerId", "供应商 ID 只能使用小写字母、数字、点、横线和下划线，最多 100 字符。");
  const name = String(input.name || "").trim();
  if (!name || name.length > 200) invalid("name", "请填写供应商名称（最多 200 字符）。");
  let baseUrl;
  try { baseUrl = normalizeUrl(input.baseUrl); } catch (error) { invalid("baseUrl", error.message); }
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) invalid("baseUrl", "API 地址不能含凭据、查询参数或片段。");
  if (!["token", "api-key"].includes(input.authType)) invalid("authType", "请选择 Bearer Token 或 API Key 认证。");
  return { id, name, baseUrl, authType: input.authType };
}

export function validateClaudeProvider(input) {
  const connection = validateClaudeConnection(input);
  const model = String(input.model || "").trim();
  const validModel = (value) => value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);
  if (!model || !validModel(model)) invalid("model", "请填写有效的默认模型 ID 或别名（不含空白，最多 256 字符）。");
  const aliases = {};
  for (const alias of CLAUDE_ALIASES) {
    const value = String(input.aliases?.[alias] || "").trim();
    if (!validModel(value)) invalid(alias, `${alias} 模型 ID 无效。`);
    if (value) aliases[alias] = value;
  }
  return { ...connection, model, aliases };
}

export function validateClaudeCredential(value) {
  const credential = typeof value === "string" ? value.trim() : "";
  if (!credential || credential.length > 16384 || /[\u0000-\u0020\u007f-\uffff]/u.test(credential) || looksLikeUrlNotKey(credential)) {
    invalid("apiKey", "请输入有效凭据，不能是 URL 或含空白、控制字符。");
  }
  return credential;
}
