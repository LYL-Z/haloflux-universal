#!/usr/bin/env node
/**
 * HALOFLUX — WorkBuddy MCP status server (stdio).
 *
 * Registered by `install.ps1 -Mode Mcp` into `~/.workbuddy/mcp.json` as
 * `mcpServers["haloflux-status"]`. WorkBuddy 5.9.3 starts it on demand; it
 * exposes `haloflux_status` (read-only) and `haloflux_report` (coarse state
 * reporting with an allowlisted, non-content payload).
 *
 * This is *active reporting*: WorkBuddy only calls it when the model or user
 * asks. It is not a lifecycle hook — the README states this limitation and the
 * passive alternative (`adapter.mjs --watch` over the trace log).
 */
import { startMcpServer } from '../_shared/mcp-status-server.mjs';

startMcpServer();
