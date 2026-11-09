# HALOFLUX adapter — generic (stdin JSONL)

Host: **any** (future hosts, small scripts, CI). No host configuration is touched.
Adapter: `adapter.mjs` (+ `capabilities.json`)

## Status

| Dimension | Status | Evidence |
|---|---|---|
| stdin JSONL → bridge round-trip | **PASS** | `printf '{"eventType":"task.received","sessionId":"gen-1"}\n{"eventType":"run.end","sessionId":"gen-1"}\ngarbage line' \| node adapters/generic/adapter.mjs` → `records=2 events=2 skipped=0 posted=true`; both events were accepted by the real schema validator. QA independently round-tripped synthetic events through the real bridge. |
| Full v1 event passthrough | **PASS** | A complete v1 event on stdin is validated with `@haloflux/event-schema` and posted unchanged (`--print-event` shows the array). |
| Host config install | **N/A** | `install.ps1` intentionally reports `NO-INSTALL-NEEDED`. |

Status: **PASS** for the adapter contract (this is the reference implementation other adapters are tested against).

## Usage

```powershell
# shorthand records (host defaults to "generic", source becomes derived/inferred)
'{"eventType":"tool.start","toolName":"Bash","sessionId":"s1"}' | node adapters\generic\adapter.mjs

# read from a file, attribute to another host id
node adapters\generic\adapter.mjs --file events.jsonl --host codex

# full HALOFLUX v1 events pass through after schema validation
Get-Content events.v1.jsonl | node adapters\generic\adapter.mjs
```

Options:

| Flag | Meaning |
|---|---|
| `--host <id>` | host id used for shorthand records (must be a schema host; default `generic`) |
| `--file <path>` | read JSONL from a file instead of stdin |
| `--print-event` | print the mapped event array to stdout (debug only; hooks never do this) |

Output is a single status line, exit code is always 0:
`[generic-adapter] records=2 events=2 skipped=0 posted=true`.

## Event mapping

| Input | Output |
|---|---|
| complete v1 event | posted as-is after `validateEvent` (host must be valid; unknown metadata keys are rejected) |
| `{eventType, state?, sessionId?, source?, confidence?, toolName?, toolCategory?, label?, errorCode?, durationMs?, tokenCount?, model?, sessionTitle?, agentName?, custom?}` | `createEvent` with `host` from `--host`, `source` defaults to `derived`, `confidence` defaults to `inferred` |
| invalid line / unknown `eventType` | counted as `skipped`, never posted |

`eventType` must be one of the 19 contract types; `state` must be one of the 10 agent states.
Numeric metadata is clamped to finite non-negative numbers; `errorCode` must be identifier-shaped.

## Privacy

Shorthand records only accept the fields listed above. `label` is caller-supplied (this is an integration API,
not a host payload) but is clamped to 120 chars; `custom` is limited to 16 flat scalar entries (≤1 KB).
Tool arguments, prompts and file contents have no field to travel in; a full v1 event with unknown metadata
keys is rejected by the schema validator before POST.

## Install / uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\generic\install.ps1 -Json
# {"host":"generic","status":"NO-INSTALL-NEEDED", …}
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\generic\uninstall.ps1
# removes only adapters/_shared/.watch-state/generic.json if present
```

## Known limitations

1. **Not a host integration.** It relies on an external script to feed it; no lifecycle events are produced by
   itself, so `passive=true` only means "no host hook needed".
2. **Shorthand is downgraded.** Because the caller is not a host callback, shorthand events default to
   `source=derived`, `confidence=inferred`. Pass a complete v1 event if you can honestly claim host-native.
3. **Batch size.** One process handles one file/stdin stream; the bridge's 100-event batch limit is not chunked.
   Split large inputs or run the adapter per chunk.
