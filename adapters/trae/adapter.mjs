#!/usr/bin/env node
/**
 * HALOFLUX adapter — TRAE CN 3.4.13 (`~/.trae-cn`).
 *
 * What was verified on this machine (see README "Status"):
 *  - TRAE CN 3.4.13 ships a "context asset" hook type. The workbench bundle
 *    `…\Programs\Trae CN\resources\app\out\vs\workbench\workbench.desktop.main.js`
 *    declares `{assetType:"hook", scope:3, projectRelPath:".trae/hooks.json",
 *    globalRelPath:"hooks.json"}` — i.e. a global hook file under the TRAE user
 *    config root and a project one under `.trae/`.
 *  - The *payload/event vocabulary* of that hook runner could NOT be verified:
 *    TRAE CN has no headless CLI on this machine (`Trae CN.exe` only), the hook
 *    schema is not documented in the install, and the only `hook_event_name`
 *    string in the bundle belongs to an unrelated git-ai checkpoint feature.
 *
 * Therefore this adapter speaks the Cursor-compatible vocabulary (both are
 * VS Code-derived) and every event it produces is downgraded to
 * `source: 'derived'`, `confidence: 'inferred'`, because TRAE's own semantics
 * are unconfirmed. The installer refuses to write `~/.trae-cn/hooks.json`
 * unless the operator explicitly passes `-Mode Hooks` (see README).
 *
 * Invocation: `node adapter.mjs --event <name>` with the host payload on stdin.
 * Output: nothing on stdout, always exit 0.
 */
import { runHookAdapter, readHostVersion } from '../_shared/event-client.mjs';
import { resolveHookName, mapGenericHookEvent } from '../_shared/hookmap.mjs';

const HOST = 'trae';
const hostVersion = readHostVersion(HOST);

await runHookAdapter({
  host: HOST,
  map: (payload, argv) => {
    const eventName = resolveHookName(payload, argv);
    const events = mapGenericHookEvent({ host: HOST, hostVersion, payload: payload || {}, eventName });
    // TRAE's hook contract is inferred, so never claim host-native certainty.
    return events.map((event) => ({ ...event, source: 'derived', confidence: 'inferred' }));
  },
});
