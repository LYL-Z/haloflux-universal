// Entry used by `node --test packages/event-bridge/test` (dir args resolve here).
// Glob runs (`node --test "packages/event-bridge/test/*.test.mjs"`) skip this file.
import './bridge.test.mjs';
import './token.test.mjs';
import './simulator.test.mjs';
