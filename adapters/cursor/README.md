# HALOFLUX adapter — Cursor

Host: **Cursor 3.29.9** (`D:\cursor\Cursor.exe`)
Config root: `C:\Users\Lenovo\.cursor` (`cli-config.json`, `mcp.json`, now `hooks.json`)
Adapter: `adapter.mjs` (+ `capabilities.json`, `install.ps1`, `uninstall.ps1`)

## Status

| Dimension | Status | Evidence |
|---|---|---|
| Official hook system exists in this build | **PASS (code evidence)** | `D:\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js` contains the Cursor Hooks service: user config `~/.cursor/hooks.json`, project `.cursor/hooks.json`, enterprise `C:\ProgramData\Cursor\hooks.json`, a file watcher, and the event list (`sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `stop`, `beforeSubmitPrompt`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `subagentStart`, `subagentStop`, `preCompact`, `afterAgentResponse`, `afterAgentThought`, `workspaceOpen`, …). |
| Hook file installed | **PASS** | `~/.cursor/hooks.json` created with 11 event entries (backup + manifest `config/backups/20261108T161903843Z/`). Existing `cli-config.json` / `mcp.json` untouched. |
| Live hook firing | **NOT_TESTED** | Cursor is GUI-only here (no `cursor-agent` CLI on PATH, only the Electron app), so an agent turn could not be triggered headlessly. No hook event was observed from a real Cursor session yet. |
| Token metrics / output stream | **UNSUPPORTED** | Cursor hooks expose no token usage and no assistant delta stream. |

Status shown in the UI: **PARTIAL** — configuration-level integration verified by code inspection and adapter validation; live firing unproven.

## Official extension point

Cursor Agent Hooks (docs: <https://cursor.com/docs/agent/hooks>). Local bundle evidence:

```text
> (Get-Item D:\cursor\Cursor.exe).VersionInfo.ProductVersion
3.29.9

> Select-String D:\cursor\...\workbench.desktop.main.js -Pattern 'hooks.json' -List
Logs: "Initializing Cursor Hooks Service..."
      user config path: <home>\.cursor\hooks.json
      Claude user config path: <home>\.claude\settings.json
      enterprise config path: C:\ProgramData\Cursor\hooks.json
Event list (bundle variable m4r):
  beforeShellExecution beforeMCPExecution afterShellExecution afterMCPExecution
  beforeReadFile afterFileEdit beforeTabFileRead afterTabFileEdit stop
  beforeSubmitPrompt afterAgentResponse afterAgentThought sessionStart sessionEnd
  preCompact subagentStart subagentStop preToolUse postToolUse postToolUseFailure workspaceOpen
```

Hook config format (version 1):

```json
{ "version": 1, "hooks": { "sessionStart": [ { "command": "node …\\adapter.mjs --event sessionStart", "type": "command", "timeout": 5 } ] } }
```

## Event mapping

| Cursor hook | HALOFLUX `eventType` | `state` | Metadata |
|---|---|---|---|
| `sessionStart` | `session.start` | `connected` | `label` = enum/event name |
| `sessionEnd` | `session.end` | `disconnected` | `label` |
| `workspaceOpen` | `host.connected` | `connected` | — |
| `beforeSubmitPrompt` | `task.received` | `running` | prompt text ignored |
| `preToolUse` | `tool.start` | `tool` | `toolName` |
| `postToolUse` | `tool.end` | `running` | `toolStatus:"ok"` |
| `postToolUseFailure` | `tool.fail` | `running` | `toolStatus:"failed"`, `errorCode` (token only) |
| `beforeShellExecution` / `beforeMCPExecution` / `beforeReadFile` | `tool.start` | `tool` | `toolName` = Shell/MCP/Read |
| `afterShellExecution` / `afterMCPExecution` / `afterFileEdit` | `tool.end` | `running` | `toolName` |
| `stop` | `run.end` | `idle` | — |
| `subagentStart` / `subagentStop` | `run.start` / `run.end` | `running` / `idle` | `agentName` (safe token) |
| `preCompact` | `session.heartbeat` | `unknown` | — |
| `afterAgentResponse`, `afterAgentThought`, Tab events | — | — | ignored: no streaming contract, would flood the bridge |

The adapter accepts `--event <hookEventName>` (used when the hook invocation passes only argv) and otherwise
reads `hook_event_name` / `event` from the stdin payload. Stdout is always empty and exit code is 0, so a
`preToolUse` / `beforeShellExecution` hook can never change a permission decision.

## Privacy

Allowlisted metadata only: `toolName`, `toolStatus`, `toolCategory`, `model`, `permissionMode`, `cwdHint`,
`label` (enum/constant), `agentName` (safe token). `command`, `prompt`, file contents, tool arguments and
tool results are never forwarded. Session ids are the host id when schema-safe, otherwise SHA-256 shortened.

## Install / uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\cursor\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\cursor\uninstall.ps1
```

Install creates `~/.cursor/hooks.json` additively (it did not exist on this machine) and backs up to
`config/backups/<utc-ts>/`. Uninstall removes the created file (`DRY-RUN-WOULD-REMOVE-CREATED-FILE` in the
real-config dry run). If the file existed before, the original bytes are restored instead.

Isolated:

```powershell
.\install.ps1 -ConfigRoot D:\HALOFLUX\tmp\cursor-test -BackupRoot D:\HALOFLUX\tmp\backups
```

## Known limitations

1. **No headless CLI observed.** `cursor-agent` is not on PATH; the desktop app is the only entry point, so a
   real session trigger could not be automated. Do not upgrade this to PASS without a real fired event.
2. **Version line anomaly.** 3.29.9 reports `vscodeVersion 1.128.0`; hook semantics were reverse-engineered
   from the shipped bundle, not from a published 3.29.9 doc. Treat event names as version-pinned.
3. **No approval event.** Cursor hooks can allow/deny shell/MCP calls but expose no "waiting for approval"
   lifecycle event, so `approval=false`.
4. **Empty hook output.** Returning no JSON is the fail-open path; HALOFLUX never authorizes or blocks actions.
5. **Claude-format read.** The bundle shows Cursor also reads `~/.claude/settings.json` hooks; HALOFLUX installs
   only into `~/.cursor/hooks.json` to avoid double-firing.
