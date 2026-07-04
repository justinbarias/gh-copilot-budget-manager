import { describe, expect, it } from 'vitest';
import {
  isUserAtRiskOfUlbBlock,
  resolveEffectiveUlb,
  ULB_AT_RISK_UTILIZATION_THRESHOLD,
  type UlbCandidate,
} from './ulb';

describe('resolveEffectiveUlb', () => {
  const candidates: UlbCandidate[] = [
    { scope: 'universal', entityName: 'acme-enterprise', amountCredits: 4000 },
    { scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 4500 },
    { scope: 'individual', entityName: 'user-07', amountCredits: 6000 },
    { scope: 'individual', entityName: 'user-20', amountCredits: 0 },
  ];

  it('picks the individual override over everything else', () => {
    expect(resolveEffectiveUlb('user-07', 'Platform', candidates)).toEqual({
      amountCredits: 6000,
      scope: 'individual',
    });
  });

  it('picks a $0 individual override (always blocks -- CLAUDE.md §5)', () => {
    expect(resolveEffectiveUlb('user-20', 'Data & Analytics', candidates)).toEqual({
      amountCredits: 0,
      scope: 'individual',
    });
  });

  it('falls back to the CCULB when there is no individual override', () => {
    expect(resolveEffectiveUlb('user-01', 'Platform', candidates)).toEqual({
      amountCredits: 4500,
      scope: 'cost-center',
    });
  });

  it('falls back to universal when neither individual nor CCULB apply', () => {
    expect(resolveEffectiveUlb('user-26', 'Marketing (Cap-Bound)', candidates)).toEqual({
      amountCredits: 4000,
      scope: 'universal',
    });
  });

  it('falls back to universal for a user with no cost center at all', () => {
    expect(resolveEffectiveUlb('user-99', null, candidates)).toEqual({
      amountCredits: 4000,
      scope: 'universal',
    });
  });

  it('returns null when no budget applies at any scope', () => {
    expect(resolveEffectiveUlb('user-99', 'Nowhere', [])).toBeNull();
  });

  it('does not apply a CCULB scoped to a different cost center', () => {
    const onlyPlatformCculb: UlbCandidate[] = [
      { scope: 'multi_user_cost_center', entityName: 'Platform', amountCredits: 4500 },
    ];
    expect(resolveEffectiveUlb('user-16', 'Data & Analytics', onlyPlatformCculb)).toBeNull();
  });
});

describe('isUserAtRiskOfUlbBlock', () => {
  it('is never at risk with no effective ULB', () => {
    expect(isUserAtRiskOfUlbBlock(1000, null)).toBe(false);
  });

  it('is always at risk (blocked) with a $0 ULB, even at 0 usage', () => {
    expect(isUserAtRiskOfUlbBlock(0, { amountCredits: 0, scope: 'individual' })).toBe(true);
  });

  it('is not at risk comfortably under the threshold', () => {
    expect(isUserAtRiskOfUlbBlock(420, { amountCredits: 4500, scope: 'cost-center' })).toBe(false);
  });

  it('is at risk exactly at the threshold', () => {
    const ulb = { amountCredits: 1000, scope: 'universal' as const };
    expect(isUserAtRiskOfUlbBlock(1000 * ULB_AT_RISK_UTILIZATION_THRESHOLD, ulb)).toBe(true);
  });

  it('is not at risk just under the threshold', () => {
    const ulb = { amountCredits: 1000, scope: 'universal' as const };
    expect(isUserAtRiskOfUlbBlock(1000 * ULB_AT_RISK_UTILIZATION_THRESHOLD - 1, ulb)).toBe(false);
  });

  it('is at risk over the ULB entirely', () => {
    expect(isUserAtRiskOfUlbBlock(5000, { amountCredits: 4000, scope: 'universal' })).toBe(true);
  });
});
