# HALOFLUX adapter — WorkBuddy

Host: **WorkBuddy 5.9.3** (`C:\Users\Lenovo\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe`)
Config root: `C:\Users\Lenovo\.workbuddy` (`mcp.json`, `traces/`, `audit-log/`, `tasks/`, sqlite stores)
Adapter: `adapter.mjs` (read-only trace watcher) + `mcp-server.mjs` (MCP status/report server)

## Status

| Dimension | Status | Evidence |
|---|---|---|
| Read-only derived event source | **PASS (derived)** | Real trace logs at `~/.workbuddy/traces/<pid>/trace_<32hex>.jsonl` contain `trace_start` / `span_start` / `span_end` / `trace_end` records and spans typed `function` (PowerShell, Bash, Write, TaskCreate, TaskUpdate), `custom` (mcp_tools), `generation`, `agent`. Watcher replay produced 81 real derived events in QA's run (and 5/5 on a synthetic fixture). |
| MCP status server installed | **PASS (config)** | `~/.workbuddy/mcp.json` gained `mcpServers["haloflux-status"]` (1 entry, backup + manifest `config/backups/20261108T161905851Z/`); other servers (math-modeling, axiom-math, cloudflare, supabase, armorbreak, …) untouched. |
| MCP server exercised by WorkBuddy | **NOT_TESTED** | The server answers a real MCP handshake (`initialize`, `tools/list`, `tools/call`) when driven directly; WorkBuddy itself only calls it when the model/user asks, which was not triggered in this session. |
| Passive lifecycle hooks | **UNSUPPORTED** | WorkBuddy exposes no documented lifecycle hook API; there is no `hooks.json` equivalent. |
| Token metrics | **PASS (derived)** | `trace_end.trace.totalTokens` is forwarded as numeric `metadata.tokenCount` (verified `4242` on fixture, real traces carry `totalTokens`). |

Status shown in the UI: **PARTIAL** — derived events are real, the MCP path is installed but not exercised by the host.

## Event source (verified locally)

```text
~/.workbuddy/traces/61468/trace_f72c08ec…jsonl
  {"type":"trace_start","trace":{"traceId","name","workerPid","startedAt",…}}
  {"type":"span_start","span":{"traceId","spanId","parentId","name","type","startedAt","status"}}
  {"type":"span_end","span":{…,"duration","status","error"}}
  {"type":"trace_end","trace":{…,"totalTokens","duration"},"summary":{…}}
Observed span types: custom 336, function 66, generation 48, agent 2
Observed span names: mcp_tools, cli, generation, TaskCreate, TaskUpdate, PowerShell, Write, Bash, present_files
```

## Event mapping (derived — `source:"derived"`, `confidence:"inferred"`)

| Trace record | HALOFLUX `eventType` | `state` | Metadata |
|---|---|---|---|
| `trace_start` | `session.start` | `connected` | `label:"trace-start"` (constant) |
| `span_start` with `type ∈ {function, custom}` | `tool.start` | `tool` | `toolName` = span name, `toolCategory` = span type |
| `span_end` with `type ∈ {function, custom}` | `tool.end` (or `tool.fail` when status=error) | `running` | `toolStatus`, `durationMs`, `errorCode:"span-error"` |
| `trace_end` | `session.end` | `disconnected` | `label:"trace-end"`, `tokenCount`, `durationMs` |

Session id = `trace.traceId` (safe hex). `generation` spans are **not** mapped: there are no deltas, so the UI
must show `outputStream=false` instead of faking streaming.

## Privacy — including a fixed leak

Allowlist only: `toolName`, `toolCategory`, `toolStatus`, `durationMs`, `tokenCount`, `label` (constant).
**Never forwarded**: `trace.name`, `trace.agentName`, `summary.*` (contains `prompt`), `trace.metadata`,
`span.error` message text, span attributes.

Regression history: QA found that `trace.name` can be prompt-derived and it leaked through `metadata.label`
(a fixture name `QA_SECRET_WORKBUDDY_2b7e trace` appeared in `GET /v1/state`). Fixed by using constant labels
(`trace-start` / `trace-end`) and constant error codes; the regression fixture now produces
`session.start label="trace-start"` with **0** occurrences of the secret in the bridge log.

## Install / uninstall

```powershell
# default: register the MCP status server (backed up, reversible)
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\workbuddy\install.ps1

# watcher-only: no host config change, just prints the command
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\workbuddy\install.ps1 -Mode Watcher

# uninstall: removes only mcpServers["haloflux-status"], restores mcp.json byte-identically
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\workbuddy\uninstall.ps1
```

Watcher usage:

```powershell
node adapters\workbuddy\adapter.mjs --watch
node adapters\workbuddy\adapter.mjs --watch --once --trace-file <copy.jsonl> --tail-bytes 0
```

`--watch` is required for watcher mode; `--trace-file` alone only changes the source. `--once` performs a single
tick (used by tests/dry verification).

MCP server (stdio JSON-RPC):

```powershell
node adapters\workbuddy\mcp-server.mjs
# tools: haloflux_status (read-only), haloflux_report (coarse event, metadata allowlist)
```

## Known limitations

1. **Derived, not host-native.** Events are reconstructed from a log tail; the UI must show "推断". Latency is
   up to the poll interval (default 1 s) and a crashed session may never emit `trace_end`.
2. **First sight skips history.** By default the watcher starts at `size - 256 KB`; pass `--tail-bytes 0` to
   replay a file from the beginning (tests do this).
3. **MCP is active reporting.** `haloflux_report` only runs when the model/user calls it; it is not a passive
   lifecycle hook, and its events are `derived/inferred` by design.
4. **No approval state.** WorkBuddy traces expose no permission prompt, so `approval=false`.
5. **Trace rotation.** If WorkBuddy starts a new trace file (new PID), the watcher switches to the newest file
   and skips its history; older files are not backfilled.
