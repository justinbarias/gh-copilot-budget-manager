import { setupServer } from 'msw/node';
import { handlers } from './handlers';

// Shared across three consumers: the Electron main-process simulation runtime,
// Vitest contract tests (this package), and Playwright e2e (launches the real
// app, which attaches this same server in-process) — one mock, never three.
export const server = setupServer(...handlers);
