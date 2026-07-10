import type { Octokit } from 'octokit';
import { describe, expect, it } from 'vitest';
import {
  countPerItemUsers,
  runR7,
  summarizeAiCreditRollup,
  summarizeAiCreditShape,
  type AiCreditUsageEnvelope,
  type AiCreditUsageItem,
} from './read-smoke.js';

// R7 probes the ai_credit/premium_request usage report -- a GITHUB-ONLY endpoint
// with no MSW twin (runReadSmoke omits it; runLiveReadSmoke appends it live).
// These tests exercise the summarizers with hand-built envelopes shaped exactly
// as the §6.9-pinned OpenAPI schema (ghec.2026-03-10.json), plus runR7 against a
// stub Octokit -- no MSW server, so there is no unhandled-request surface at all.

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

  describe('summarizeAiCreditRollup (probe #2/#3/#4: zero/nonzero rollups)', () => {
    it('sums AI-credit netQuantity, counts nonzero items, and reports distinct-users n/a', () => {
      const env = envelope([
        aiItem({ netQuantity: 400 }),
        aiItem({ netQuantity: 0 }),
        aiItem({ netQuantity: 250 }),
      ]);
      const out = summarizeAiCreditRollup(env);
      expect(out).toContain('items=3');
      expect(out).toContain('ai-credit items=3');
      expect(out).toContain('Σ netQuantity(ai-credit)=650');
      expect(out).toContain('nonzero(netQuantity>0)=2');
      expect(out).toContain('distinct users=n/a (no per-item user field)');
    });

    it('splits total vs AI-credit items so a non-AI SKU on the endpoint is visible', () => {
      const env = envelope([
        aiItem({ netQuantity: 100 }),
        aiItem({ sku: 'Copilot Premium Request', netQuantity: 999 }), // not the AI-credit sku
        aiItem({ product: 'actions', sku: 'actions_linux', netQuantity: 5 }),
      ]);
      const out = summarizeAiCreditRollup(env);
      expect(out).toContain('items=3');
      expect(out).toContain('ai-credit items=1');
      // Only the ONE AI-credit item's netQuantity counts toward the pool/metered sum.
      expect(out).toContain('Σ netQuantity(ai-credit)=100');
      expect(out).toContain('nonzero(netQuantity>0)=1');
    });

    it('handles an all-zero window (retention-aged / genuinely idle month)', () => {
      const env = envelope([aiItem({ netQuantity: 0 }), aiItem({ netQuantity: 0 })]);
      const out = summarizeAiCreditRollup(env);
      expect(out).toContain('Σ netQuantity(ai-credit)=0');
      expect(out).toContain('nonzero(netQuantity>0)=0');
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

  it('issues the four documented windows and reports one ok row with four labeled parts', async () => {
    const seen: Array<{ route: string; params: Record<string, unknown> }> = [];
    const octokit = stubOctokit((route, params) => {
      seen.push({ route, params });
      return envelope([aiItem({ netQuantity: 400 })]);
    });

    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });

    expect(result.docRef).toBe('R7');
    expect(result.status).toBe('ok');
    expect(result.endpoint).toContain('ai_credit/usage');
    expect(result.endpoint).toContain('premium_request/usage');

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
  });

  it('reports the HTTP error per sub-call (like every existing probe) and downgrades the row', async () => {
    const octokit = stubOctokit((route, params) => {
      // Fail ONLY the June-24 day call; the others succeed.
      if (route === AI && params.day === 24) {
        throw Object.assign(new Error('Server Error'), { status: 500 });
      }
      return envelope([aiItem()]);
    });

    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });
    expect(result.status).toBe('http_error');
    expect(result.details).toContain('ai_credit 2026-06-24 day=HTTP 500: Server Error');
    // The other three still reported their summaries (independent error handling).
    expect(result.details).toContain('current[2026-07] shape:');
    expect(result.details).toContain('premium_request April-2026 rollup:');
  });

  it('flags a shape mismatch when a successful response omits usageItems', async () => {
    const octokit = stubOctokit(() => ({ timePeriod: { year: 2026, month: 6 }, enterprise: 'acme-corp' }));
    const result = await runR7(octokit, 'acme-corp', { year: 2026, month: 7 });
    expect(result.status).toBe('shape_mismatch');
    expect(result.details).toContain('SHAPE_MISMATCH (no usageItems in envelope)');
  });
});
