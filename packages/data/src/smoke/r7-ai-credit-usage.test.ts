import type { Octokit } from 'octokit';
import { describe, expect, it } from 'vitest';
import {
  countPerItemUsers,
  runR7,
  summarizeAiCreditRollup,
  summarizeAiCreditShape,
  summarizePerSkuBreakdown,
  summarizeTotalLine,
  summarizeUserScopedProbe,
  type AiCreditUsageEnvelope,
  type AiCreditUsageItem,
} from './read-smoke.js';

// R7 probes the ai_credit/premium_request usage report -- a GITHUB-ONLY endpoint
// with no MSW twin (runReadSmoke omits it; runLiveReadSmoke appends it live).
// These tests exercise the summarizers with hand-built envelopes shaped exactly
// as the §6.9-pinned OpenAPI schema (ghec.2026-03-10.json), plus runR7 against a
// stub Octokit -- no MSW server, so there is no unhandled-request surface at all.
//
// 2026-07-10 refinement: the live probe found the OLD rollup (filtered through
// isAiCreditUsageItem, a predicate borrowed from the R5 billing-usage SKU
// convention) matched ZERO of the 24/15/15 items this DEDICATED endpoint
// actually returned -- hiding the real product/sku/model labels instead of
// showing them. The rollup is now an unfiltered per-(product, sku) breakdown
// (every item on this endpoint is relevant by construction), and a fifth
// sub-call proves the `?user=` fan-out mechanism end to end.

// A wire-faithful AI-credit line item (camelCase, no per-item user/date field).
function aiItem(overrides: Partial<AiCreditUsageItem> = {}): AiCreditUsageItem {
  return {
    product: 'copilot',
    sku: 'Copilot AI Credits',
    model: 'n/a',
    unitType: 'Credit',
    pricePerUnit: 0.01,
    grossQuantity: 500,
    grossAmount: 5,
    discountQuantity: 100,
    discountAmount: 1,
    netQuantity: 400,
    netAmount: 4,
    ...overrides,
  };
}

function envelope(items: AiCreditUsageItem[], extra: Partial<AiCreditUsageEnvelope> = {}): AiCreditUsageEnvelope {
  return { timePeriod: { year: 2026, month: 6 }, enterprise: 'acme-corp', usageItems: items, ...extra };
}

describe('R7 summarizers', () => {
  describe('summarizeAiCreditShape (probe #1: envelope-key recording + user-granularity mechanism)', () => {
    it('records envelope keys, first-item keys, item count, and that per-user granularity requires ?user=', () => {
      const env = envelope([aiItem(), aiItem({ sku: 'Copilot Premium Request' })], { user: '' });
      const out = summarizeAiCreditShape(env);
      // Envelope key list (field NAMES only -- no values leaked).
      expect(out).toContain('envelope keys=[timePeriod, enterprise, usageItems, user]');
      expect(out).toContain('usageItems=2');
      // First usageItem's camelCase keys -- proves the wire shape on the wire.
      expect(out).toContain('first-item keys=[product, sku, model, unitType, pricePerUnit, grossQuantity, grossAmount, discountQuantity, discountAmount, netQuantity, netAmount]');
      // The core finding: no per-item user field -> per-user needs the ?user= param.
      expect(out).toContain('no per-item user field');
      expect(out).toContain('requires the ?user= param');
      // §6.6: neither the enterprise value nor any login appears.
      expect(out).not.toContain('acme-corp');
    });

    it('notes when there are no usageItems to key-dump (empty aggregate window)', () => {
      const out = summarizeAiCreditShape(envelope([]));
      expect(out).toContain('usageItems=0');
      expect(out).toContain('no usageItems to key-dump');
      expect(out).toContain('no per-item user field');
    });

    it('surfaces a per-item user field IF the wire ever grows one (defensive divergence catch)', () => {
      const env = envelope([aiItem({ user_login: 'someone' }), aiItem({ user_login: 'other' })]);
      const out = summarizeAiCreditShape(env);
      expect(out).toContain('per-item user field present (distinct=2)');
      // Login values themselves must NOT leak.
      expect(out).not.toContain('someone');
      expect(out).not.toContain('other');
    });
  });

  describe('countPerItemUsers (distinct-user counting)', () => {
    it('returns hasField=false, distinct=0 for the machine-verified wire (no user field)', () => {
      expect(countPerItemUsers([aiItem(), aiItem()])).toEqual({ hasField: false, distinct: 0 });
    });

    it('counts distinct values across any of the user-ish keys when present', () => {
      const items = [aiItem({ user: 'a' }), aiItem({ user_login: 'b' }), aiItem({ userLogin: 'a' })];
      expect(countPerItemUsers(items)).toEqual({ hasField: true, distinct: 2 });
    });

    it('ignores empty-string user values', () => {
      expect(countPerItemUsers([aiItem({ user: '' })])).toEqual({ hasField: false, distinct: 0 });
    });
  });

  describe('summarizePerSkuBreakdown (per-(product, sku) grouping -- the filter-bug fix)', () => {
    it('groups by (product, sku), counting distinct models and summing netQuantity/netAmount, sorted by key', () => {
      const items = [
        aiItem({ product: 'copilot', sku: 'Copilot AI Credits', model: 'gpt-4.1', netQuantity: 100, netAmount: 1 }),
        aiItem({ product: 'copilot', sku: 'Copilot AI Credits', model: 'gpt-4.1', netQuantity: 200, netAmount: 2 }),
        aiItem({ product: 'copilot', sku: 'Copilot AI Credits', model: 'claude-sonnet', netQuantity: 50, netAmount: 0.5 }),
        aiItem({ product: 'copilot', sku: 'Copilot Premium Request', model: 'n/a', netQuantity: 10, netAmount: 0.1 }),
      ];
      expect(summarizePerSkuBreakdown(items)).toBe(
        'copilot/Copilot AI Credits: n=3 model=2 Σnet=350 Σamt=3.50; copilot/Copilot Premium Request: n=1 model=1 Σnet=10 Σamt=0.10',
      );
    });

    it('reports "(no usage items)" for an empty list (never a false 0-group breakdown)', () => {
      expect(summarizePerSkuBreakdown([])).toBe('(no usage items)');
    });

    it('never applies the old ai-credit-sku filter -- a non-Copilot (product, sku) pair is its own group, not dropped', () => {
      const items = [aiItem({ product: 'actions', sku: 'actions_linux', model: 'n/a', netQuantity: 5, netAmount: 0.05 })];
      expect(summarizePerSkuBreakdown(items)).toBe('actions/actions_linux: n=1 model=1 Σnet=5 Σamt=0.05');
    });

    it('caps at 8 groups, name-sorted, with a trailing "…N more" note', () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        aiItem({ product: 'copilot', sku: `sku-${String(i).padStart(2, '0')}`, model: 'n/a', netQuantity: i, netAmount: i }),
      );
      const out = summarizePerSkuBreakdown(items);
      const lines = out.split('; ');
      expect(lines).toHaveLength(9); // 8 shown groups + the "more" note
      expect(lines[0]).toContain('copilot/sku-00');
      expect(lines[7]).toContain('copilot/sku-07');
      expect(lines[8]).toBe('…2 more');
      // The 9th/10th groups themselves must not appear.
      expect(out).not.toContain('sku-08');
      expect(out).not.toContain('sku-09');
    });
  });

  describe('summarizeTotalLine (unfiltered total -- every item on this endpoint counts)', () => {
    it('sums netQuantity and counts nonzero items over the FULL set, no sku filter', () => {
      const items = [aiItem({ netQuantity: 400 }), aiItem({ netQuantity: 0 }), aiItem({ sku: 'Copilot Premium Request', netQuantity: 250 })];
      expect(summarizeTotalLine(items)).toBe('items=3 ΣnetQuantity=650 nonzero=2');
    });

    it('handles an all-zero window (retention-aged / genuinely idle month)', () => {
      expect(summarizeTotalLine([aiItem({ netQuantity: 0 }), aiItem({ netQuantity: 0 })])).toBe('items=2 ΣnetQuantity=0 nonzero=0');
    });
  });

  describe('summarizeAiCreditRollup (probe #2/#3/#4: per-SKU breakdown + unfiltered total)', () => {
    it('combines the per-SKU breakdown and the total line', () => {
      const env = envelope([
        aiItem({ netQuantity: 400, netAmount: 4 }),
        aiItem({ sku: 'Copilot Premium Request', netQuantity: 100, netAmount: 1 }),
      ]);
      expect(summarizeAiCreditRollup(env)).toBe(
        'copilot/Copilot AI Credits: n=1 model=1 Σnet=400 Σamt=4.00; copilot/Copilot Premium Request: n=1 model=1 Σnet=100 Σamt=1.00; items=2 ΣnetQuantity=500 nonzero=2',
      );
    });

    it('is the fix for the live finding: a non-"Copilot AI Credits" sku on this endpoint is now VISIBLE, not zeroed', () => {
      // This is exactly the bug: the old filter matched product 'copilot' + sku
      // 'Copilot AI Credits' only, so any other label the dedicated endpoint
      // actually uses (this fixture stands in for the live "24 items, 0 matched
      // the filter" case) rendered as ai-credit items=0. The new rollup has no
      // filter, so every item's real label and quantity is visible.
      const env = envelope([aiItem({ product: 'copilot', sku: 'AI credit', model: 'gpt-5', netQuantity: 24, netAmount: 0.24 })]);
      const out = summarizeAiCreditRollup(env);
      expect(out).toContain('copilot/AI credit: n=1 model=1 Σnet=24 Σamt=0.24');
      expect(out).toContain('items=1 ΣnetQuantity=24 nonzero=1');
    });
  });

  describe('summarizeUserScopedProbe (probe #5: the ?user= fan-out mechanism check)', () => {
    it('reports item count, the per-SKU breakdown, and whether the envelope echoes a user key -- never the login value', () => {
      const env = envelope([aiItem({ netQuantity: 100, netAmount: 1 })], { user: 'should-never-appear' });
      const out = summarizeUserScopedProbe(env);
      expect(out).toBe('items=1, copilot/Copilot AI Credits: n=1 model=1 Σnet=100 Σamt=1.00, envelope user key present=true');
      expect(out).not.toContain('should-never-appear');
    });

    it('reports envelope user key present=false when the envelope carries no user key', () => {
      expect(summarizeUserScopedProbe(envelope([]))).toContain('envelope user key present=false');
    });
  });
});

// A stub Octokit whose request() returns a scripted response per (route, params)
// -- enough surface for runR7, without pulling in MSW.
function stubOctokit(handler: (route: string, params: Record<string, unknown>) => unknown): Octokit {
  return {
    request: async (route: string, params: Record<string, unknown>) => ({ data: handler(route, params) }),
  } as unknown as Octokit;
}

describe('runR7 (the R7 row against a stubbed wire)', () => {
  const AI = 'GET /enterprises/{enterprise}/settings/billing/ai_credit/usage';
  const PREMIUM = 'GET /enterprises/{enterprise}/settings/billing/premium_request/usage';
  const SEATS = 'GET /enterprises/{enterprise}/copilot/billing/seats';
  const STUB_LOGIN = 'stub-login-should-never-render';

  function seatsResponse(): unknown {
    return { seats: [{ assignee: { login: STUB_LOGIN, id: 1, type: 'User' } }] };
  }

  it('issues the four documented windows plus the seat-fetch + user-scoped calls, and reports one ok row with five labeled parts', async () => {
    const seen: Array<{ route: string; params: Record<string, unknown> }> = [];
    const octokit = stubOctokit((route, params) => {
      seen.push({ route, params });
      if (route === SEATS) return seatsResponse();
      return envelope([aiItem({ netQuantity: 400 })]);
    });

    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });

    expect(result.docRef).toBe('R7');
    expect(result.status).toBe('ok');
    expect(result.endpoint).toContain('ai_credit/usage');
    expect(result.endpoint).toContain('premium_request/usage');

    expect(seen).toHaveLength(6);

    // Call #1: current month (from the injected clock), ai_credit path, shape probe.
    expect(seen[0]).toEqual({ route: AI, params: { enterprise: 'acme-corp', year: 2026, month: 7 } });
    expect(result.details).toContain('current[2026-07] shape:');
    // Call #2: June 2026 rollup.
    expect(seen[1]).toEqual({ route: AI, params: { enterprise: 'acme-corp', year: 2026, month: 6 } });
    expect(result.details).toContain('ai_credit June-2026 rollup:');
    // Call #3: one June day.
    expect(seen[2]).toEqual({ route: AI, params: { enterprise: 'acme-corp', year: 2026, month: 6, day: 24 } });
    expect(result.details).toContain('ai_credit 2026-06-24 day:');
    // Call #4: premium_request April 2026 -- the pre-June billing era, on the sibling path.
    expect(seen[3]).toEqual({ route: PREMIUM, params: { enterprise: 'acme-corp', year: 2026, month: 4 } });
    expect(result.details).toContain('premium_request April-2026 rollup:');
    // Call #5a: the internal seat fetch -- per_page: 1, the ALREADY-validated
    // seats path (R1), no new endpoint (§6.9 statement).
    expect(seen[4]).toEqual({ route: SEATS, params: { enterprise: 'acme-corp', per_page: 1 } });
    // Call #5b: the user-scoped ai_credit probe, using the fetched login as the
    // `?user=` value -- the same validated path + already-pinned `user` param.
    expect(seen[5]).toEqual({ route: AI, params: { enterprise: 'acme-corp', user: STUB_LOGIN, year: 2026, month: 6 } });
    expect(result.details).toContain('user-scoped June probe (first seat):');
    // §6.6: the login fetched internally must never appear in the rendered row.
    expect(result.details).not.toContain(STUB_LOGIN);
  });

  it('skips the user-scoped probe gracefully when the tenant has no seats (no error, no crash)', async () => {
    const octokit = stubOctokit((route) => {
      if (route === SEATS) return { seats: [] };
      return envelope([aiItem()]);
    });

    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });
    expect(result.status).toBe('ok');
    expect(result.details).toContain('user-scoped June probe (first seat): skipped (no seat available to sample)');
  });

  it('reports the HTTP error per sub-call (like every existing probe) and downgrades the row', async () => {
    const octokit = stubOctokit((route, params) => {
      // Fail ONLY the June-24 day call; the others (including seats + the
      // user-scoped call) succeed.
      if (route === AI && params.day === 24) {
        throw Object.assign(new Error('Server Error'), { status: 500 });
      }
      if (route === SEATS) return seatsResponse();
      return envelope([aiItem()]);
    });

    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });
    expect(result.status).toBe('http_error');
    expect(result.details).toContain('ai_credit 2026-06-24 day=HTTP 500: Server Error');
    // The other calls still reported their summaries (independent error handling).
    expect(result.details).toContain('current[2026-07] shape:');
    expect(result.details).toContain('premium_request April-2026 rollup:');
    expect(result.details).toContain('user-scoped June probe (first seat):');
  });

  it('redacts the sampled login from the user-scoped error detail (§6.6 -- err.message can echo the ?user= value)', async () => {
    const octokit = stubOctokit((route, params) => {
      if (route === SEATS) return seatsResponse();
      // Only the user-scoped ai_credit call carries a `user` param. Simulate an
      // error whose message embeds the request URL WITH the login -- the exact
      // leak vector httpErrorDetails would otherwise echo verbatim.
      if (route === AI && typeof params.user === 'string') {
        throw Object.assign(
          new Error(
            `request to https://api.github.com/enterprises/acme-corp/settings/billing/ai_credit/usage?user=${params.user}&year=2026&month=6 failed`,
          ),
          { status: 500 },
        );
      }
      return envelope([aiItem()]);
    });

    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });
    expect(result.status).toBe('http_error');
    // The login must NOT survive anywhere in the rendered row...
    expect(result.details).not.toContain(STUB_LOGIN);
    // ...and the placeholder proves the scrub fired on this exact path.
    expect(result.details).toContain('<redacted-user>');
    // The sub-call is still reported (per-call error isolation), just scrubbed.
    expect(result.details).toContain('user-scoped June probe (first seat)=');
  });

  it('reports an http_error when the internal seat fetch itself fails', async () => {
    const octokit = stubOctokit((route) => {
      if (route === SEATS) throw Object.assign(new Error('Bad credentials'), { status: 401 });
      return envelope([aiItem()]);
    });

    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });
    expect(result.status).toBe('http_error');
    expect(result.details).toContain('user-scoped June probe (first seat)=HTTP 401: Bad credentials');
    // The four documented-window calls still reported cleanly.
    expect(result.details).toContain('current[2026-07] shape:');
  });

  it('flags a shape mismatch when a successful response omits usageItems', async () => {
    const octokit = stubOctokit(() => ({ timePeriod: { year: 2026, month: 6 }, enterprise: 'acme-corp' }));
    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });
    expect(result.status).toBe('shape_mismatch');
    expect(result.details).toContain('SHAPE_MISMATCH (no usageItems in envelope)');
  });
});
