# HALOFLUX adapter — Claude Code

Host: **Claude Code CLI 2.1.299** (`C:\Users\Lenovo\AppData\Local\AgentHaven\bin\claude.cmd`)
Config root: `C:\Users\Lenovo\.claude` (`settings.json`, already managed by AgentHaven)
Adapter: `adapter.mjs` (+ `capabilities.json`, `install.ps1`, `uninstall.ps1`)

## Status

| Dimension | Status | Evidence |
|---|---|---|
| Hook installation (deep merge, AgentHaven preserved) | **PASS** | 9 HALOFLUX entries added next to 28 AgentHaven hook groups; 28/28 preserved. Sandbox install→uninstall restored `sha256=0d95dfa59d2753d0…` byte-identically. |
| Live hook delivery (host → adapter → bridge) | **PASS** | Real `claude -p` sessions produced host-native events on `http://127.0.0.1:17817` (`session.start` / `task.received` / `error` / `session.end`). |
| Agent turn completes (tools run) | **BLOCKED** | CLI is not authenticated on this machine. `claude auth status` → `loggedIn:false, authMethod:"none"`. `claude -p "reply with ok"` exits 1 with `Not logged in · Please run /login`; injecting `ANTHROPIC_AUTH_TOKEN=any` (the value used by the local proxy config) yields `401 Authentication Fails, Your api key: any is invalid`. |
| Token metrics / output stream | **UNSUPPORTED** | Claude Code hooks carry no token counts and no assistant-text deltas. `outputStream=false`, `tokenMetrics=false` in `capabilities.json`. |

Status shown in the UI: **PARTIAL** — event plumbing is real, model execution is login-blocked on this machine.

## Official extension point

Claude Code lifecycle hooks, configured under the `hooks` key of `settings.json`:
<https://code.claude.com/docs/en/hooks> (hook events, matchers, `hook_event_name`, JSON stdin payload, exit-code semantics).

Local evidence:

```text
> claude --version
2.1.299 (Claude Code)

> claude --help | Select-String hooks
  --bare   Minimal mode: skip hooks (those defined in settings and by installed plugins…)
  --safe-mode … (hooks …) disabled

> (Get-Content ~/.claude/settings.json | ConvertFrom-Json).hooks.PSObject.Properties.Name
ConfigChange, CwdChanged, Elicitation, ElicitationResult, FileChanged, InstructionsLoaded,
Notification, PermissionDenied, PermissionRequest, PostCompact, PostToolBatch, PostToolUse,
PostToolUseFailure, PreCompact, PreToolUse, SessionEnd, SessionStart, Setup, Stop, StopFailure,
SubagentStart, SubagentStop, TaskCompleted, TaskCreated, TeammateIdle, UserPromptExpansion,
UserPromptSubmit, WorktreeRemove                       # 28 events, all AgentHaven-managed
```

## Event mapping

| Claude Code hook | HALOFLUX `eventType` | `state` | Notes |
|---|---|---|---|
| `SessionStart` | `session.start` | `connected` | `label` = enum from `source` (startup/resume/clear/compact) |
| `UserPromptSubmit` | `task.received` | `running` | prompt text is never read |
| `PreToolUse` | `tool.start` | `tool` | `metadata.toolName` only; `tool_input` ignored |
| `PostToolUse` | `tool.end` | `running` | `toolStatus:"ok"` |
| `PostToolUseFailure` | `tool.fail` | `running` | `toolStatus:"failed"`; no error text forwarded |
| `PermissionRequest` | `approval.request` | `waiting_approval` | `approvalKind` = permission mode |
| `Stop` | `run.end` | `idle` | constant label |
| `StopFailure` | `error` | `error` | constant/allowlisted error code |
| `SessionEnd` | `session.end` | `disconnected` | `label` = enum reason |
| everything else (ConfigChange, Compact, Subagent*, Notification, FileChanged, …) | — | — | deliberately unmapped (noise/duplicates) |

Session id: host `session_id` when it matches `[A-Za-z0-9._:@-]{1,128}`, otherwise SHA-256 truncated to 32 hex chars.

## Privacy

Only allowlisted metadata leaves the process: `toolName`, `toolStatus`, `toolCategory`, `permissionMode`,
`model`, `cwdHint` (basename only), `label` (enum/constant only), `errorCode` (enum/constant only).
`tool_input`, `tool_response`, `prompt`, `transcript_path` contents and error messages are **never read**.
Event size is validated against the frozen schema before POST; unknown metadata keys cannot be constructed.

Regression check used by QA: synthesised `PreToolUse` payload containing `tool_input.command = "echo SECRET_DO_NOT_LEAK"`
produced an event with `metadata={"permissionMode":"default","model":"deepseek-v4-pro","cwdHint":"HALOFLUX","toolName":"Bash","toolStatus":"running"}`
and no secret substring anywhere in the bridge log.

## Install / uninstall

```powershell
# install (backs up to config/backups/<utc-ts>/, writes manifest.json, prints changes)
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\claude-code\install.ps1

# uninstall (restores the byte-identical pre-install backup)
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\claude-code\uninstall.ps1
```

The installer appends one entry to each existing event array and preserves every other entry.
It never overwrites the AgentHaven `command` entries and never deletes unrelated keys.
Uninstall compares the current SHA-256 with the manifest: on a clean match it restores the backup
byte-for-byte; on drift it removes only HALOFLUX entries and reports the diff.

Isolated install (no real config touched; `CLAUDE_CONFIG_DIR` is honoured by the CLI):

```powershell
.\install.ps1 -ConfigRoot D:\HALOFLUX\tmp\claude-test -BackupRoot D:\HALOFLUX\tmp\backups
> $env:CLAUDE_CONFIG_DIR=D:\HALOFLUX\tmp\claude-test
> claude auth status   # configDirectory now points at the temp root (verified)
```

## Known limitations

1. **Login required for a real turn.** Hooks fire from the host process, but a full `claude -p` run needs
   authentication. On this machine the CLI has no credential, so tool execution is `BLOCKED`.
2. **No token metrics / no streaming.** Hooks expose neither usage counts nor text deltas; the UI shows `—`.
3. **AgentHaven may rewrite `settings.json`.** If that happens between install and uninstall, the installer
   detects the drift (hash mismatch) and removes only HALOFLUX entries instead of restoring.
4. **Hook output is empty by design.** PreToolUse/PermissionRequest hooks must never emit decision JSON;
   the adapter writes nothing to stdout and always exits 0.
5. **Timeouts.** The adapter's bridge POST budget is 1500 ms and the hook timeout is 5 s, so a down bridge
   costs at most one short delay and never fails the host.
