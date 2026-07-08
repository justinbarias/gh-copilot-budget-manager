import { describe, expect, it } from 'vitest';
import { normalizeIncludedUsageCap } from './cost-center-cap.js';

// Pure-mapper pins for the live crash fix (2026-07-08: real GHEC cost centers
// carry flat ai_credit_pool_* fields, not the internal included_usage_cap --
// reading .included_usage_cap.enabled crashed every controls path live). All
// expected values are hand-computed; the two flagged assumptions (USD units,
// 'block' overflow default) are pinned EXPLICITLY so a future re-pin from the
// maintainer's smoke run has exactly one test to update per assumption.
describe('normalizeIncludedUsageCap', () => {
  it('passes the internal (MSW/sim) shape through exactly as-is', () => {
    expect(
      normalizeIncludedUsageCap({
        id: 'cc-1',
        included_usage_cap: { enabled: true, computed_limit_credits: 168_000, overflow: 'block' },
      }),
    ).toEqual({ enabled: true, computed_limit_credits: 168_000, overflow: 'block' });

    expect(
      normalizeIncludedUsageCap({
        included_usage_cap: { enabled: true, computed_limit_credits: 56_000, overflow: 'metered' },
      }),
    ).toEqual({ enabled: true, computed_limit_credits: 56_000, overflow: 'metered' });
  });

  it('maps the real GHEC wire: enabled from ai_credit_pool_enabled, limit from target_amount under the FLAGGED USD assumption ($560.00 -> 56,000 credits)', () => {
    expect(
      normalizeIncludedUsageCap({
        id: 'cc-real',
        name: 'Real Wire CC',
        ai_credit_pool_enabled: true,
        ai_credit_pool_state: { target_amount: 560, current_amount: 123.45 },
      }),
    ).toEqual({
      enabled: true,
      // FLAGGED unit assumption #1: target_amount read as USD dollars ->
      // credits = round(560 x 100). If the maintainer's smoke pins CREDITS
      // instead, this expectation becomes 560.
      computed_limit_credits: 56_000,
      // FLAGGED assumption #2: no overflow-suggestive key present -> the
      // conservative 'block' default.
      overflow: 'block',
    });
  });

  it("sniffs an overflow-suggestive key carrying a literal 'block'/'metered' value, on the object or its pool state", () => {
    expect(
      normalizeIncludedUsageCap({
        ai_credit_pool_enabled: true,
        ai_credit_pool_state: { target_amount: 100 },
        ai_credit_pool_overflow_behavior: 'metered',
      }).overflow,
    ).toBe('metered');

    expect(
      normalizeIncludedUsageCap({
        ai_credit_pool_enabled: true,
        ai_credit_pool_state: { target_amount: 100, on_exceed: 'block' },
      }).overflow,
    ).toBe('block');

    // A boolean candidate is deliberately NOT mapped (polarity is a guess:
    // allow_overflow:true vs block_on_exceed:true would mean opposites) --
    // falls through to the 'block' default.
    expect(
      normalizeIncludedUsageCap({
        ai_credit_pool_enabled: true,
        ai_credit_pool_state: { target_amount: 100 },
        block_on_exceed: true,
      }).overflow,
    ).toBe('block');
  });

  it('a cost center with NO cap fields at all maps to the disabled default -- never throws (the exact live crash shape)', () => {
    expect(normalizeIncludedUsageCap({ id: 'cc-bare', name: 'Bare', state: 'active', resources: [] })).toEqual({
      enabled: false,
      computed_limit_credits: 0,
      overflow: 'block',
    });
  });

  it('is total: pool flag without state, state without target, fractional USD, and non-object inputs all map without throwing', () => {
    // Enabled but no state object -> enabled with a 0 limit, not a crash.
    expect(normalizeIncludedUsageCap({ ai_credit_pool_enabled: true })).toEqual({
      enabled: true,
      computed_limit_credits: 0,
      overflow: 'block',
    });
    // State present but no numeric target_amount.
    expect(normalizeIncludedUsageCap({ ai_credit_pool_enabled: true, ai_credit_pool_state: { current_amount: 12 } })).toEqual({
      enabled: true,
      computed_limit_credits: 0,
      overflow: 'block',
    });
    // Fractional USD rounds at the cent boundary: $123.456 -> 12,346 credits.
    expect(
      normalizeIncludedUsageCap({ ai_credit_pool_enabled: false, ai_credit_pool_state: { target_amount: 123.456 } })
        .computed_limit_credits,
    ).toBe(12_346);
    // Defensive: non-object input.
    expect(normalizeIncludedUsageCap(null)).toEqual({ enabled: false, computed_limit_credits: 0, overflow: 'block' });
    expect(normalizeIncludedUsageCap(undefined)).toEqual({ enabled: false, computed_limit_credits: 0, overflow: 'block' });
  });
});
