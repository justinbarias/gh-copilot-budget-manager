import { describe, expect, it } from 'vitest';
import { COST_CENTER_IDS } from './constants.js';
import { CREDITS_USED_ITEMS, USAGE_ITEMS } from './usage.js';
import { HISTORICAL_CREDITS_USED_ITEMS, HISTORICAL_USAGE_ITEMS } from './usage-history.js';

// Task 5.1: fixture-shape tests for the historical usage fixtures. These
// exercise the raw arrays directly (no HTTP/MSW involved) -- handlers.test.ts
// covers the MSW date-filtering contract on top of these same arrays.

describe('HISTORICAL_USAGE_ITEMS (billing view -- enterprise + per-CC daily burn)', () => {
  it('covers exactly the three closed cycles (March, April, May 2026)', () => {
    const yearMonths = new Set(HISTORICAL_USAGE_ITEMS.map((item) => item.date.slice(0, 7)));
    expect(yearMonths).toEqual(new Set(['2026-03', '2026-04', '2026-05']));
  });

  it('itemises every one of the six DEWR cost centers in every closed cycle', () => {
    const ccIds = Object.values(COST_CENTER_IDS);
    for (const yearMonth of ['2026-03', '2026-04', '2026-05']) {
      const monthItems = HISTORICAL_USAGE_ITEMS.filter((item) => item.date.startsWith(yearMonth));
      const seenCcIds = new Set(monthItems.map((item) => item.cost_center_id));
      for (const ccId of ccIds) {
        expect(seenCcIds.has(ccId)).toBe(true);
      }
    }
  });

  it('is never in the metered phase historically (fully pool-covered -- no closed cycle ever exhausted its cap)', () => {
    expect(HISTORICAL_USAGE_ITEMS.every((item) => item.net_amount === 0)).toBe(true);
    expect(HISTORICAL_USAGE_ITEMS.every((item) => item.discount_amount === item.gross_amount)).toBe(true);
  });

  it('lands each closed cycle in the 380k-470k plausible band (under the 567,000 pool)', () => {
    for (const yearMonth of ['2026-03', '2026-04', '2026-05']) {
      const total = HISTORICAL_USAGE_ITEMS.filter((item) => item.date.startsWith(yearMonth)).reduce(
        (sum, item) => sum + item.quantity,
        0,
      );
      expect(total).toBeGreaterThanOrEqual(380_000);
      expect(total).toBeLessThanOrEqual(470_000);
      expect(total).toBeLessThan(567_000); // never exhausts the pool
    }
  });

  it('pins the exact per-cycle totals this generator produces (regression guard)', () => {
    const totalFor = (yearMonth: string) =>
      HISTORICAL_USAGE_ITEMS.filter((item) => item.date.startsWith(yearMonth)).reduce((sum, item) => sum + item.quantity, 0);
    expect(totalFor('2026-03')).toBe(405_005);
    expect(totalFor('2026-04')).toBe(429_004);
    expect(totalFor('2026-05')).toBe(452_014);
  });

  it('shows weekday burn meaningfully higher than weekend burn (ratio > 2) for a sampled cycle', () => {
    const marchItems = HISTORICAL_USAGE_ITEMS.filter((item) => item.date.startsWith('2026-03'));
    const isWeekendDate = (date: string) => {
      const dow = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      return dow === 0 || dow === 6;
    };
    const weekdayDates = new Set(marchItems.filter((item) => !isWeekendDate(item.date)).map((item) => item.date));
    const weekendDates = new Set(marchItems.filter((item) => isWeekendDate(item.date)).map((item) => item.date));
    expect(weekdayDates.size).toBeGreaterThan(0);
    expect(weekendDates.size).toBeGreaterThan(0);

    const sumByDateSet = (dates: Set<string>) =>
      marchItems.filter((item) => dates.has(item.date)).reduce((sum, item) => sum + item.quantity, 0);
    const meanWeekday = sumByDateSet(weekdayDates) / weekdayDates.size;
    const meanWeekend = sumByDateSet(weekendDates) / weekendDates.size;
    expect(meanWeekday / meanWeekend).toBeCloseTo(10 / 3, 1); // WEEKEND_RATIO = 0.3 -> exactly 3.33x
    expect(meanWeekday / meanWeekend).toBeGreaterThan(2);
  });

  it('does not touch usage.ts USAGE_ITEMS (additive only -- current-cycle array is untouched)', () => {
    // Regression guard for the current-cycle pins (github-impl.test.ts):
    // totalQuantity 193,036, June pool burn 189,800. This file's existence
    // must not change USAGE_ITEMS's own contents.
    expect(USAGE_ITEMS.some((item) => item.date.startsWith('2026-03'))).toBe(false);
    expect(USAGE_ITEMS.some((item) => item.date.startsWith('2026-04'))).toBe(false);
    expect(USAGE_ITEMS.some((item) => item.date.startsWith('2026-05'))).toBe(false);
    expect(USAGE_ITEMS.reduce((sum, item) => sum + item.quantity, 0)).toBe(193_036);
  });
});

describe('HISTORICAL_CREDITS_USED_ITEMS (metrics view -- per-user daily burn)', () => {
  const NAMED_PERSONAS = ['emily-zhao', 'liam-obrien', 'faisal-noor', 'hannah-webb', 'noah-tanaka'];

  it('carries rows for every named persona across all three closed cycles', () => {
    for (const login of NAMED_PERSONAS) {
      const rows = HISTORICAL_CREDITS_USED_ITEMS.filter((item) => item.user_login === login);
      const yearMonths = new Set(rows.map((item) => item.date.slice(0, 7)));
      expect(yearMonths).toEqual(new Set(['2026-03', '2026-04', '2026-05']));
    }
  });

  it('shows weekday burn meaningfully higher than weekend burn (ratio > 2) for emily-zhao in March', () => {
    const rows = HISTORICAL_CREDITS_USED_ITEMS.filter(
      (item) => item.user_login === 'emily-zhao' && item.date.startsWith('2026-03'),
    );
    const isWeekendDate = (date: string) => {
      const dow = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      return dow === 0 || dow === 6;
    };
    const weekdayRows = rows.filter((item) => !isWeekendDate(item.date));
    const weekendRows = rows.filter((item) => isWeekendDate(item.date));
    expect(weekdayRows.length).toBeGreaterThan(0);
    expect(weekendRows.length).toBeGreaterThan(0);
    const meanWeekday = weekdayRows.reduce((sum, item) => sum + item.ai_credits_used, 0) / weekdayRows.length;
    const meanWeekend = weekendRows.reduce((sum, item) => sum + item.ai_credits_used, 0) / weekendRows.length;
    expect(meanWeekday / meanWeekend).toBeGreaterThan(2);
  });

  it('preserves the noah-tanaka Aug/Sep allowance-cliff edge fixture untouched', () => {
    const cliffRows = CREDITS_USED_ITEMS.filter((item) => item.user_login === 'noah-tanaka');
    expect(cliffRows).toEqual([
      { date: '2026-08-31', user_id: '7219', user_login: 'noah-tanaka', ai_credits_used: 468 },
      { date: '2026-09-01', user_id: '7219', user_login: 'noah-tanaka', ai_credits_used: 468 },
    ]);
    // The historical rows added for noah-tanaka (and everyone else) are a
    // SEPARATE array (only reachable via since/until) -- they must never
    // merge into CREDITS_USED_ITEMS, i.e. it carries no March/April/May rows.
    expect(CREDITS_USED_ITEMS.some((item) => ['2026-03', '2026-04', '2026-05'].includes(item.date.slice(0, 7)))).toBe(
      false,
    );
  });

  it('pins each named persona\'s exact historical total (regression guard)', () => {
    const totalFor = (login: string) =>
      HISTORICAL_CREDITS_USED_ITEMS.filter((item) => item.user_login === login).reduce(
        (sum, item) => sum + item.ai_credits_used,
        0,
      );
    expect(totalFor('emily-zhao')).toBe(25_147);
    expect(totalFor('liam-obrien')).toBe(22_609);
    expect(totalFor('faisal-noor')).toBe(19_181);
    expect(totalFor('hannah-webb')).toBe(20_006);
    expect(totalFor('noah-tanaka')).toBe(17_890);
  });

  it('does not touch usage.ts CREDITS_USED_ITEMS (additive only -- current-cycle array is untouched)', () => {
    // Regression guard: 149 rows summing to 115,216 credits (current cycle +
    // the noah-tanaka cliff rows) -- the same total this array carried before
    // Task 5.1 added this file.
    expect(CREDITS_USED_ITEMS).toHaveLength(149);
    expect(CREDITS_USED_ITEMS.reduce((sum, item) => sum + item.ai_credits_used, 0)).toBe(115_216);
  });
});
