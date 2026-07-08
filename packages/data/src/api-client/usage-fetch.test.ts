import { describe, expect, it } from 'vitest';
import { isMonthlyAggregateGrain, normalizeUsageDate } from './usage-fetch.js';

// Item 23 (live-pinned 2026-07-09 by the maintainer's R5 date histogram):
// live usage items are monthly aggregates dated with ISO TIME SUFFIXES
// ("2026-06-01T00:00:00Z"). These pins cover the two boundary helpers the
// grain-agnostic cycle math is built on.
describe('normalizeUsageDate', () => {
  it('passes plain YYYY-MM-DD dates through unchanged (the fixture/per-day form)', () => {
    expect(normalizeUsageDate('2026-06-12')).toBe('2026-06-12');
  });

  it('truncates full ISO datetimes to day precision (the live form)', () => {
    expect(normalizeUsageDate('2026-06-01T00:00:00Z')).toBe('2026-06-01');
    expect(normalizeUsageDate('2026-07-01T00:00:00.000Z')).toBe('2026-07-01');
  });

  it('passes unrecognized strings through untouched (defensive)', () => {
    expect(normalizeUsageDate('not-a-date')).toBe('not-a-date');
  });

  // THE REGRESSION PIN: the exact live money bug this normalization fixes.
  // The old cycle math appended its own time suffix to the item date --
  // Date.parse('2026-07-01T00:00:00Z' + 'T00:00:00.000Z') is NaN, so every
  // NaN dayIndex comparison was false and every live row silently fell out
  // of inCycle/buildDailyBurn: the maintainer's Overview showed actual burn
  // = 0 against real usage. Post-normalization the same construction parses.
  it('regression pin: the OLD un-normalized path yields NaN on live ISO-datetime dates', () => {
    const liveDate = '2026-07-01T00:00:00Z';
    expect(Number.isNaN(Date.parse(`${liveDate}T00:00:00.000Z`))).toBe(true); // the old, broken construction
    expect(Number.isNaN(Date.parse(`${normalizeUsageDate(liveDate)}T00:00:00.000Z`))).toBe(false); // the fix
  });
});

describe('isMonthlyAggregateGrain', () => {
  it('detects the live signature: every row on ONE first-of-month date', () => {
    expect(
      isMonthlyAggregateGrain([{ date: '2026-07-01' }, { date: '2026-07-01' }, { date: '2026-07-01' }]),
    ).toBe(true);
  });

  it('reads per-day feeds (many distinct dates) as per-day', () => {
    expect(isMonthlyAggregateGrain([{ date: '2026-06-02' }, { date: '2026-06-04' }, { date: '2026-06-05' }])).toBe(false);
  });

  it('a single distinct NON-first-of-month date is per-day (e.g. the Aug-31 cliff fixture month)', () => {
    expect(isMonthlyAggregateGrain([{ date: '2026-08-31' }])).toBe(false);
  });

  it('an empty set is not aggregate', () => {
    expect(isMonthlyAggregateGrain([])).toBe(false);
  });
});
