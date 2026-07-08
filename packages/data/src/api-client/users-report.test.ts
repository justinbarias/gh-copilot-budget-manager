import { Octokit } from 'octokit';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/index.js';
import { fetchCycleUserCredits, fetchUserCreditsForDays, fetchUsersReport } from './users-report.js';

// Endpoint-variant fallback proof (2026-07-08 second live smoke: the
// maintainer's tenant serves /users-28-day/{day} and 400s on the DOCUMENTED
// /latest route with a day-parse error). The canonical MSW handlers stay the
// documented GHEC surface (they are the mock builder's territory); the
// divergent-tenant world is simulated here with test-local server.use()
// overrides -- MSW's per-test handler override mechanism, reset by
// afterEach(resetHandlers) so no test leaks into another.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REPORTS_BASE = `${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports`;
// Test-local results host -- self-contained, not the canonical DOWNLOAD_HOST
// (whose per-day derivation belongs to the mock side).
const TEST_FILE_HOST = 'https://variant-test.download.example';

function testClient(): Octokit {
  // A FRESH Octokit per call: the variant memo is per-Octokit-instance
  // (WeakMap), so this is also what isolates the memo between tests. Octokit's
  // built-in retry plugin is disabled: the 500-propagation test below would
  // otherwise spend ~3 exponential-backoff retries before rejecting (retries
  // never change WHICH error propagates, only how long it takes).
  return new Octokit({ baseUrl: GITHUB_API_BASE, retry: { enabled: false } });
}

// Counts GITHUB-API requests whose URL contains `needle`, via the same
// server.events interception technique version-header.test.ts uses. Scoped to
// the API host so a download-FILE fetch (whose results-host URL can contain
// the same `/users-1-day/<day>` path substring) is never miscounted as an
// endpoint-variant probe.
function countRequests(needle: string): { count: () => number; stop: () => void } {
  let n = 0;
  const listener = ({ request }: { request: Request }): void => {
    if (request.url.startsWith(GITHUB_API_BASE) && request.url.includes(needle)) n += 1;
  };
  server.events.on('request:start', listener);
  return { count: () => n, stop: () => server.events.removeListener('request:start', listener) };
}

function envelopeWith(file: string) {
  return { download_links: [`${TEST_FILE_HOST}/${file}`], report_start_day: '2026-06-12', report_end_day: '2026-06-12' };
}

function serveTestFile(file: string, records: unknown[]): void {
  server.use(http.get(`${TEST_FILE_HOST}/${file}`, () => HttpResponse.text(JSON.stringify(records))));
}

const DAY_PARSE_400 = () =>
  HttpResponse.json(
    { message: 'Invalid day parameter. Expected format: YYYY-MM-DD (e.g., 2025-10-10). Date must be within the last year and not in the future.' },
    { status: 400 },
  );

describe('fetchUsersReport variant fallback', () => {
  it('documented forms succeed with NO fallback probing (users-28-day/latest and users-1-day?day=)', async () => {
    const octokit = testClient();
    const pathVariant28 = countRequests('/users-28-day/2026-06-12');
    const pathVariant1 = countRequests('/users-1-day/2026-06-12');
    try {
      const latest = await fetchUsersReport(octokit, ENTERPRISE_SLUG, 'users-28-day', { day: '2026-06-12' });
      expect(latest.envelope.download_links.length).toBeGreaterThan(0);

      const oneDay = await fetchUsersReport(octokit, ENTERPRISE_SLUG, 'users-1-day', { day: '2026-06-12' });
      // 2026-06-12 is a fixture day with rows -- proves the documented query
      // form went end to end (envelope -> file -> records).
      expect(oneDay.records.length).toBeGreaterThan(0);
      expect(oneDay.records.every((r) => typeof r.ai_credits_used === 'number')).toBe(true);

      // The path-param variants were never attempted.
      expect(pathVariant28.count()).toBe(0);
      expect(pathVariant1.count()).toBe(0);
    } finally {
      pathVariant28.stop();
      pathVariant1.stop();
    }
  });

  it('users-28-day: 400 on /latest falls back to /{day}, and the memo skips /latest on subsequent calls', async () => {
    // Divergent tenant: /latest is parsed as a {day} value and 400s; the
    // path-param route works. The :day override must fall through for the
    // literal "latest" segment so the 400 comes from the canonical-route
    // position, exactly like the live tenant's router.
    server.use(
      http.get(`${REPORTS_BASE}/users-28-day/:day`, ({ params }) => {
        if (params.day === 'latest') return DAY_PARSE_400();
        return HttpResponse.json(envelopeWith('28d.json'));
      }),
    );
    serveTestFile('28d.json', [{ user_id: '1', user_login: 'u1', ai_credits_used: 42 }]);

    const octokit = testClient();
    const latestHits = countRequests('/users-28-day/latest');
    try {
      const first = await fetchUsersReport(octokit, ENTERPRISE_SLUG, 'users-28-day', { day: '2026-06-12' });
      expect(first.records).toEqual([{ user_id: '1', user_login: 'u1', ai_credits_used: 42 }]);
      expect(first.format).toBe('json');
      expect(latestHits.count()).toBe(1); // paid exactly one failed probe

      const second = await fetchUsersReport(octokit, ENTERPRISE_SLUG, 'users-28-day', { day: '2026-06-12' });
      expect(second.records).toHaveLength(1);
      expect(latestHits.count()).toBe(1); // memo: /latest never re-probed
    } finally {
      latestHits.stop();
    }
  });

  it('users-1-day: 400 on ?day= falls back to /{day}; a whole fan-out pays exactly ONE failed probe', async () => {
    // Divergent tenant: the documented query form 400s; the path form serves
    // a one-record file per day.
    server.use(
      http.get(`${REPORTS_BASE}/users-1-day`, () => DAY_PARSE_400()),
      http.get(`${REPORTS_BASE}/users-1-day/:day`, ({ params }) => HttpResponse.json(envelopeWith(`1d-${params.day as string}.json`))),
    );
    for (const day of ['2026-06-10', '2026-06-11', '2026-06-12']) {
      serveTestFile(`1d-${day}.json`, [{ user_id: '9', user_login: 'u9', ai_credits_used: 7 }]);
    }

    const octokit = testClient();
    // The query form's URL is the bare /users-1-day path (day rides the query
    // string) -- count exact-path hits via the '?day=' marker.
    const queryFormHits = countRequests('/users-1-day?day=');
    try {
      const records = await fetchUserCreditsForDays(octokit, ENTERPRISE_SLUG, ['2026-06-10', '2026-06-11', '2026-06-12']);
      // One record per day, tagged with its day, in day order.
      expect(records).toEqual([
        { user_id: '9', user_login: 'u9', ai_credits_used: 7, date: '2026-06-10' },
        { user_id: '9', user_login: 'u9', ai_credits_used: 7, date: '2026-06-11' },
        { user_id: '9', user_login: 'u9', ai_credits_used: 7, date: '2026-06-12' },
      ]);
      // The first-day sequential probe resolved + memoised the variant, so the
      // documented form failed exactly once for the whole 3-day fan-out.
      expect(queryFormHits.count()).toBe(1);
    } finally {
      queryFormHits.stop();
    }
  });

  it('does NOT mask a real error: a 500 on the documented form propagates without attempting the fallback', async () => {
    server.use(
      http.get(`${REPORTS_BASE}/users-28-day/:day`, ({ params }) => {
        if (params.day === 'latest') return HttpResponse.json({ message: 'Server Error' }, { status: 500 });
        // If the fallback were (wrongly) attempted, it would SUCCEED here --
        // making this test fail loudly rather than vacuously.
        return HttpResponse.json(envelopeWith('should-not-be-reached.json'));
      }),
    );

    const octokit = testClient();
    await expect(fetchUsersReport(octokit, ENTERPRISE_SLUG, 'users-28-day', { day: '2026-06-12' })).rejects.toMatchObject({
      status: 500,
    });
  });

  it('when BOTH variants fail, the second (path-param) error is the one reported', async () => {
    server.use(
      http.get(`${REPORTS_BASE}/users-28-day/:day`, ({ params }) => {
        if (params.day === 'latest') return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
        return HttpResponse.json({ message: 'No report exists for this day' }, { status: 422 });
      }),
    );

    const octokit = testClient();
    await expect(fetchUsersReport(octokit, ENTERPRISE_SLUG, 'users-28-day', { day: '2026-06-12' })).rejects.toMatchObject({
      status: 422,
    });
  });
});

// Trailing-gap tolerance (maintainer decision, 2026-07-08 final live round):
// a live Sync run before GitHub generates the as-of day's report must skip up
// to the last 2 consecutive trailing days -- and NOTHING else. These tests
// simulate the live "report not yet available" world with test-local
// overrides: the documented query form 400s for the given days (the live
// signature: "Date must be ... not in the future"), and the path-param
// variant 404s everywhere (docs-faithful tenant), so the kept fallback chain
// runs and both variants fail exactly as they would live.
describe('fetchCycleUserCredits trailing-gap tolerance', () => {
  const CYCLE_START = new Date('2026-06-10T00:00:00.000Z');
  const DAYS_ELAPSED = 4; // requested days: 2026-06-10 .. 2026-06-14

  function reportsNotYetAvailable(days: string[], status = 400): void {
    server.use(
      http.get(`${REPORTS_BASE}/users-1-day`, ({ request }) => {
        const day = new URL(request.url).searchParams.get('day');
        if (day && days.includes(day)) {
          return HttpResponse.json(
            { message: 'Invalid day parameter. Expected format: YYYY-MM-DD (e.g., 2025-10-10). Date must be within the last year and not in the future.' },
            { status },
          );
        }
        return undefined; // fall through to the canonical query handler
      }),
      http.get(`${REPORTS_BASE}/users-1-day/:day`, () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })),
    );
  }

  it('skips ONE not-yet-available trailing day, recording the gap and honest coverage', async () => {
    reportsNotYetAvailable(['2026-06-14']);
    const result = await fetchCycleUserCredits(testClient(), ENTERPRISE_SLUG, CYCLE_START, DAYS_ELAPSED);

    expect(result.skippedTrailingDays).toEqual(['2026-06-14']);
    expect(result.coveredThroughDay).toBe('2026-06-13');
    // Earlier days' data is intact (2026-06-10/11/12 are fixture days with
    // rows; 13 is a weekend fixture day whose report EXISTS but is empty --
    // it still counts as covered) and nothing from the skipped day leaked in.
    expect(result.records.some((r) => r.date === '2026-06-12')).toBe(true);
    expect(result.records.every((r) => r.date !== '2026-06-14')).toBe(true);
  });

  it('skips TWO consecutive not-yet-available trailing days (the tolerance maximum)', async () => {
    reportsNotYetAvailable(['2026-06-13', '2026-06-14']);
    const result = await fetchCycleUserCredits(testClient(), ENTERPRISE_SLUG, CYCLE_START, DAYS_ELAPSED);

    expect(result.skippedTrailingDays).toEqual(['2026-06-13', '2026-06-14']);
    expect(result.coveredThroughDay).toBe('2026-06-12');
    expect(result.records.some((r) => r.date === '2026-06-12')).toBe(true);
  });

  it('a MID-WINDOW failure is a hard error even inside the trailing pair (a later day has a report, so the earlier one was not "not yet generated")', async () => {
    reportsNotYetAvailable(['2026-06-13']); // 2026-06-14 still succeeds
    await expect(fetchCycleUserCredits(testClient(), ENTERPRISE_SLUG, CYCLE_START, DAYS_ELAPSED)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('a THIRD consecutive trailing failure is a hard error (the tolerance window is strictly 2 days)', async () => {
    reportsNotYetAvailable(['2026-06-12', '2026-06-13', '2026-06-14']);
    // 2026-06-12 falls in the hard-fetched head. The earlier head days already
    // memoised the working day-query variant, so its 400 propagates directly
    // (a memoised variant's failure is never re-fallback'd -- by design).
    await expect(fetchCycleUserCredits(testClient(), ENTERPRISE_SLUG, CYCLE_START, DAYS_ELAPSED)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('a non-400/404 status on the trailing day is a hard error (tolerance never masks real failures)', async () => {
    server.use(
      http.get(`${REPORTS_BASE}/users-1-day`, ({ request }) => {
        if (new URL(request.url).searchParams.get('day') === '2026-06-14') {
          return HttpResponse.json({ message: 'Server Error' }, { status: 500 });
        }
        return undefined;
      }),
    );
    await expect(fetchCycleUserCredits(testClient(), ENTERPRISE_SLUG, CYCLE_START, DAYS_ELAPSED)).rejects.toMatchObject({
      status: 500,
    });
  });

  it('the historical backfill path (fetchUserCreditsForDays) gets NO tolerance: a failing deep-past day is a hard error', async () => {
    reportsNotYetAvailable(['2026-03-06']);
    await expect(
      fetchUserCreditsForDays(testClient(), ENTERPRISE_SLUG, ['2026-03-05', '2026-03-06', '2026-03-07']),
      // The first day's success memoised the day-query variant, so the failing
      // day's 400 propagates directly -- and hard, with no trailing tolerance.
    ).rejects.toMatchObject({ status: 400 });
  });
});
