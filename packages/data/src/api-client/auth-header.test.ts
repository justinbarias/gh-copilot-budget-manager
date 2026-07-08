import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG } from '../msw/fixtures/index.js';
import { isGitHubApiHost } from '../msw/unhandled.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { createGitHubApiClient } from './github-impl.js';

// 2026-07-08 live-mode-blocking bug (maintainer's first real live read
// smoke, R1-R5: every read 401'd with GitHub's "Requires authentication").
// Root cause: apps/desktop/src/main/ipc.ts constructed the routed-to
// ApiClient WITHOUT `auth`, so `new Octokit({ auth: config.auth, baseUrl })`
// in github-impl.ts built an unauthenticated client -- only validatePat's
// dedicated probe (a second, separately-constructed Octokit) ever read the
// live PAT. ipc.ts is now fixed to pass `auth`, but nothing previously
// proved -- on the actual wire, not by reading Octokit's docs -- that
// `config.auth` reaching `createGitHubApiClient` really does attach an
// Authorization header to every request the client issues. This is that
// proof: the same request:start interception technique as
// version-header.test.ts, across a wide fan-out (syncNow) that includes the R5
// `year` usage fan-out and the R6 users-1-day cycle fan-out specifically, since
// those are hand-wrapped reads issued by their own octokit.request call sites
// and could in principle drift from the plain reads. (The R6 download-link file
// fetch is a plain non-GitHub-host fetch to a signed URL -- it carries no auth
// by design and is correctly excluded by the isGitHubApiHost filter.)
//
// Note on scheme: @octokit/auth-token's default token strategy
// (with-authorization-prefix.js) emits `token <PAT>` for a classic/
// fine-grained PAT and only uses `bearer <token>` for a 3-segment JWT --
// GitHub's REST API accepts both schemes for a PAT, so this asserts the
// scheme-agnostic shape (case-insensitive `token`/`bearer` prefix + the
// exact token value), not a specific literal.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Authorization header', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-auth-header-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function captureAuthHeaders(auth: string | undefined): Promise<Array<{ url: string; authorization: string | null }>> {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const listener = ({ request }: { request: Request }): void => {
      const url = new URL(request.url);
      if (!isGitHubApiHost(url.hostname)) return;
      seen.push({ url: request.url, authorization: request.headers.get('authorization') });
    };
    server.events.on('request:start', listener);

    try {
      const client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw', auth });
      // syncNow fans out to seats, cost-centers (embedded resources), budgets,
      // the per-cost-center usage fan-out (current + `year` history), and the
      // users-1-day cycle fan-out -- the widest single read fan-out in the data
      // layer, same rationale as version-header.test.ts's use of it.
      await client.syncNow();
    } finally {
      server.events.removeListener('request:start', listener);
    }

    return seen;
  }

  it('attaches an Authorization header carrying the token to every request when the client is constructed with auth', async () => {
    const seen = await captureAuthHeaders('ghp_liveTokenForAuthHeaderTest');
    const expected = /^(?:token|bearer)\s+ghp_liveTokenForAuthHeaderTest$/i;

    expect(seen.length).toBeGreaterThan(5);
    for (const req of seen) {
      expect(req.authorization, `missing/incorrect Authorization header on ${req.url}`).toMatch(expected);
    }

    // Explicitly assert the newest hand-wrapped reads carried it too: the R5
    // `year` usage fan-out and the R6 users-1-day cycle fan-out -- the call
    // sites least likely to be caught by a spot-check.
    const yearFetch = seen.find((r) => r.url.includes('/settings/billing/usage') && r.url.includes('year='));
    const oneDayFetch = seen.find((r) => r.url.includes('/copilot/metrics/reports/users-1-day') && r.url.includes('day='));
    expect(yearFetch?.authorization).toMatch(expected);
    expect(oneDayFetch?.authorization).toMatch(expected);
  });

  it('sends no Authorization header when the client is constructed without auth (simulation/no-PAT)', async () => {
    const seen = await captureAuthHeaders(undefined);

    expect(seen.length).toBeGreaterThan(5);
    for (const req of seen) {
      expect(req.authorization, `unexpected Authorization header on ${req.url}`).toBeNull();
    }
  });
});
