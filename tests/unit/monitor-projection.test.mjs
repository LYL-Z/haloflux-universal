import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMonitor } from '../../apps/companion/renderer/monitor-projection.mjs';

const HOSTS = [{ id: 'codex', short: 'CX' }, { id: 'trae', short: 'TR' }];

test('Paper Lab starts unknown: no synthetic knowledge, error, source or success', () => {
  const result = projectMonitor({ hosts: HOSTS });
  assert.equal(result.sessionCount, 0);
  assert.equal(result.eventCount, 0);
  assert.equal(result.errorEventCount, 0);
  assert.equal(result.selected, null);
  assert.deepEqual(result.types, []);
  assert.equal(result.hosts[1].state, 'disconnected');
});

test('monitor uses actual selected host provenance, event kinds and missing metrics', () => {
  const result = projectMonitor({
    hosts: HOSTS,
    mode: 'live',
    selectedSessionId: 's1',
    sessions: [{ sessionId: 's1', host: 'codex', state: 'tool', source: 'derived', confidence: 'inferred', metrics: { model: 'gpt-example', toolName: 'Bash' } }],
    events: [
      { timestamp: 20, eventType: 'tool.start', toolName: 'Bash', source: 'derived' },
      { timestamp: 21, eventType: 'tool.end', toolName: 'Bash', source: 'derived' },
      { timestamp: 23, eventType: 'run.error', source: 'derived' },
    ],
  });
  assert.equal(result.selected.source, 'derived');
  assert.equal(result.selected.confidence, 'inferred');
  assert.equal(result.selected.tokensPerSecond, null);
  assert.equal(result.toolEventCount, 2);
  assert.equal(result.errorEventCount, 1);
  assert.equal(result.hosts[0].count, 1);
  assert.equal(result.hosts[0].selected, true);
  assert.equal(result.hosts[1].selected, false);
  assert.deepEqual(result.types[0], ['tool.start', 1]);
});

test('monitor projection never copies prompt, hidden reasoning, or document content', () => {
  const result = projectMonitor({
    hosts: HOSTS,
    selectedSessionId: 's1',
    sessions: [{ sessionId: 's1', host: 'codex', source: 'simulated', state: 'running', metrics: {}, privateReasoning: 'SECRET-THOUGHT' }],
    events: [{ eventType: 'tool.start', toolName: 'Read', prompt: 'SECRET-PROMPT', fileContent: 'SECRET-NOTE', timestamp: 1 }],
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SECRET/);
  assert.equal(result.selected.source, 'simulated');
});
