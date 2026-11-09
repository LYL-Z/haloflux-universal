import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_STATES } from '../../event-schema/dist/index.js';
import {
  SCENARIO_NAMES,
  SIMULATOR_VERSION,
  buildScenarioEvents,
  buildStepEvent,
  scenarioSteps,
} from '../src/simulator.mjs';

test('demo scenario covers every agent state at least once', () => {
  const steps = scenarioSteps('demo');
  const states = new Set(steps.map((step) => step.state));
  for (const state of AGENT_STATES) {
    assert.ok(states.has(state), `scenario does not cover state ${state}`);
  }
  const eventTypes = new Set(steps.map((step) => step.eventType));
  for (const required of ['tool.start', 'tool.fail', 'approval.request', 'run.end']) {
    assert.ok(eventTypes.has(required), `scenario does not contain ${required}`);
  }
  assert.equal(SCENARIO_NAMES.includes('demo'), true);
});

test('all simulated events are valid, source=simulated and carry a unique eventId', () => {
  const events = buildScenarioEvents({ scenario: 'demo', startAt: 1_000_000, spacingMs: 10 });
  assert.equal(events.length, scenarioSteps('demo').length);
  const ids = new Set();
  for (const event of events) {
    assert.equal(event.host, 'simulator');
    assert.equal(event.source, 'simulated');
    assert.equal(event.hostVersion, SIMULATOR_VERSION);
    assert.match(event.eventId, /^[A-Za-z0-9_-]{8,128}$/);
    assert.equal(ids.has(event.eventId), false);
    ids.add(event.eventId);
    assert.ok(event.timestamp >= 1_000_000);
  }
});

test('buildStepEvent can build a single source=simulated event for POST /v1/simulate', () => {
  const [first] = scenarioSteps('demo');
  const event = buildStepEvent(first, { sessionId: 'simulator:http-test', timestamp: 42, seq: 3 });
  assert.equal(event.host, 'simulator');
  assert.equal(event.sessionId, 'simulator:http-test');
  assert.equal(event.source, 'simulated');
  assert.equal(event.confidence, 'unverified');
  assert.equal(event.eventType, 'host.connected');
  assert.equal(event.state, 'connected');
  assert.equal(event.timestamp, 42);
});

test('unknown scenario is rejected', () => {
  assert.throws(() => scenarioSteps('nope'), /unknown scenario/);
});
