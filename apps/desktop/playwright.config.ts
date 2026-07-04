import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Headless, MSW-backed, deterministic — the blocking §6.7 gate. No `use.baseURL`
// or browser project: these specs drive the real Electron app via _electron.launch(),
// not a browser tab.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  // main/index.ts loads http://localhost:5173 whenever app.isPackaged is
  // false (always true for e2e, which runs from source). The renderer's
  // own state (MSW, sqlite) is per-test-isolated already; this dev server
  // just serves the static React bundle, so reusing one instance across
  // the run doesn't break determinism.
  webServer: {
    command: 'pnpm --filter @copilot-budget/ui dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    cwd: path.resolve(__dirname, '..'),
    timeout: 30_000,
  },
});
