# HALOFLUX adapter — TRAE CN

Host: **TRAE CN 3.4.13** (`C:\Users\Lenovo\AppData\Local\Programs\Trae CN\Trae CN.exe`)
Config root: `C:\Users\Lenovo\.trae-cn` (`plugins`, `mcps`, `toolhost`, `skills`, `permission`)
Adapter: `adapter.mjs` (+ `capabilities.json`, `install.ps1`, `uninstall.ps1`)

## Status

| Dimension | Status | Evidence |
|---|---|---|
| Hook asset type exists in this build | **PARTIAL (code evidence only)** | `…\Programs\Trae CN\resources\app\out\vs\workbench\workbench.desktop.main.js` declares a context-asset type: `{assetType:"hook", scope:3, projectRelPath:".trae/hooks.json", globalRelPath:"hooks.json"}`. So a global hook file under the TRAE user config root and a project one under `.trae/` exist as concepts. |
| Hook payload / event schema | **UNSUPPORTED** | Not documented in the installation; the only `hook_event_name` strings in the bundle belong to an unrelated `git-ai` checkpoint feature (`before_edit` / `after_edit`). Event names, stdin payload and stdout semantics are unknown for 3.4.13. |
| Live hook firing | **BLOCKED** | TRAE CN exposes no headless CLI (only the Electron app), and the app was not driven in this session. Nothing was installed into the real `~/.trae-cn`, by design. |
| Read-only session log source | **UNSUPPORTED** | `~/.trae-cn/work`, `~/.trae-cn/hub_event_cache` and `~/.trae-cn/assistant` are empty on this machine; no session JSONL was found to derive events from. |
| Token metrics | **UNSUPPORTED** | No usable source. |

Status shown in the UI: **UNSUPPORTED**. The installer deliberately refuses to write host config by default:

```text
> powershell -File adapters\trae\install.ps1
TRAE: hook file format is UNVERIFIED on 3.4.13; nothing was written to ~/.trae-cn.
  Re-run with -Mode Hooks to force the Cursor-compatible hooks.json (backed up, reversible).
```

## Official extension point — what is known and what is not

Known (local bundle, see above):

```text
{ assetType: "hook", scope: 3, projectRelPath: ".trae/hooks.json", globalRelPath: "hooks.json" }
```

Not known (must not be guessed): the accepted hook event names, the JSON payload on stdin, whether stdout is
parsed for decisions, and whether hooks are enabled by default. No official TRAE 3.4.13 hook reference was
available to verify against.

`adapter.mjs` therefore speaks the **Cursor-compatible** vocabulary (both hosts are VS Code-derived) and
**downgrades every event to `source:"derived"`, `confidence:"inferred"`** — TRAE semantics are unconfirmed.

## Event mapping (unverified, Cursor-compatible)

| Hook (assumed) | HALOFLUX `eventType` | `state` |
|---|---|---|
| `sessionStart` | `session.start` | `connected` |
| `sessionEnd` | `session.end` | `disconnected` |
| `beforeSubmitPrompt` | `task.received` | `running` |
| `preToolUse` | `tool.start` | `tool` |
| `postToolUse` | `tool.end` | `running` |
| `stop` | `run.end` | `idle` |

Invocation: `node adapter.mjs --event <name>` with the host payload on stdin. Stdout is empty, exit code 0.

## Privacy

Same allowlist as every adapter: `toolName`, `toolStatus`, `model`, `permissionMode`, `cwdHint` (basename),
`label` (enum/constant only), `agentName` (safe token). No prompt, command, file content or tool argument.

## Install / uninstall

```powershell
# default: refuse (UNSUPPORTED), nothing written
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\trae\install.ps1

# explicit opt-in: write the unverified Cursor-compatible hooks.json (backed up, reversible)
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\trae\install.ps1 -Mode Hooks

# uninstall (manifest-driven; reverts the opt-in install)
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\trae\uninstall.ps1
```

`-Mode Hooks` is for experimentation only. It writes `~/.trae-cn/hooks.json` after backing it up to
`config/backups/<utc-ts>/` and records a manifest, so the change is reversible. Do **not** ship this as a
supported integration until TRAE's own hook contract has been verified.

## Known limitations

1. **UNSUPPORTED, not "working".** Hook file path exists in the bundle; semantics are unverified and no event
   has ever been observed from a TRAE process.
2. **No headless entry point.** Verification requires driving the Tauri/Electron GUI, which the current
   automation could not do reliably.
3. **No session logs.** Unlike Codex/WorkBuddy, TRAE left no readable session/trace files to derive from.
3. **Do not enable by default.** The installer's refusal is intentional; a wrong `hooks.json` could make the
   host log errors or skip agent features.
4. **Re-check after upgrade.** If TRAE documents hooks (or ships a CLI), re-run the verification and update this
   file; event names may differ from Cursor's.
