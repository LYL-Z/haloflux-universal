/**
 * HALOFLUX — minimal MCP status server (stdio, JSON-RPC 2.0).
 *
 * For hosts that only expose MCP (WorkBuddy 5.9.3 is the concrete case), the
 * adapter can be registered as a local MCP server. It then offers:
 *
 *   - `haloflux_status`  read-only: bridge health, token availability, host id.
 *   - `haloflux_report`  active reporting: the agent may report a coarse state
 *     transition. Events are downgraded to source=derived, confidence=inferred
 *     because the report comes from the model, not from a host lifecycle hook.
 *
 * Privacy: tool arguments are limited to an event-type enum plus optional
 * allowlisted metadata (toolName/label). No prompt, no file content, no tool
 * arguments are accepted or forwarded.
 *
 * Protocol notes: MCP stdio framing is one JSON object per line on stdout.
 * Diagnostics go to stderr only, and only when HALOFLUX_DEBUG=1.
 */
import {
  makeEvent, toSessionId, fallbackSessionId, readHostVersion, postEvents, bridgeHealth,
  readToken, resolveTokenPath, resolveBridgeUrl, safeString, ADAPTER_VERSION,
  EVENT_TYPES, AGENT_STATES,
} from './event-client.mjs';

const HOST = process.env.HALOFLUX_HOST || 'workbuddy';
const hostVersion = readHostVersion(HOST);
const SESSION = toSessionId(process.env.HALOFLUX_SESSION_ID, fallbackSessionId(HOST, 'mcp'));

const STATE_HINTS = {
  'session.start': 'connected',
  'session.end': 'disconnected',
  'task.received': 'running',
  'run.start': 'running',
  'run.end': 'idle',
  'tool.start': 'tool',
  'tool.end': 'running',
  'tool.fail': 'running',
  'output.start': 'output',
  'output.chunk': 'output',
  'output.end': 'running',
  'approval.request': 'waiting_approval',
  'approval.resolve': 'running',
  error: 'error',
  'session.heartbeat': 'unknown',
  'host.connected': 'connected',
  'host.disconnected': 'disconnected',
  'state.snapshot': 'unknown',
};

const TOOLS = [
  {
    name: 'haloflux_status',
    description: 'Report HALOFLUX bridge/health status. Read-only, no secrets are returned.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'haloflux_report',
    description: 'Send one coarse agent-state event to the local HALOFLUX visualizer. '
      + 'Only event type plus optional toolName/label are accepted — never pass prompts, '
      + 'file contents or tool arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        eventType: { type: 'string', enum: [...EVENT_TYPES] },
        state: { type: 'string', enum: [...AGENT_STATES] },
        sessionId: { type: 'string', maxLength: 128 },
        toolName: { type: 'string', maxLength: 80 },
        label: { type: 'string', maxLength: 120 },
      },
      required: ['eventType'],
      additionalProperties: false,
    },
  },
];

function textResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(name, args) {
  if (name === 'haloflux_status') {
    const health = await bridgeHealth({ timeoutMs: 800 });
    const token = readToken();
    return textResult({
      host: HOST,
      adapterVersion: ADAPTER_VERSION,
      bridgeUrl: resolveBridgeUrl(),
      bridgeOnline: health.online,
      bridgeVersion: health.version ?? null,
      tokenConfigured: Boolean(token),
      tokenSource: process.env.HALOFLUX_TOKEN ? 'env' : resolveTokenPath(),
      sessionId: SESSION,
    });
  }
  if (name === 'haloflux_report') {
    const eventType = safeString(args?.eventType, 64);
    if (!eventType || !EVENT_TYPES.includes(eventType)) {
      return textResult({ error: `eventType must be one of ${EVENT_TYPES.join(', ')}` }, true);
    }
    const state = typeof args?.state === 'string' && AGENT_STATES.includes(args.state)
      ? args.state
      : STATE_HINTS[eventType];
    const sessionId = toSessionId(args?.sessionId, SESSION);
    const event = makeEvent({
      host: HOST,
      hostVersion,
      sessionId,
      eventType,
      state,
      source: 'derived',
      confidence: 'inferred',
      metadata: { toolName: safeString(args?.toolName, 80), label: safeString(args?.label, 120) },
    });
    if (!event) return textResult({ error: 'payload rejected by the HALOFLUX schema' }, true);
    const result = await postEvents([event]);
    return textResult({ posted: result.ok, status: result.status ?? null, eventId: event.eventId });
  }
  return textResult({ error: `unknown tool: ${name}` }, true);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message || {};
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'haloflux-status', version: ADAPTER_VERSION },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const result = await callTool(params?.name, params?.arguments || {});
    send({ jsonrpc: '2.0', id, result });
    return;
  }
  if (method === 'resources/list') { send({ jsonrpc: '2.0', id, result: { resources: [] } }); return; }
  if (method === 'prompts/list') { send({ jsonrpc: '2.0', id, result: { prompts: [] } }); return; }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

/** Start the server: line-delimited JSON-RPC over stdio. */
export function startMcpServer() {
  let buffer = '';
  let pending = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      pending += 1;
      handle(message).catch((error) => {
        if (process.env.HALOFLUX_DEBUG === '1') process.stderr.write(`[haloflux-mcp] ${error?.message}\n`);
        if (message?.id !== undefined) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'internal error' } });
        }
      }).finally(() => { pending -= 1; });
    }
  });
  // Let in-flight async tool calls finish before the transport closes.
  process.stdin.on('end', () => {
    const startedAt = Date.now();
    const drain = () => {
      if (pending <= 0 || Date.now() - startedAt > 3000) process.exit(0);
      else setTimeout(drain, 25);
    };
    drain();
  });
  process.stdin.resume();
  process.stderr.write(`[haloflux-mcp] ready host=${HOST} bridge=${resolveBridgeUrl()}\n`);
}

export { HOST, hostVersion, SESSION };
