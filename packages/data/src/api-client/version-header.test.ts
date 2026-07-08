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
// representative sampling of endpoints -- crucially INCLUDING the R5 `year`
// usage fan-out and the R6 users-1-day cycle fan-out, the newest hand-wrapped
// reads (the download-link file fetch is a plain non-GitHub-host fetch, so it
// is correctly excluded here).
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
      // syncNow fans out to seats, cost-centers (embedded resources), budgets,
      // the per-cost-center usage fan-out (current + `year` history), and the
      // users-1-day cycle fan-out -- the widest single read fan-out in the data
      // layer.
      await client.syncNow();
    } finally {
      server.events.removeListener('request:start', listener);
    }

    expect(seen.length).toBeGreaterThan(5);
    for (const req of seen) {
      expect(req.version, `missing/incorrect version header on ${req.url}`).toBe(API_VERSION);
    }

    // Explicitly assert the newest hand-wrapped reads were among them: the R5
    // `year` usage fan-out and the R6 users-1-day cycle fan-out, both carrying
    // the header.
    const yearFetch = seen.find((r) => r.url.includes('/settings/billing/usage') && r.url.includes('year='));
    const oneDayFetch = seen.find((r) => r.url.includes('/copilot/metrics/reports/users-1-day') && r.url.includes('day='));
    expect(yearFetch?.version).toBe(API_VERSION);
    expect(oneDayFetch?.version).toBe(API_VERSION);
  });
});
