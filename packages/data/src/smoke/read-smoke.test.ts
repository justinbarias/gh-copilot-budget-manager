import { Octokit } from 'octokit';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/index.js';
import { runReadSmoke, SMOKE_ENDPOINT_DOC_REFS } from './read-smoke.js';

// One mock, three consumers (CLAUDE.md §7): the smoke runner is proven against
// the SAME MSW server simulation mode and Playwright attach. This is how we
// prove the plumbing before a live PAT exists.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client(): Octokit {
  return new Octokit({ baseUrl: GITHUB_API_BASE });
}

describe('runReadSmoke', () => {
  it('reconciles every §6.9 read row (R1-R6) as ok against MSW', async () => {
    const results = await runReadSmoke(client(), ENTERPRISE_SLUG);

    // One result per §6.9 read row, in inventory order (R3 slotted after R2).
    expect(results.map((r) => r.docRef)).toEqual([...SMOKE_ENDPOINT_DOC_REFS]);
    for (const r of results) {
      expect(r.status, `${r.docRef} ${r.endpoint}: ${r.details}`).toBe('ok');
    }
  });

  it('catches a wrong shape (missing required field) as shape_mismatch', async () => {
    // Deliberate divergence: the budgets list returns a budget with NO
    // budget_amount -- exactly the class of drift the Task 9.2 live smoke must
    // be able to flag. Proves the checker can actually FAIL, not just pass.
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/budgets`, () =>
        HttpResponse.json({ budgets: [{ budget_scope: 'universal', budget_entity_name: 'dewr' /* budget_amount MISSING */ }] }),
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
