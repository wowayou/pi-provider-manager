# Claude Code support

Claude Code is a third target in the same sidebar and three-step wizard. This
adapter manages user-level Anthropic Messages gateways with static credentials,
a default model, optional `sonnet` / `opus` / `haiku` / `fable` mappings, basic
reply preferences, and the global `CLAUDE.md` instruction file. It does not add
model discovery, a traffic proxy, cloud-provider login, or a session browser.

## User workflow

1. Select **Claude Code**, then **添加供应商**. Choose **Bearer Token · 令牌认证**
   for `Authorization: Bearer`, or **API Key · 密钥认证** for `x-api-key`, following
   the gateway's instructions.
2. Enter a provider ID, display name, base URL and credential. Existing credentials
   can be retained, including while renaming the provider; they never return to
   the browser. Duplicating a provider always asks for a new credential.
3. Enter a default model ID or alias and, if needed, expand the alias mappings.
   **保存供应商** stores a provider and gives its terminal command without changing
   the global default. **保存并设为全局默认** also updates user `settings.json`.

The sidebar's **全局默认** marks what user configuration selects. It does not
inventory running terminals. The command card is available after saving and when
viewing an unchanged saved provider.

## Two launch modes

The command card offers a per-copy choice; nothing is stored:

- **固定此供应商** (pin, the default): the dedicated command below. Each terminal
  keeps its provider; later global switches do not reach it.
- **跟随全局默认** (follow): plain `claude`, prefixed with `CLAUDE_CONFIG_DIR` only
  when the manager uses a non-default directory. Claude Code watches user
  `settings.json` while it runs, so a running session follows the global default:
  measured on 2.1.283/2.1.284, the gateway, credential and alias change from the
  next request, about three seconds after the file changes (at 500 ms it had not
  yet). A turn already in flight finishes on the old gateway. If the provider
  being viewed is not the global default, the card says which one the command
  will use.

There is no toggle that makes a pinned session hot-switch: that is exactly the
follow mode.

## One terminal, one provider

Run the provider's copied command from the project directory. The command invokes
the dependency-free `bin/claude-with-provider.mjs` launcher with the config
directory and provider ID. It reads the latest saved provider, writes a fresh
private settings snapshot, and starts the installed `claude --settings <snapshot>`
with the terminal's working directory and input/output. The manager server does
not have to stay running; Claude still sends requests directly to the gateway.

Two terminals can use two different provider commands at the same time. Later
changes to the global default, saved provider or credential do not rewrite an
existing session's snapshot. New launches read the latest saved values. Both
authentication slots are explicit in the snapshot, with the unused one empty, so
another user/project token cannot silently override an API-key provider. The
snapshot also fixes the startup model and known alias mappings.

This isolates gateway selection, not all of Claude Code. Permissions, hooks,
plugins, project instructions and other settings remain under Claude Code's
normal rules. `--settings` outranks user/project settings; organization-managed
policy still outranks it. Use `/status` to confirm the actual gateway and `/model`
to select another model on that gateway. Plain `claude` still uses the global
configuration and has no per-terminal pinning guarantee.

Extra Claude arguments can follow `--`, for example:

```bash
node /path/to/manager/bin/claude-with-provider.mjs --config-dir /path/to/claude-config --provider gateway-a -- --model opus
```

The UI quotes real paths for the local shell; Windows commands target PowerShell.
The launcher accepts official native Claude installations and resolves an npm
Windows shim to its JavaScript entry without a command shell. A second
`--settings` argument is refused because it would undo the gateway selection.
A launch command points to the manager installation and provider ID: moving the
installation or renaming/deleting the provider requires copying a fresh command.

**Tradeoffs:** provider commands enable parallel work and comparisons without
repeated global switching. They add a small launcher process and a temporary
credential file per running session. Deleting a saved provider does not revoke a
running session's snapshot; stop those sessions or revoke the credential at the
gateway if immediate revocation is required.

### Exits, signals and leftovers

- `/exit`, Ctrl+C and closing the terminal window remove the snapshot. In a
  terminal, Ctrl+C already reaches Claude through the foreground process group,
  so the launcher does not forward it a second time; outside a terminal it does.
- Closing the window (`SIGHUP`) and `SIGTERM` are forwarded to Claude. A client
  still running 10 seconds after a hangup is force-stopped so the key does not
  outlive the terminal.
- Claude reads `--settings` once at startup (measured): rewriting or deleting the
  snapshot does not change a running session.
- Each session directory records the launcher and Claude process IDs. A forced
  kill (`SIGKILL`, Task Manager, a crash) skips cleanup; the next launch removes
  that directory once both recorded processes are provably gone. A directory
  without a readable record is removed after 10 minutes. A reused process ID
  can only delay removal, never remove a live session's file. A machine that
  never launches again keeps the file until you delete it. On Windows, Node
  places Claude in a kill-on-close job object, so force-ending the launcher
  also ends Claude; its snapshot is swept on the next launch (verified in CI).
- The launcher refuses a runtime directory that is a symlink or owned by another
  account, and tightens its permissions to `0700` on POSIX.

### Resuming across gateways

This manager carries no traffic and cannot rewrite history; whether a resumed
conversation continues is decided by Claude Code and the new gateway. Measured
with fake gateways on 2.1.284:

- Different model ID on the new gateway: Claude Code drops the previous signed
  thinking blocks and continues.
- Same model ID: the old signature is replayed. If the new gateway answers with
  the standard invalid-signature error, Claude Code retries without thinking
  blocks and continues.
- If the new gateway rejects it with a non-standard error (for example a bare
  `400 Bad request`), the turn fails. Start a new conversation, or switch to a
  different model ID before resuming.

The same rules apply to a follow-mode session's next turn after a global switch.
Real relays vary; treat cross-gateway resume as best effort, not a migration
feature.

## Files, ownership and concurrency

Directory precedence is `PI_PROVIDER_MANAGER_CLAUDE_DIR`, then Claude Code's own
`CLAUDE_CONFIG_DIR`, then `~/.claude` (`%USERPROFILE%\.claude` on Windows). It must
be separate from the Pi and Codex configuration directories.

| File in the Claude directory | Manager behavior |
|---|---|
| `settings.json` | Writes `model`, the gateway/auth/model-alias `env` keys, and optional `language`, `effortLevel`, `alwaysThinkingEnabled`; preserves unrelated fields |
| `pi-provider-manager-store.json` | Private provider definitions, credentials and global-default marker; inactive providers live here |
| `CLAUDE.md` | The selected global instruction document; alternatives live in the prompt library |
| `pi-provider-manager-prompts.json` | Private prompt alternatives, with a separate revision |
| `pi-provider-manager-runs/session-*/settings.json`, `owner.json` | A private, immutable-per-run gateway snapshot and its process record; removed when the launcher finishes, or by a later launch after a forced kill |

The provider revision covers native settings and the private provider store.
Every write checks it before disk; an external edit returns HTTP `409`, with a
persistent **重新读取** action. Writes use the existing atomic file replacement
and snapshot rollback. Prompts and runtime snapshots do not invalidate provider
revisions, and Claude changes do not invalidate Pi or Codex drafts.

The native file wins over the store. An unmatched existing gateway is adopted on
read, without writing. Settings parsing errors never echo source excerpts that
might contain a key. Both credential fields are removed before writing the chosen
one when updating the global default. Saved providers preserve unknown fields;
permissions, hooks, login files and unrelated environment variables are not
rewritten as gateway settings.

Deleting the global-default provider requires a surviving configured replacement.
Credential deletion is the default; an explicit keep option retains the credential
for reuse under the same ID. Cloud-provider flags and `apiKeyHelper` block gateway
activation and dedicated launch until the user handles those settings; they are
never evaluated by this manager. Inactive providers can still be saved.

Private JSON files use `0600`, and session directories `0700`, where POSIX file
permissions apply. Windows uses the account's directory ACLs. Keys exist in native
settings/private files as required by Claude Code, never in browser state or the
copied command line. Global prompt text is intentionally editable in the browser.

## Reply preferences and compatibility

**设置与兼容性** edits response language, the user default effort and extended
thinking. Unwritten settings stay unwritten; clearing a control removes its key.
Existing unknown effort values can be retained. Model-specific `modelSettings`
can outrank `effortLevel`, and some newer models ignore the user-level default;
use Claude's `/effort` for their per-model choice. Some models always think even
when extended thinking is set to false.

Sources checked on 2026-09-29:

- [Settings precedence and per-session `--settings`](https://code.claude.com/docs/en/settings)
- [Gateway credentials and settings `env`](https://code.claude.com/docs/en/llm-gateway-connect)
- [Models, aliases and effort](https://code.claude.com/docs/en/model-config)
- [Settings reference](https://code.claude.com/docs/en/settings-reference)
- [Global instructions](https://code.claude.com/docs/en/memory)

`npm run test:claude` covers storage, validation, preservation, rollback, API
boundaries, launcher signals (`SIGHUP`/`SIGTERM`/`SIGINT`, hangup force-stop,
no double Ctrl+C) and forced-kill sweeping; on Windows (CI) it runs the launcher
through an npm `.cmd` shim and sweeps after `taskkill /F`. `npm run test:ui`
exercises the production page, including both launch modes.
`npm run test:claude-real` uses installed Claude Code and loopback fake gateways
with fake credentials: both authentication modes, alias resolution, `CLAUDE.md`,
two simultaneous pinned clients across a global switch, a follow-mode client
switching, the three cross-gateway resume cases, and interactive pty sessions
(`/exit`, Ctrl+C, terminal close) through the launcher. A skip means unverified.
Not automated: the real Windows Claude binary and real third-party relays. Dated results belong in `design-qa.md`; Pi/Codex compatibility
baselines are unchanged.
