/**
 * Directory entry for Node versions whose `node --test <dir>` resolves the path
 * as a module instead of discovering `*.test.mjs` inside it (observed on
 * Node 24.16 Windows). Explicitly importing the test modules keeps
 * `node --test packages/visual-core/test` working while still running every
 * assertion; glob invocation (`node --test packages/visual-core/test/*.test.mjs`)
 * works without this file.
 */
import './presets.test.mjs';
import './state-map.test.mjs';
import './perf.test.mjs';
import './visual-core.test.mjs';
