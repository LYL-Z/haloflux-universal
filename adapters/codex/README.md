# HALOFLUX adapter — Codex

Host: **codex-cli 0.154.0** (`C:\Users\Lenovo\AppData\Local\AgentHaven\bin\codex.cmd`)
Config root: `C:\Users\Lenovo\.codex` (`config.toml` already has `notify = […codex-computer-use.exe, "turn-ended"]`)
Adapter: `adapter.mjs` (hook mode + `--watch` derived mode), `install.ps1`, `uninstall.ps1`

## Status

| Dimension | Status | Evidence |
|---|---|---|
| Hook capability exists in this build | **PASS** | `codex features list` → `hooks  stable  true`. The binary contains the hook engine strings `hooks.json`, `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `hookSpecificOutput`, `loading hooks from both …`. |
| Hooks configured | **PASS** | `~/.codex/hooks.json` created with 8 events (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, SubagentStart, SubagentStop). `config.toml` untouched — the existing `notify` entry is preserved. Manifest + backup: `config/backups/20261108T161552323Z/`. |
| Live hook → adapter delivery | **NOT_TESTED / BLOCKED** | Codex *does* execute hook commands (a marker hook `cmd /c echo … >> marker` fired twice from `codex exec --dangerously-bypass-hook-trust`), but our node command did not reliably post within `codex exec`; repeated runs were ambiguous because other test traffic shared the bridge. Requires a human trust review via `/hooks` (or the bypass flag) plus a successful model turn to confirm end-to-end. |
| Derived session events | **PASS (derived)** | `node adapters/codex/adapter.mjs --watch --once --tail-bytes 0 --session-file <rollout.jsonl>` replayed a real 38 MB rollout and produced derived events (`source=derived`, `confidence=inferred`); QA independently observed 22 derived events from a copied real rollout. |
| Token metrics | **PARTIAL** | Derived watcher forwards numeric `tokenCount` / `contextLimit` from `event_msg/token_count`; hook mode has no token data. |

Status shown in the UI: **PARTIAL** — real derived event source works; host-native hook delivery is not proven and needs user trust.

## Official extension point

1. **Hooks** — `~/.codex/hooks.json` (or inline `[hooks.*]` in `config.toml`) with the same event vocabulary as Claude Code:
   <https://developers.openai.com/codex/hooks>, <https://developers.openai.com/codex/config-reference>.
2. **Notify** — `notify = [program, args…]` in `config.toml` (independent of hooks). Deliberately **not** modified:
   the existing entry points at `codex-computer-use.exe turn-ended` and replacing it would break another tool.
3. **Session rollout JSONL** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, written by the host.
   Observed record types: `session_meta`, `event_msg/task_started`, `event_msg/task_complete`,
   `response_item/function_call`, `response_item/custom_tool_call`, `event_msg/token_count`.

Local evidence:

```text
> codex --version
codex-cli 0.154.0
> codex features list | Select-String '^hooks'
hooks                                    stable             true
> codex --help | Select-String hook
  --dangerously-bypass-hook-trust  Run enabled hooks without requiring persisted hook trust …
```

## Event mapping — hook mode

| Codex hook | HALOFLUX `eventType` | `state` |
|---|---|---|
| `SessionStart` | `session.start` | `connected` |
| `UserPromptSubmit` | `task.received` | `running` |
| `PreToolUse` | `tool.start` | `tool` |
| `PermissionRequest` | `approval.request` | `waiting_approval` |
| `PostToolUse` | `tool.end` | `running` |
| `Stop` | `run.end` | `idle` |
| `SubagentStart` | `run.start` | `running` |
| `SubagentStop` | `run.end` | `idle` |
| `PreCompact` / `PostCompact` | `session.heartbeat` | `unknown` (label `PreCompact:manual/auto`) |
| anything else | — | — |

## Event mapping — derived watcher (`--watch`)

| Rollout record | HALOFLUX `eventType` | `state` | Metadata |
|---|---|---|---|
| `session_meta` | `session.start` | `connected` | — |
| `event_msg/task_started` | `run.start` | `running` | `contextLimit` |
| `event_msg/task_complete` | `run.end` | `idle` | `durationMs` |
| `response_item/function_call`, `custom_tool_call` | `tool.start` | `tool` | `toolName` |
| `…/function_call_output`, `custom_tool_call_output` | `tool.end` | `running` | `toolStatus:"ok"` |
| `event_msg/token_count` | `session.heartbeat` | `unknown` | `tokenCount`, `contextLimit` |
| `event_msg/turn_aborted` | `error` | `error` | `errorCode:"turn-aborted"` |

All watcher events are **`source:"derived"`, `confidence:"inferred"`** (architecture §4.1) because they are reconstructed from a log, not delivered by a host callback.

## Privacy

Allowlisted metadata only: `toolName`, `toolStatus`, `model`, `cwdHint` (basename), `permissionMode`,
`tokenCount`, `contextLimit`, `durationMs`, `errorCode` (constant). Function arguments, tool output, prompts,
`last_agent_message` and rollout `metadata` are never parsed for content.
Derived watcher reads only record `type`, `payload.type`, `payload.name`, numeric usage fields and timestamps.

## Install / uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\codex\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\codex\uninstall.ps1
```

Because `~/.codex/hooks.json` did not exist, install is an additive file creation; uninstall removes that file
(`DRY-RUN-WOULD-REMOVE-CREATED-FILE` in the real-config dry run). `config.toml` (model, notify, MCP servers,
projects) is never modified.

Isolated verification (`CODEX_HOME` is honoured by the CLI):

```powershell
.\install.ps1 -ConfigRoot D:\HALOFLUX\tmp\codex-test -BackupRoot D:\HALOFLUX\tmp\backups
$env:CODEX_HOME = 'D:\HALOFLUX\tmp\codex-test'   # copy auth.json there for a real exec
codex exec --skip-git-repo-check --json --dangerously-bypass-hook-trust -m <model> "reply with ok"
```

## Known limitations

1. **Hook trust.** Non-managed command hooks require a review (`/hooks`) or the `--dangerously-bypass-hook-trust`
   flag. Until trusted, they are skipped. This is why the host status is PARTIAL, not PASS.
2. **No `SessionEnd`.** Codex does not emit a session-end hook, so `sessionEnd=false`.
3. **`codex exec` failures block the turn.** On this machine all models are rejected with
   `You've hit your usage limit …` (and the configured `model = "gpt-6-luna"` is not in the account's model list),
   so an end-to-end run could not be completed.
4. **Watcher is inferred.** It tails the newest rollout file only; older sessions are history, and timestamps
   come from the log, not from live host callbacks. Label them as derived in any UI.
5. **`notify` is intentionally untouched.** Replacing the single `notify` program would break
   `codex-computer-use.exe`; the adapter does not claim the notify path as installed.
