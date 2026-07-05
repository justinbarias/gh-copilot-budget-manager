import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { API_VERSION, ENTERPRISE_SLUG } from '../msw/fixtures/index.js';
import { isGitHubApiHost } from '../msw/unhandled.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { createGitHubApiClient } from './github-impl.js';

// Task 9.1 API-version-header audit: EVERY GitHub API request the data layer
// issues must carry `X-GitHub-Api-Version: 2026-03-10` (CLAUDE.md §2). The
// octokit.hook.before('request') pin covers octokit.request(); this test proves
// it empirically by intercepting the header on the actual wire, across a
// representative sampling of endpoints -- crucially INCLUDING the Task 5.4
// historical year/since fetches, which are the newest hand-wrapped reads.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('X-GitHub-Api-Version header', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-version-header-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is present on every GitHub API request issued by a full syncNow', async () => {
    const seen: Array<{ url: string; version: string | null }> = [];
    const listener = ({ request }: { request: Request }): void => {
      const url = new URL(request.url);
      if (!isGitHubApiHost(url.hostname)) return;
      seen.push({ url: request.url, version: request.headers.get('x-github-api-version') });
    };
    server.events.on('request:start', listener);

    try {
      const client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw' });
      // syncNow fans out to seats, cost-centers (+ per-cc resources), budgets,
      // usage, users-28-day, AND the Task 5.4 historical year/since fetches --
      // the widest single read fan-out in the data layer.
      await client.syncNow();
    } finally {
      server.events.removeListener('request:start', listener);
    }

    expect(seen.length).toBeGreaterThan(5);
    for (const req of seen) {
      expect(req.version, `missing/incorrect version header on ${req.url}`).toBe(API_VERSION);
    }

    // Explicitly assert the Task 5.4 historical fetches were among them (year=
    // on usage, since= on the metrics report) and carried the header.
    const yearFetch = seen.find((r) => r.url.includes('/settings/billing/usage') && r.url.includes('year='));
    const sinceFetch = seen.find((r) => r.url.includes('/copilot/metrics/reports/users-28-day') && r.url.includes('since='));
    expect(yearFetch?.version).toBe(API_VERSION);
    expect(sinceFetch?.version).toBe(API_VERSION);
  });
});
