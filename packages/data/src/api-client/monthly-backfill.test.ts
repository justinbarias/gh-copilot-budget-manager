import { describe, expect, it, vi } from 'vitest';
import { backfillMonthlyCredits, type MonthlyBackfillSeat } from './github-impl.js';
import type { AiCreditUsageLineItem } from './ai-credit-usage.js';

// Fan-out targeting + remainder math for the monthly per-user AI-credit backfill
// (github-impl.ts's backfillMonthlyCredits). Every expected count/sum is
// hand-computed in the comments; the stub Octokit returns OpenAPI-shaped
// envelopes keyed by (year, month, ?user). All numbers here are chosen so the
// arithmetic is checkable by eye.

type QueryKey = string; // `${year}-${MM}` or `${year}-${MM}:${login}`
type Handler = () => { data: unknown } | Promise<{ data: unknown }>;

function items(...qtys: number[]): { usageItems: AiCreditUsageLineItem[] } {
  return {
    usageItems: qtys.map((netQuantity) => ({
      product: 'Copilot',
      sku: 'Copilot AI Credits',
      model: 'gpt-4.1',
      unitType: 'credit',
      pricePerUnit: 0.01,
      grossQuantity: netQuantity,
      grossAmount: netQuantity * 0.01,
      discountQuantity: 0,
      discountAmount: 0,
      netQuantity,
      netAmount: netQuantity * 0.01,
    })),
  };
}

interface StubResult {
  octokit: Parameters<typeof backfillMonthlyCredits>[0];
  calls: Array<{ year: number; month: number; user?: string }>;
}

function stub(handlers: Record<QueryKey, Handler>): StubResult {
  const calls: StubResult['calls'] = [];
  const request = vi.fn(async (_route: string, params: { year: number; month: number; user?: string }) => {
    calls.push({ year: params.year, month: params.month, user: params.user });
    const mm = String(params.month).padStart(2, '0');
    const key = params.user ? `${params.year}-${mm}:${params.user}` : `${params.year}-${mm}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected query: ${key}`);
    return handler();
  });
  return { octokit: { request } as unknown as StubResult['octokit'], calls };
}

const SEATS: MonthlyBackfillSeat[] = [
  { id: '1', login: 'alice' },
  { id: '2', login: 'bob' },
  { id: '3', login: 'carol' },
];

describe('backfillMonthlyCredits', () => {
  it('backfills a candidate month: attributed rows + remainder, skips zero seats, stops at the era floor, never touches the current month', async () => {
    // currentMonth 2026-08 -> first candidate 2026-07.
    //   2026-07 aggregate Σ=1000 (600+400); alice 400, bob 100, carol 0 (skip).
    //     Σ attributed = 500 -> remainder 500 (> eps) -> NULL row 500.
    //     Rows: alice 400, bob 100, remainder 500 (3 rows).
    //   2026-06 aggregate [] -> era floor, break (no rows).
    const { octokit, calls } = stub({
      '2026-07': () => ({ data: items(600, 400) }),
      '2026-07:alice': () => ({ data: items(400) }),
      '2026-07:bob': () => ({ data: items(100) }),
      '2026-07:carol': () => ({ data: items() }), // 0 -> skipped
      '2026-06': () => ({ data: items() }), // empty aggregate -> era floor
    });

    const result = await backfillMonthlyCredits(octokit, 'acme', {
      currentMonth: '2026-08',
      seats: SEATS,
      bankedMonths: new Set(),
    });

    expect(result.eraFloorMonth).toBe('2026-06');
    expect(result.monthsPersisted).toEqual(['2026-07']);
    expect(result.rows).toEqual([
      { month: '2026-07', userId: '1', userLogin: 'alice', creditsUsed: 400 },
      { month: '2026-07', userId: '2', userLogin: 'bob', creditsUsed: 100 },
      { month: '2026-07', userId: null, userLogin: null, creditsUsed: 500 },
    ]);
    // The current (incomplete) month 2026-08 is NEVER queried.
    expect(calls.some((c) => c.month === 8)).toBe(false);
    // The era-floor month produced no persisted row and is not "persisted".
    expect(result.rows.some((r) => r.month === '2026-06')).toBe(false);
  });

  it('skips banked months (never refetched) and keeps scanning past them', async () => {
    // 2026-07 banked -> skipped (no request). 2026-06 backfilled. 2026-05 floor.
    const { octokit, calls } = stub({
      '2026-06': () => ({ data: items(200) }),
      '2026-06:alice': () => ({ data: items(200) }),
      '2026-06:bob': () => ({ data: items() }),
      '2026-06:carol': () => ({ data: items() }),
      '2026-05': () => ({ data: items() }), // era floor
    });

    const result = await backfillMonthlyCredits(octokit, 'acme', {
      currentMonth: '2026-08',
      seats: SEATS,
      bankedMonths: new Set(['2026-07']),
    });

    expect(result.monthsSkippedBanked).toEqual(['2026-07']);
    expect(calls.some((c) => c.month === 7)).toBe(false); // banked -> never requested
    expect(result.monthsPersisted).toEqual(['2026-06']);
    // alice 200, Σ attributed 200, aggregate 200 -> remainder 0 (<= eps) -> no NULL row.
    expect(result.rows).toEqual([{ month: '2026-06', userId: '1', userLogin: 'alice', creditsUsed: 200 }]);
    expect(result.eraFloorMonth).toBe('2026-05');
  });

  it('is month-atomic: a mid-month fan-out failure persists nothing for that month; other months land', async () => {
    // 2026-07: aggregate OK but bob's per-seat call throws -> month aborted (0 rows).
    // 2026-06: clean -> rows land. 2026-05: era floor.
    const { octokit } = stub({
      '2026-07': () => ({ data: items(1000) }),
      '2026-07:alice': () => ({ data: items(400) }),
      '2026-07:bob': () => {
        throw Object.assign(new Error('boom user=bob'), { status: 500 });
      },
      '2026-07:carol': () => ({ data: items(50) }),
      '2026-06': () => ({ data: items(300) }),
      '2026-06:alice': () => ({ data: items(300) }),
      '2026-06:bob': () => ({ data: items() }),
      '2026-06:carol': () => ({ data: items() }),
      '2026-05': () => ({ data: items() }),
    });

    const result = await backfillMonthlyCredits(octokit, 'acme', {
      currentMonth: '2026-08',
      seats: SEATS,
      bankedMonths: new Set(),
    });

    expect(result.monthsFailed).toEqual(['2026-07']);
    expect(result.rows.some((r) => r.month === '2026-07')).toBe(false); // no partial rows
    expect(result.monthsPersisted).toEqual(['2026-06']);
    expect(result.rows).toEqual([{ month: '2026-06', userId: '1', userLogin: 'alice', creditsUsed: 300 }]);
    expect(result.eraFloorMonth).toBe('2026-05');
  });

  it('persists a positive remainder above the epsilon; never one at/below it', async () => {
    // aggregate 100.006; alice 100 -> remainder 0.006 (> 0.005) -> NULL row 0.006.
    const above = stub({
      '2026-06': () => ({ data: items(100.006) }),
      '2026-06:alice': () => ({ data: items(100) }),
      '2026-06:bob': () => ({ data: items() }),
      '2026-06:carol': () => ({ data: items() }),
      '2026-05': () => ({ data: items() }),
    });
    const rAbove = await backfillMonthlyCredits(above.octokit, 'acme', {
      currentMonth: '2026-07',
      seats: SEATS,
      bankedMonths: new Set(),
    });
    const remainderRow = rAbove.rows.find((r) => r.userId === null);
    expect(remainderRow).toBeDefined();
    expect(remainderRow!.creditsUsed).toBeCloseTo(0.006, 10);

    // aggregate 100.004; alice 100 -> remainder 0.004 (<= 0.005) -> NO NULL row.
    const below = stub({
      '2026-06': () => ({ data: items(100.004) }),
      '2026-06:alice': () => ({ data: items(100) }),
      '2026-06:bob': () => ({ data: items() }),
      '2026-06:carol': () => ({ data: items() }),
      '2026-05': () => ({ data: items() }),
    });
    const rBelow = await backfillMonthlyCredits(below.octokit, 'acme', {
      currentMonth: '2026-07',
      seats: SEATS,
      bankedMonths: new Set(),
    });
    expect(rBelow.rows.some((r) => r.userId === null)).toBe(false);
    expect(rBelow.rows).toEqual([{ month: '2026-06', userId: '1', userLogin: 'alice', creditsUsed: 100 }]);
  });

  it('surfaces a negative remainder (Σ attributed > aggregate) but persists no remainder row', async () => {
    // aggregate 300; alice 400 -> remainder -100 -> negative, no NULL row, alice still persisted.
    const { octokit } = stub({
      '2026-06': () => ({ data: items(300) }),
      '2026-06:alice': () => ({ data: items(400) }),
      '2026-06:bob': () => ({ data: items() }),
      '2026-06:carol': () => ({ data: items() }),
      '2026-05': () => ({ data: items() }),
    });
    const result = await backfillMonthlyCredits(octokit, 'acme', {
      currentMonth: '2026-07',
      seats: SEATS,
      bankedMonths: new Set(),
    });
    expect(result.monthsNegativeRemainder).toEqual(['2026-06']);
    expect(result.rows.some((r) => r.userId === null)).toBe(false);
    expect(result.rows).toEqual([{ month: '2026-06', userId: '1', userLogin: 'alice', creditsUsed: 400 }]);
    expect(result.monthsPersisted).toEqual(['2026-06']);
  });

  it('walks the previous-month arithmetic across a year boundary', async () => {
    // currentMonth 2026-01 -> first candidate 2025-12 (year wrap), then 2025-11 floor.
    const { octokit, calls } = stub({
      '2025-12': () => ({ data: items(10) }),
      '2025-12:alice': () => ({ data: items(10) }),
      '2025-12:bob': () => ({ data: items() }),
      '2025-12:carol': () => ({ data: items() }),
      '2025-11': () => ({ data: items() }), // era floor
    });
    const result = await backfillMonthlyCredits(octokit, 'acme', {
      currentMonth: '2026-01',
      seats: SEATS,
      bankedMonths: new Set(),
    });
    expect(calls[0]).toMatchObject({ year: 2025, month: 12 });
    expect(result.monthsPersisted).toEqual(['2025-12']);
    expect(result.eraFloorMonth).toBe('2025-11');
  });
});
