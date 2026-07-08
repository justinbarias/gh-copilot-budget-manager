import { Octokit } from 'octokit';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/index.js';
import { runReadSmoke, SMOKE_ENDPOINT_DOC_REFS } from './read-smoke.js';

// One mock, three consumers (CLAUDE.md §7): the smoke runner is proven against
// the SAME MSW server simulation mode and Playwright attach. This is how we
// prove the plumbing before a live PAT exists.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The R6 row is a multi-variant probe (documented + path-param forms). The
// canonical MSW world models the DOCUMENTED GHEC surface only, so the two
// path-param variants ({day} in the path) are registered test-locally as 404
// -- the shape of a docs-faithful tenant -- rather than left unhandled (this
// suite listens with onUnhandledRequest: 'error'). The :day override must
// fall through for the literal "latest" segment so the canonical /latest
// handler keeps serving it.
beforeEach(() => {
  server.use(
    http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports/users-28-day/:day`, ({ params }) => {
      if (params.day === 'latest') return undefined;
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),
    http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports/users-1-day/:day`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
  );
});

function client(): Octokit {
  return new Octokit({ baseUrl: GITHUB_API_BASE });
}

describe('runReadSmoke', () => {
  // 2026-06-12 is a June-cycle day the CREDITS_USED fixtures carry rows for, so
  // the R6 users-1-day probe exercises a non-empty per-day report file.
  const PROBE_DAY = '2026-06-12';

  it('reconciles every §6.9 read row (R1-R6) as ok against MSW', async () => {
    const results = await runReadSmoke(client(), ENTERPRISE_SLUG, PROBE_DAY);

    // One result per §6.9 read row, in inventory order (R3 slotted after R2).
    expect(results.map((r) => r.docRef)).toEqual([...SMOKE_ENDPOINT_DOC_REFS]);
    for (const r of results) {
      expect(r.status, `${r.docRef} ${r.endpoint}: ${r.details}`).toBe('ok');
    }
  });

  // R2 is the cap-shape pin for the maintainer's next live run: it must dump
  // the first cost-center's top-level keys and the raw ai_credit_pool_* fields
  // verbatim (the two unpinned facts: the overflow wire field and
  // target_amount's units). Against the canonical (internal-shape) mock world
  // that reads as included_usage_cap present + pool fields absent; against a
  // real tenant the same code prints the live values.
  it('R2 dumps the first cost-center key list and the raw cap fields verbatim (the overflow/units pin)', async () => {
    const results = await runReadSmoke(client(), ENTERPRISE_SLUG, PROBE_DAY);
    const r2 = results.find((r) => r.docRef === 'R2');
    expect(r2?.status, r2?.details).toBe('ok');
    expect(r2?.details).toMatch(/first-cc keys=\[.*included_usage_cap.*\]/);
    expect(r2?.details).toMatch(/ai_credit_pool_enabled=<absent>/);
    expect(r2?.details).toMatch(/ai_credit_pool_state=<absent>/);
    expect(r2?.details).toMatch(/overflow-suggestive keys: /);
  });

  // The R6 row's job is now twofold: PIN the (undocumented) downloaded report
  // file format AND decisively map which of the four candidate wire forms this
  // tenant serves (the second live smoke proved /latest can be absent).
  it('R6 probes all four variants, reports per-variant status, and pins the report file format + first-record keys', async () => {
    const results = await runReadSmoke(client(), ENTERPRISE_SLUG, PROBE_DAY);
    const r6 = results.find((r) => r.docRef === 'R6');
    expect(r6?.status, r6?.details).toBe('ok');
    // Documented forms serve on the canonical (docs-faithful) mock world; the
    // path-param variants report their own status (404 here) instead of being
    // silently skipped -- this per-variant map is the tenant-surface pin.
    expect(r6?.details).toMatch(/28d\/latest=OK/);
    expect(r6?.details).toMatch(/1d\?day=2026-06-12=OK/);
    expect(r6?.details).toMatch(/28d\/\{2026-06-12\}=HTTP 404/);
    expect(r6?.details).toMatch(/1d\/\{2026-06-12\}=HTTP 404/);
    // Format pin from the first working variant, with the money-affecting
    // ai_credits_used key surfaced.
    expect(r6?.details).toMatch(/format=(json|jsonl|csv)/);
    expect(r6?.details).toMatch(/ai_credits_used/);
    expect(r6?.details).toMatch(/via 28d\/latest/);
  });

  // The divergent-tenant shape observed live 2026-07-08: /latest 400s with a
  // day-parse error (the router treats "latest" as a {day}), the path-param
  // forms serve. R6 must still be decisive -- OK overall, with the failing
  // documented forms individually reported.
  it('R6 stays ok on a path-param-only tenant (documented forms 400) and reports the divergence per variant', async () => {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports/users-28-day/:day`, ({ params }) => {
        if (params.day === 'latest') {
          return HttpResponse.json({ message: 'Invalid day parameter. Expected format: YYYY-MM-DD' }, { status: 400 });
        }
        // Reuse the canonical 28-day download link so the file host stays canonical.
        return HttpResponse.json({
          download_links: ['https://results.download.github.test/reports/users-28-day/latest.json'],
          report_start_day: '2026-05-16',
          report_end_day: PROBE_DAY,
        });
      }),
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports/users-1-day`, () =>
        HttpResponse.json({ message: 'Invalid day parameter. Expected format: YYYY-MM-DD' }, { status: 400 }),
      ),
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/metrics/reports/users-1-day/:day`, ({ params }) =>
        HttpResponse.json({
          download_links: [`https://results.download.github.test/reports/users-1-day/${params.day as string}.json`],
          report_start_day: params.day as string,
          report_end_day: params.day as string,
        }),
      ),
    );

    const results = await runReadSmoke(client(), ENTERPRISE_SLUG, PROBE_DAY);
    const r6 = results.find((r) => r.docRef === 'R6');
    expect(r6?.status, r6?.details).toBe('ok');
    expect(r6?.details).toMatch(/28d\/latest=HTTP 400/);
    expect(r6?.details).toMatch(/28d\/\{2026-06-12\}=OK/);
    expect(r6?.details).toMatch(/1d\?day=2026-06-12=HTTP 400/);
    expect(r6?.details).toMatch(/1d\/\{2026-06-12\}=OK/);
    // Format pin comes from the first WORKING variant on this tenant.
    expect(r6?.details).toMatch(/via 28d\/\{2026-06-12\}/);
  });

  // Addendum (2026-07-08 live finding): ingestion has no product/sku filter,
  // so live pool/metered sums are polluted by every enhanced-billing product.
  // R5's sku inventory is the pin for the deferred filter fix: one line per
  // distinct (product, sku) pair across the full fan-out. Fixture world is
  // Copilot-only -- all 39 USAGE_ITEMS rows are copilot/ai_credits, and every
  // row's gross is quantity/100: qty 193,036 -> gross 1930.36; net 25.34
  // (faisal-noor's $23 overflow + the Sep-1 cliff row's $2.34); disc =
  // 1930.36 - 25.34 = 1905.02.
  it('R5 reports the distinct (product, sku) inventory with summed quantities/amounts (the sku-filter pin)', async () => {
    const results = await runReadSmoke(client(), ENTERPRISE_SLUG, PROBE_DAY);
    const r5 = results.find((r) => r.docRef === 'R5');
    expect(r5?.status, r5?.details).toBe('ok');
    expect(r5?.details).toMatch(/skus: copilot\/ai_credits n=39 qty=193036 gross=1930\.36 disc=1905\.02 net=25\.34/);
  });

  it('catches a wrong shape (missing required field) as shape_mismatch', async () => {
    // Deliberate divergence: the budgets list returns a budget with NO
    // budget_amount -- exactly the class of drift the Task 9.2 live smoke must
    // be able to flag. Proves the checker can actually FAIL, not just pass.
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/budgets`, () =>
        // Real wire scope spelling (multi_user_customer = the universal ULB).
        HttpResponse.json({ budgets: [{ budget_scope: 'multi_user_customer', budget_entity_name: 'dewr' /* budget_amount MISSING */ }] }),
      ),
    );

    const results = await runReadSmoke(client(), ENTERPRISE_SLUG);
    const r4 = results.find((r) => r.docRef === 'R4');
    expect(r4?.status).toBe('shape_mismatch');
    expect(r4?.details).toMatch(/budget_amount/);
    // The other rows still reconcile cleanly -- a mismatch is isolated per endpoint.
    expect(results.find((r) => r.docRef === 'R1')?.status).toBe('ok');
  });

  it('reports an http_error when an endpoint returns a failure status', async () => {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/copilot/billing/seats`, () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );

    const results = await runReadSmoke(client(), ENTERPRISE_SLUG);
    const r1 = results.find((r) => r.docRef === 'R1');
    expect(r1?.status).toBe('http_error');
    expect(r1?.details).toMatch(/401/);
  });
});
