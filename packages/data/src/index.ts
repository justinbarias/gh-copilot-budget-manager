import { CORE_PACKAGE_NAME } from '@copilot-budget/core';

export const DATA_PACKAGE_NAME = '@copilot-budget/data';
export const DATA_DEPENDS_ON = CORE_PACKAGE_NAME;

// Pure, dependency-light surface only: table definitions with no driver/IPC
// attached. Node-only capabilities (the sqlite driver, msw/node) live behind
// the './db' and './msw' subpath exports below, so importing '@copilot-budget/data'
// itself never pulls better-sqlite3 or msw/node into a non-Node consumer (e.g.
// packages/ui via Vite) — see CLAUDE.md's portability rule.
export * from './db/schema.js';

// Type-only surface (interfaces compile away — zero runtime footprint), so it
// belongs on this pure barrel even though the Octokit-backed implementation
// is Node-only and lives behind the './api-client' subpath below.
export * from './api-client/types.js';
