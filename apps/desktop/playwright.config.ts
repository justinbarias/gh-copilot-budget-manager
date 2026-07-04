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
});
