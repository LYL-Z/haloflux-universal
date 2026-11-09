# HALOFLUX Universal Agent Visualizer — Architecture & Interface Contract

Status: **frozen contract v1** (all modules must code against this document).
Owner: Lead. Changes require a Lead edit to this file.

---

## 1. Why this shape

HALOFLUX upstream is a single `canvas` animation with a 56-parameter console. It knows
nothing about agents. The port in `upstream/dsh-haloflux` proved that a Canvas light ring can
be driven by *real* session events, but it is welded to one host (DeepSeek Harness) and to one
client API (`ctx.sessions.binding()`).

This project keeps the visual language and moves every host-specific decision behind a
normalized event protocol:

```
 host native hook / MCP / plugin
        │  (host-specific payload, never leaves the adapter process)
        ▼
 adapters/<host>/adapter.mjs          ← maps to HALOFLUX event v1, POSTs over loopback
        │  POST http://127.0.0.1:17817/v1/events   (token auth, ≤8 KB/event)
        ▼
 packages/event-bridge  ──► packages/session-manager ──► snapshot + SSE
        │                                   │
        │                                   └─ state machine, dedupe, ordering, timeouts
        ▼
 apps/companion (Electron)  ◄── GET /v1/stream (SSE)
        │
        └─ packages/visual-core  (Canvas light ring, presets, perf governor)
```

Rules that must not be broken:

1. `packages/visual-core` **never** imports a host SDK or host payload type. It consumes the
   `SessionView` shape in §5 only.
2. `packages/event-bridge` **never** interprets host payloads. Adapters do that.
3. Adapters are **leaf processes**: any failure exits 0 and writes nothing to the host's
   stdout protocol. They may never block or alter a host decision.
4. States are either *reported* (`source: host-native`, `confidence: confirmed`), *derived*
   (`source: derived`, `confidence: inferred`) or *simulated* (`source: simulated`). The UI
   must render the difference. No adapter may claim `thinking` unless the host reports it.

---

## 2. Repository layout

```
D:\HALOFLUX\
├─ upstream/                 cloned references (never edited in place)
│  ├─ haloflux/              commit 016bef65…  PolyForm NC 1.0.0
│  └─ dsh-haloflux/          commit 90a1caa7…  PolyForm NC 1.0.0
├─ packages/
│  ├─ event-schema/          TS types + strict validator + JSON Schema  (DONE, frozen)
│  ├─ event-bridge/          loopback HTTP + SSE server, auth, limits
│  ├─ session-manager/       multi-session state machine, dedupe, ordering, timeout
│  ├─ settings/              schema-driven settings + persistence + presets
│  └─ visual-core/           Canvas renderer (HALOFLUX port) + perf governor
├─ adapters/
│  ├─ deepseek-harness/      native Cordis bundle (DSH plugin)  + install/verify scripts
│  ├─ claude-code/           official hook bridge
│  ├─ codex/                 notify / hooks bridge (evidence-driven)
│  ├─ cursor/                official hook bridge
│  ├─ trae/                  hook / MCP bridge
│  ├─ workbuddy/             MCP status server (+ read-only watcher if proven)
│  └─ generic/               stdin JSONL adapter for future hosts
├─ apps/companion/           Electron desktop companion
│  ├─ main/                  main process: 3 window modes, tray, IPC, click-through
│  ├─ preload/               contextBridge API
│  └─ renderer/              UI: canvas + HUD + settings (no build step)
├─ scripts/                  install/uninstall/backup/rollback/launch/capture (PowerShell + Node)
├─ tests/                    unit + e2e + host integration
├─ docs/                     P0 report, compatibility matrix, security & license, README
├─ config/                   settings.json, token (gitignored), backup manifests
└─ screenshots/              evidence captures
```

---

## 3. Processes and ports

| Process | Lifecycle | Port | Notes |
|---|---|---|---|
| Event Bridge | `node packages/event-bridge/src/server.mjs` | `127.0.0.1:17817` | loopback only, token auth |
| Desktop Companion | Electron (`scripts/launch-companion.mjs`) | — | reads bridge SSE |
| Host adapter | spawned by host hook / MCP | — | short-lived, ≤2 s |
| DSH client plugin | inside DSH Web GUI | — | posts to bridge from browser |
| Bridge simulator | `node packages/event-bridge/src/simulator.mjs` | — | posts `source: simulated` |

Environment variables (all optional):

| Var | Default | Meaning |
|---|---|---|
| `HALOFLUX_BRIDGE_PORT` | `17817` | listening port |
| `HALOFLUX_HOME` | `%LOCALAPPDATA%\HALOFLUX` | token, logs, state |
| `HALOFLUX_TOKEN` | — | explicit token (tests) |
| `HALOFLUX_TOKEN_FILE` | `$HALOFLUX_HOME/token` | token path |
| `HALOFLUX_BRIDGE_URL` | `http://127.0.0.1:17817` | used by adapters |
| `HALOFLUX_ELECTRON` | auto-detect | electron executable |
| `HALOFLUX_LOG_LEVEL` | `info` | `debug|info|warn|error` |

Token: 32 random bytes hex, file mode 0600. The bridge creates it on first start.
Adapters read it from `HALOFLUX_TOKEN` or the token file; they never log it.

---

## 4. Event protocol v1

Authoritative implementation: `packages/event-schema/src/index.ts` (compiled to `dist/`).
JSON Schema: `packages/event-schema/schema/event.schema.json`.

```ts
interface HalofluxEvent {
  schemaVersion: 1;
  eventId: string;        // [A-Za-z0-9_-]{8,128}, unique per event
  timestamp: number;      // epoch ms
  host: 'deepseek-harness'|'codex'|'cursor'|'claude-code'|'workbuddy'|'trae'|'generic'|'simulator';
  hostVersion: string;    // <= 64 chars, '' if unknown
  sessionId: string;      // [A-Za-z0-9._:@-]{1,128}
  eventType: 'host.connected'|'host.disconnected'|'session.start'|'session.end'|'session.switch'
           | 'session.heartbeat'|'task.received'|'run.start'|'run.end'|'tool.start'|'tool.end'
           | 'tool.fail'|'output.start'|'output.chunk'|'output.end'|'approval.request'
           | 'approval.resolve'|'error'|'state.snapshot';
  state: 'disconnected'|'connected'|'idle'|'running'|'tool'|'output'|'waiting_approval'|'done'|'error'|'unknown';
  source: 'host-native'|'derived'|'simulated';
  confidence: 'confirmed'|'inferred'|'unverified';
  metadata: EventMetadata;   // allowlist only, <= 4 KB
}
```

Metadata allowlist (unknown keys are rejected, so prompts or message content cannot leak):
`toolName toolCategory toolStatus toolCallId runId step turn label errorCode durationMs
tokenCount tokensPerSecond contextUsed contextLimit model projectName sessionTitle agentName
permissionMode approvalKind queueDepth latencyMs cwdHint custom`.
`toolCallId`/`runId` are optional correlation IDs (≤64 chars) added by P3; older
events without them remain valid. `custom` is a flat object of ≤16 scalar entries, ≤1 KB.

### 4.1 Host event → normalized mapping (adapters keep this table in their README)

| Meaning | eventType | state | source/confidence |
|---|---|---|---|
| host starts/hook installed ping | `host.connected` | `connected` | host-native / confirmed |
| session start / resume | `session.start` | `connected` | host-native / confirmed |
| session title changed | `session.switch` | `connected` | host-native / confirmed |
| user submitted prompt | `task.received` | `running` | host-native / confirmed |
| agent loop begins | `run.start` | `running` | host-native / confirmed |
| tool invocation | `tool.start` | `tool` | host-native / confirmed |
| tool returned OK | `tool.end` | `running` | host-native / confirmed |
| tool returned error | `tool.fail` | `running` | host-native / confirmed |
| assistant text delta | `output.start` then `output.chunk` | `output` | host-native / confirmed |
| assistant turn finished | `run.end` | `idle` | host-native / confirmed |
| permission prompt shown | `approval.request` | `waiting_approval` | host-native / confirmed |
| permission answered | `approval.resolve` | `running` | host-native / confirmed |
| session closed | `session.end` | `disconnected` | host-native / confirmed |
| host killed / bridge lost | `host.disconnected` | `disconnected` | derived / inferred |
| heartbeat only | `session.heartbeat` | `unknown` | derived / inferred |

Adapters that can only infer a state MUST downgrade `confidence` to `inferred` and set
`source: 'derived'`. The UI shows "推断" next to those states.

---

## 5. Session view (bridge → renderer)

```ts
interface SessionView {
  sessionId: string;
  host: string;
  hostVersion: string;
  state: AgentState;           // effective state after timeouts
  reportedState: AgentState;   // last state literally reported by an event
  source: 'host-native'|'derived'|'simulated';
  confidence: 'confirmed'|'inferred'|'unverified';
  connected: boolean;
  lastEventAt: number;
  startedAt: number;
  metrics: {
    toolName?: string; step?: number; turn?: number; tokenCount?: number;
    tokensPerSecond?: number; contextUsed?: number; contextLimit?: number;
    model?: string; projectName?: string; sessionTitle?: string;
  };
  recentEvents: Array<{ eventType: string; timestamp: number; label?: string; toolName?: string }>;
  warnings: string[];           // e.g. 'no-native-output-events'
}
```

`GET /v1/state`:

```json
{
  "schemaVersion": 1,
  "serverTime": 1794150000000,
  "activeSessionId": "claude-code:abc",
  "hosts": [{ "host": "claude-code", "hostVersion": "2.1.299", "connected": true, "lastSeen": 1794150000000, "capabilities": { "sessionStart": true, "toolUse": true, "tokenMetrics": false, "approval": true, "outputStream": false } }],
  "sessions": [SessionView],
  "bridge": { "version": "0.1.0", "uptimeMs": 1234, "eventCount": 42, "dropped": 0 }
}
```

`GET /v1/stream?token=…` (SSE): first event `snapshot` with the same JSON, then `update`
events (same shape, throttled to ≥ 250 ms), plus `: ping` comments every 15 s.

State snapshots are **full replacements**, not patches — simpler and idempotent.

---

## 6. HTTP API (bridge)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/v1/health` | no | — | `{ok:true,name,version,uptimeMs}` |
| POST | `/v1/events` | yes | event or `{events:[…]}` (≤100, ≤256 KB) | `202 {accepted,duplicates,sessions}` / `400 {issues}` / `413` / `429` |
| GET | `/v1/state` | yes | — | state snapshot |
| GET | `/v1/stream` | yes (query) | — | SSE |
| GET | `/v1/settings` | yes | — | settings JSON |
| PUT | `/v1/settings` | yes | settings JSON (≤64 KB) | `200` saved settings |
| POST | `/v1/simulate` | yes | `{scenario}` | `202` (dev only, `source: simulated`) |

Auth: `Authorization: Bearer <token>` or `X-Haloflux-Token: <token>`; SSE may use `?token=`.
Rejection rules: non-loopback socket, `Host` not `127.0.0.1|localhost`, present `Origin` that is
not loopback/`null`, wrong token (constant-time compare), body over limit, > 240 req/s per
socket. Errors never echo the token.

---

## 7. Session manager semantics

- **Dedupe**: ring buffer of 4096 eventIds (per bridge), duplicates counted, not applied.
- **Ordering**: buffer events with `timestamp < lastApplied.timestamp - 5000` are applied to
  metrics only and never regress `state`; otherwise events apply in arrival order. Each session
  keeps `lastApplied.timestamp` and `lastEventId`.
- **Timeout ladder** (checked every 1 s): `tool` stale > 10 min → `unknown` + warning;
  `running|output` stale > 150 s → `unknown`; `waiting_approval` stale > 15 min → `unknown`;
  no events for 45 s → `connected` (host alive, idle). `connected` sessions unseen > 10 min →
  `disconnected`.
- **Derived state** is always recomputed from the event log tail (last 200 events/session).
- **Never invent**: `tokensPerSecond`, `contextUsed`, `contextLimit` stay `undefined` unless a
  host event supplied them. Renderer renders `—`.
- **Capabilities** are declared per adapter in `adapters/<host>/capabilities.json` and merged
  into `hosts[]`; the UI uses them to explain missing data instead of faking it.

---

## 8. Visual core contract

```js
import { createVisualizer, PRESETS } from '../../packages/visual-core/src/index.js';

const viz = createVisualizer({
  canvas,                       // HTMLCanvasElement
  params: PRESETS['agent-monitor'],
  reducedMotion: false,
});
viz.start();
viz.setSession(sessionView);    // SessionView | undefined
viz.setSessions(sessionView[]); // for multi-agent side rings (optional)
viz.setParams({ opacity: 0.45 });
viz.setPreset('minimal');       // PRESETS keys: original|minimal|sci-fi|focus|ambient|agent-monitor
viz.setStateHook((state) => {});// perf/governor notifications for HUD
viz.resize({ width, height, dpr });
viz.pause(); viz.resume(); viz.destroy();
```

Perf governor requirements: `requestAnimationFrame` loop with fps cap (default 60, idle 24),
auto quality steps (particle/beam counts ×0.75 → ×0.5) after 1.2 s under 42 fps, recovery above
55 fps, `document.hidden` pause, `prefers-reduced-motion` respected, no timers left after
`destroy()`. Every preset must be reversible to `original`.

Visual mapping (contract §5 states → ring behaviour):

| state | ring |
|---|---|
| `disconnected` | dim, static (≤8% brightness) |
| `connected` | slow breathing |
| `idle` | breathing at idle level |
| `task.received` | brief flare |
| `running` | continuous rotation |
| `tool` | outer beams + data blocks active |
| `output` | flowing ring |
| `waiting_approval` | strong pulse, distinct colour |
| `done` | collapse back to idle |
| `error` | localized red-blue glitch + persistent pin |
| `unknown` | subdued, dashed phase ring |

---

## 9. Settings

`packages/settings` owns `config/settings.json` (`%LOCALAPPDATA%\HALOFLUX\settings.json` when
installed). Shape:

```json
{
  "schemaVersion": 1,
  "preset": "agent-monitor",
  "visual": { "opacity": 0.45, "idleMotion": 0.18 },
  "bridge": { "port": 17817 },
  "companion": { "mode": "window", "alwaysOnTop": false, "clickThrough": false, "opacity": 1, "bounds": null },
  "hosts": { "claude-code": { "enabled": true }, "...": { "enabled": false } },
  "telemetry": { "enabled": false }
}
```

Settings changes are atomic (write temp + rename) and validated by `packages/settings`.

---

## 10. Security invariants (all modules)

1. Bind `127.0.0.1` only. No `0.0.0.0`, no IPv6 wildcard.
2. Token required for every mutating/reading endpoint except `/v1/health`.
3. No prompt text, message bodies, file contents, tool args/results, API keys, credentials.
   Metadata allowlist enforces this at the schema boundary.
4. No network egress except the loopback bridge. No telemetry, no remote scripts.
5. Adapters wrap everything in try/catch and exit 0; a broken hook must never fail the host.
6. All host config edits: backup to `config/backups/<timestamp>/`, structured merge, manifest,
   and a rollback command. Never delete unrelated entries.
7. Install/uninstall idempotent; uninstall restores byte-identical backups when the merge is
   clean, otherwise reports a diff.

---

## 11. Testing contract

| Level | Command | What it proves |
|---|---|---|
| unit | `npm run test:unit` | validator, state machine, bridge auth/limits, settings |
| e2e simulated | `npm run test:e2e` | bridge + session manager + SSE + renderer state JSON |
| host integration | `node tests/host/<host>.mjs` | real hook fired → real event received (PASS/PARTIAL) |
| visual | `node scripts/capture.mjs` | Electron screenshot of each preset/state |
| soak | `node scripts/soak.mjs --minutes 30` | memory + fps + CPU over time |

Status vocabulary (compatibility matrix): `PASS` (real host verified), `PARTIAL`, `SIMULATED`,
`UNSUPPORTED`, `BLOCKED`, `NOT_TESTED`. A simulated PASS never upgrades a host to PASS.

---

## 12. Ownership / write scopes (parallel work)

| Area | Owner | Paths |
|---|---|---|
| contract, schema, P0, integration | Lead | `docs/00-*`, `docs/architecture.md`, `packages/event-schema/**` |
| visual engine + renderer UI | visual-dev | `packages/visual-core/**`, `apps/companion/renderer/**` |
| bridge + sessions + settings + Electron shell | bridge-dev | `packages/event-bridge/**`, `packages/session-manager/**`, `packages/settings/**`, `apps/companion/main/**`, `apps/companion/preload/**`, `scripts/launch-companion.mjs` |
| host adapters + installer | adapters-dev | `adapters/claude-code/**`, `adapters/codex/**`, `adapters/cursor/**`, `adapters/trae/**`, `adapters/workbuddy/**`, `adapters/generic/**`, `scripts/install-*.ps1` |
| DSH native integration | dsh-dev | `adapters/deepseek-harness/**`, `upstream/dsh-haloflux` install/verify |
| tests, docs, captures | qa-docs | `tests/**`, `docs/01-*`…`docs/06-*`, `screenshots/**`, `README*.md` |

Nobody edits another owner's paths without messaging the Lead. `upstream/**` is read-only
except the DSH install/verify step, which writes into the DSH *profile*, not into `upstream/`.
