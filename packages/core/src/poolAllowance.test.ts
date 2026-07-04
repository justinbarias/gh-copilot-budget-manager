import { describe, expect, it } from 'vitest';
import { poolAllowanceCredits } from './poolAllowance';

describe('poolAllowanceCredits', () => {
  it('uses the standard Business per-seat allowance before the promo window opens', () => {
    const credits = poolAllowanceCredits(100, new Date('2026-05-31T23:59:59.999Z'), {
      edition: 'business',
      existingCustomer: true,
    });
    expect(credits).toBe(100 * 1900);
  });

  it('uses the promo Business per-seat allowance for an existing customer inside the window', () => {
    const credits = poolAllowanceCredits(100, new Date('2026-06-01T00:00:00.000Z'), {
      edition: 'business',
      existingCustomer: true,
    });
    expect(credits).toBe(100 * 3000);
  });

  it('uses the standard Business allowance for a non-existing-customer even inside the promo window', () => {
    const credits = poolAllowanceCredits(100, new Date('2026-07-15T00:00:00.000Z'), {
      edition: 'business',
      existingCustomer: false,
    });
    expect(credits).toBe(100 * 1900);
  });

  it('falls back to standard the instant the promo window closes on 1 Sep 2026 (the cliff)', () => {
    const justBefore = poolAllowanceCredits(100, new Date('2026-08-31T23:59:59.999Z'), {
      edition: 'business',
      existingCustomer: true,
    });
    const atCliff = poolAllowanceCredits(100, new Date('2026-09-01T00:00:00.000Z'), {
      edition: 'business',
      existingCustomer: true,
    });
    expect(justBefore).toBe(100 * 3000);
    expect(atCliff).toBe(100 * 1900);
  });

  it('applies the Enterprise standard and promo per-seat rates', () => {
    const promo = poolAllowanceCredits(50, new Date('2026-07-01T00:00:00.000Z'), {
      edition: 'enterprise',
      existingCustomer: true,
    });
    const standard = poolAllowanceCredits(50, new Date('2026-09-01T00:00:00.000Z'), {
      edition: 'enterprise',
      existingCustomer: true,
    });
    expect(promo).toBe(50 * 7000);
    expect(standard).toBe(50 * 3900);
  });

  it('returns 0 credits for 0 licenses', () => {
    expect(
      poolAllowanceCredits(0, new Date('2026-07-01T00:00:00.000Z'), {
        edition: 'enterprise',
        existingCustomer: true,
      }),
    ).toBe(0);
  });
});
