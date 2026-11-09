/**
 * HALOFLUX simulator — deterministic demo sequence, every agent state at least once.
 *
 * Contract: docs/architecture.md §3 / §4. Every event is `host: simulator`,
 * `source: simulated`, `confidence: unverified` so the UI always shows that this
 * is demo data. The sequence covers all 10 agent states and includes
 * tool.start / tool.fail / approval.request / run.end.
 *
 * Usage:
 *   node packages/event-bridge/src/simulator.mjs [options]
 *
 * Options:
 *   --bridge-url <url>   default $HALOFLUX_BRIDGE_URL or http://127.0.0.1:<port>
 *   --token <token>      default $HALOFLUX_TOKEN or $HALOFLUX_HOME/token
 *   --interval <ms>      delay between events (default 900)
 *   --loop               keep replaying the sequence
 *   --scenario <name>    demo (only scenario in v1)
 *   --session <id>       sessionId (default simulator:demo)
 *   --quiet              no per-event progress lines
 *
 * `/v1/simulate` in the bridge reuses `scenarioSteps()` / `buildStepEvent()`.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createEvent } from '../../event-schema/dist/index.js';
import { readToken, tokenPath } from './token.mjs';

export const SIMULATOR_HOST = 'simulator';
export const SIMULATOR_VERSION = '0.1.0-simulated';
export const SIMULATOR_SESSION_ID = 'simulator:demo';
export const SIMULATOR_SCENARIO = 'demo';
export const SIMULATED_CONFIDENCE = 'unverified';

/** All scenarios accepted by POST /v1/simulate. */
export const SCENARIO_NAMES = Object.freeze([SIMULATOR_SCENARIO]);

/**
 * Ordered demo steps. `state` is explicit so every AgentState is visited:
 * connected, unknown, running, tool, output, waiting_approval, done, error,
 * idle, disconnected.
 */
const DEMO_STEPS = Object.freeze([
  {
    eventType: 'host.connected',
    state: 'connected',
    metadata: { label: 'simulated host connected', sessionTitle: 'Simulated demo' },
  },
  {
    eventType: 'session.start',
    state: 'connected',
    metadata: { sessionTitle: 'Simulated demo', projectName: 'haloflux', model: 'simulated-model' },
  },
  {
    eventType: 'session.heartbeat',
    state: 'unknown',
    confidence: 'unverified',
    metadata: { label: 'simulated heartbeat' },
  },
  {
    eventType: 'task.received',
    state: 'running',
    metadata: { label: 'simulated task received', turn: 1 },
  },
  {
    eventType: 'run.start',
    state: 'running',
    metadata: { label: 'simulated run start', step: 1 },
  },
  {
    eventType: 'tool.start',
    state: 'tool',
    metadata: { toolName: 'Read', toolCategory: 'filesystem', toolStatus: 'running', step: 1 },
  },
  {
    eventType: 'tool.end',
    state: 'running',
    metadata: { toolName: 'Read', toolStatus: 'ok', durationMs: 420, step: 1 },
  },
  {
    eventType: 'tool.start',
    state: 'tool',
    metadata: { toolName: 'Bash', toolCategory: 'shell', toolStatus: 'running', step: 2 },
  },
  {
    eventType: 'tool.fail',
    state: 'running',
    metadata: { toolName: 'Bash', toolStatus: 'failed', errorCode: 'E_SIMULATED', durationMs: 1200, step: 2 },
  },
  {
    eventType: 'output.start',
    state: 'output',
    metadata: { tokenCount: 128, step: 3 },
  },
  {
    eventType: 'output.chunk',
    state: 'output',
    metadata: { tokenCount: 256, tokensPerSecond: 42, step: 3 },
  },
  {
    eventType: 'output.end',
    state: 'running',
    metadata: { tokenCount: 512, contextUsed: 12000, contextLimit: 200000, step: 3 },
  },
  {
    eventType: 'approval.request',
    state: 'waiting_approval',
    metadata: { approvalKind: 'shell', permissionMode: 'ask', label: 'simulated approval request' },
  },
  {
    eventType: 'approval.resolve',
    state: 'running',
    metadata: { approvalKind: 'shell', label: 'simulated approval resolved' },
  },
  {
    eventType: 'run.end',
    state: 'done',
    metadata: { tokenCount: 640, durationMs: 5400, step: 3 },
  },
  {
    eventType: 'error',
    state: 'error',
    metadata: { errorCode: 'E_SIMULATED', label: 'simulated error for visual state coverage' },
  },
  {
    eventType: 'run.end',
    state: 'idle',
    metadata: { tokenCount: 640, step: 3, label: 'simulated idle' },
  },
  {
    eventType: 'host.disconnected',
    state: 'disconnected',
    metadata: { label: 'simulated host disconnected' },
  },
  {
    eventType: 'session.end',
    state: 'disconnected',
    metadata: { label: 'simulated session ended' },
  },
]);

/** Return a fresh copy of the ordered steps for a scenario. */
export function scenarioSteps(scenario = SIMULATOR_SCENARIO) {
  if (!SCENARIO_NAMES.includes(scenario)) {
    throw new Error(`unknown scenario "${scenario}"; expected one of ${SCENARIO_NAMES.join(', ')}`);
  }
  return DEMO_STEPS.map((step) => ({ ...step, metadata: { ...step.metadata } }));
}

/** Build one event for a step (used by the CLI and POST /v1/simulate). */
export function buildStepEvent(step, options = {}) {
  const {
    sessionId = SIMULATOR_SESSION_ID,
    hostVersion = SIMULATOR_VERSION,
    timestamp = Date.now(),
    seq = 0,
    source = 'simulated',
    confidence = step.confidence || SIMULATED_CONFIDENCE,
  } = options;
  const eventId = options.eventId || `sim-${timestamp.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return createEvent({
    host: SIMULATOR_HOST,
    sessionId,
    eventType: step.eventType,
    state: step.state,
    source,
    confidence,
    hostVersion,
    timestamp,
    eventId,
    metadata: step.metadata,
  });
}

/** Build the whole scenario at once (tests / offline fixtures). */
export function buildScenarioEvents(options = {}) {
  const {
    scenario = SIMULATOR_SCENARIO,
    sessionId = SIMULATOR_SESSION_ID,
    startAt = Date.now(),
    spacingMs = 0,
    hostVersion = SIMULATOR_VERSION,
  } = options;
  return scenarioSteps(scenario).map((step, index) =>
    buildStepEvent(step, {
      sessionId,
      hostVersion,
      timestamp: startAt + index * spacingMs,
      seq: index,
    }),
  );
}

function parseArgs(argv) {
  const args = {
    bridgeUrl: process.env.HALOFLUX_BRIDGE_URL || '',
    token: '',
    intervalMs: 900,
    loop: false,
    scenario: SIMULATOR_SCENARIO,
    sessionId: SIMULATOR_SESSION_ID,
    quiet: false,
    tokenFile: process.env.HALOFLUX_TOKEN_FILE || tokenPath(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--bridge-url':
      case '--url':
        args.bridgeUrl = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--interval': {
        const value = Number(next());
        if (!Number.isFinite(value) || value < 0) throw new Error('--interval requires a non-negative number of ms');
        args.intervalMs = value;
        break;
      }
      case '--loop':
        args.loop = true;
        break;
      case '--scenario':
        args.scenario = next();
        break;
      case '--session':
        args.sessionId = next();
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        break;
    }
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultBridgeUrl() {
  const port = process.env.HALOFLUX_BRIDGE_PORT || '17817';
  return `http://127.0.0.1:${port}`;
}

async function postEvents(bridgeUrl, token, events) {
  const response = await fetch(`${bridgeUrl.replace(/\/+$/, '')}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events }),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, payload };
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[simulator] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log('usage: node packages/event-bridge/src/simulator.mjs [--bridge-url url] [--token tok] [--interval ms] [--loop] [--scenario demo] [--session id] [--quiet]');
    return;
  }
  if (!SCENARIO_NAMES.includes(args.scenario)) {
    console.error(`[simulator] unknown scenario "${args.scenario}"`);
    process.exitCode = 2;
    return;
  }

  const bridgeUrl = (args.bridgeUrl || defaultBridgeUrl()).replace(/\/+$/, '');
  const token = args.token || readToken({ file: args.tokenFile });
  if (!token) {
    console.error('[simulator] no bridge token found. Set HALOFLUX_TOKEN or start the bridge first (it creates $HALOFLUX_HOME/token).');
    process.exitCode = 1;
    return;
  }

  if (!args.quiet) console.log(`[simulator] bridge ${bridgeUrl} · scenario ${args.scenario} · session ${args.sessionId}${args.loop ? ' · loop' : ''}`);

  let sequence = 0;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  do {
    const steps = scenarioSteps(args.scenario);
    for (let index = 0; index < steps.length && !stopping; index += 1) {
      const step = steps[index];
      const event = buildStepEvent(step, {
        sessionId: args.sessionId,
        timestamp: Date.now(),
        seq: sequence * 1000 + index,
        eventId: `sim-${Date.now().toString(36)}-${(sequence * 1000 + index).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      });
      try {
        const result = await postEvents(bridgeUrl, token, [event]);
        if (!result.ok) {
          const detail = result.payload && result.payload.error ? result.payload.error : `HTTP ${result.status}`;
          console.error(`[simulator] bridge rejected ${step.eventType} (${detail}). Is the token current?`);
          process.exitCode = 1;
          return;
        }
        if (!args.quiet) console.log(`[simulator] ${index + 1}/${steps.length} ${step.eventType} -> ${step.state}`);
      } catch (error) {
        console.error(`[simulator] cannot reach bridge at ${bridgeUrl}: ${error && error.message ? error.message : error}`);
        process.exitCode = 1;
        return;
      }
      sequence += 1;
      if ((index < steps.length - 1 || args.loop) && args.intervalMs > 0) {
        await sleep(args.intervalMs);
      }
    }
    if (args.loop && !stopping && args.intervalMs > 0) await sleep(args.intervalMs);
  } while (args.loop && !stopping);

  if (!args.quiet) console.log('[simulator] sequence complete');
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[simulator] fatal: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}
