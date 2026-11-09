#!/usr/bin/env node
/**
 * HALOFLUX adapter — Cursor 3.29.9 (`D:\cursor`, user config `~/.cursor`).
 *
 * Extension point: **official Cursor hooks** (`~/.cursor/hooks.json`, version 1).
 * Evidence that this is real on this machine, not a guess: the Cursor workbench
 * bundle `D:\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js`
 * contains the Cursor Hooks service, the user config path
 * `~/.cursor/hooks.json`, the enterprise path `C:\ProgramData\Cursor\hooks.json`
 * and the event list embedded in variable `m4r` (sessionStart, postToolUse, …).
 *
 * Invocation: Cursor runs the configured command and pipes the hook payload on
 * stdin. `--event <hookEventName>` is accepted for hooks that receive only
 * argv; otherwise `hook_event_name` / `event` is read from the payload.
 *
 * Output: nothing on stdout, always exit 0. HALOFLUX never returns a
 * `permission` / `updated_input` object, so it cannot change what Cursor does.
 */
import { runHookAdapter, readHostVersion } from '../_shared/event-client.mjs';
import { resolveHookName, mapGenericHookEvent } from '../_shared/hookmap.mjs';

const HOST = 'cursor';
const hostVersion = readHostVersion(HOST);

await runHookAdapter({
  host: HOST,
  map: (payload, argv) => {
    const eventName = resolveHookName(payload, argv);
    return mapGenericHookEvent({ host: HOST, hostVersion, payload: payload || {}, eventName });
  },
});
