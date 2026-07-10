import { describe, expect, it, vi } from 'vitest';
import { fetchAiCreditUsage, sumNetQuantity, type AiCreditUsageLineItem } from './ai-credit-usage.js';

// The billing ai_credit/usage wrapper is a thin, typed call over an
// already-§6.9-machine-verified endpoint (docs/api-surface-validation.md rows N1
// + "Live-read smoke R7"). These tests stub Octokit with OpenAPI-shaped
// envelopes and hand-check the sum-all-items rule + defensive normalization.
// Every expected sum is computed by hand in the comments.

function item(overrides: Partial<AiCreditUsageLineItem>): AiCreditUsageLineItem {
  return {
    product: 'Copilot',
    sku: 'Copilot AI Credits',
    model: 'gpt-4.1',
    unitType: 'credit',
    pricePerUnit: 0.01,
    grossQuantity: 0,
    grossAmount: 0,
    discountQuantity: 0,
    discountAmount: 0,
    netQuantity: 0,
    netAmount: 0,
    ...overrides,
  };
}

function stubOctokit(data: unknown) {
  return { request: vi.fn().mockResolvedValue({ data }) } as unknown as Parameters<typeof fetchAiCreditUsage>[0];
}

describe('fetchAiCreditUsage', () => {
  it('passes enterprise + query params through to octokit.request and returns the typed envelope', async () => {
    const octokit = stubOctokit({
      timePeriod: { year: 2026, month: 6 },
      enterprise: 'acme',
      usageItems: [item({ netQuantity: 100 })],
    });
    const report = await fetchAiCreditUsage(octokit, 'acme', { year: 2026, month: 6, user: 'octocat' });
    expect((octokit.request as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'GET /enterprises/{enterprise}/settings/billing/ai_credit/usage',
      { enterprise: 'acme', year: 2026, month: 6, user: 'octocat' },
    );
    expect(report.usageItems).toHaveLength(1);
    expect(report.timePeriod).toEqual({ year: 2026, month: 6 });
  });

  it('normalizes a missing/non-array usageItems to [] (defensive)', async () => {
    const report = await fetchAiCreditUsage(stubOctokit({ timePeriod: { year: 2026, month: 6 }, enterprise: 'acme' }), 'acme', {
      year: 2026,
      month: 6,
    });
    expect(report.usageItems).toEqual([]);
  });

  it('normalizes a null data body to an empty-items report (never throws downstream)', async () => {
    const report = await fetchAiCreditUsage(stubOctokit(null), 'acme', { year: 2026, month: 6 });
    expect(report.usageItems).toEqual([]);
  });
});

describe('sumNetQuantity (sum ALL items -- no product/sku filter)', () => {
  it('sums netQuantity across every item regardless of product-label case', () => {
    // 100 (Copilot capital-C) + 6.39 (copilot lower) + 300.5 (Foo) = 406.89
    const items = [
      item({ product: 'Copilot', netQuantity: 100 }),
      item({ product: 'copilot', netQuantity: 6.39 }),
      item({ product: 'Foo', sku: 'whatever', netQuantity: 300.5 }),
    ];
    expect(sumNetQuantity({ usageItems: items })).toBeCloseTo(406.89, 10);
  });

  it('is 0 for an empty report', () => {
    expect(sumNetQuantity({ usageItems: [] })).toBe(0);
  });

  it('treats a missing netQuantity as 0', () => {
    // 42 + (missing -> 0) = 42
    const items = [item({ netQuantity: 42 }), { ...item({}), netQuantity: undefined } as unknown as AiCreditUsageLineItem];
    expect(sumNetQuantity({ usageItems: items })).toBe(42);
  });
});
