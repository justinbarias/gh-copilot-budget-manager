import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillDailyCredits, readDailyCreditsFactsFor } from './github-impl.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { aiCreditDailyFact, costCenter, snapshot } from '../db/schema.js';
import type { AiCreditUsageLineItem } from './ai-credit-usage.js';

// Fan-out targeting + winner rule for the daily per-scope AI-credit backfill
// (github-impl.ts's backfillDailyCredits / readDailyCreditsFactsFor, migration
// 0008). Every expected count/row is hand-computed in the comments; the stub
// Octokit returns OpenAPI-shaped envelopes keyed by (year, month, ?day,
// ?cost_center_id). The daily-fact billing world does NOT zero-fill and its
// enterprise row is the tenant TOTAL (not Σ CC rows) -- the fixtures reflect
// that (ent != cc-a + cc-b, unassociated usage exists).

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

interface StubCall {
  year: number;
  month: number;
  day?: number;
  cost_center_id?: string;
}
interface StubResult {
  octokit: Parameters<typeof backfillDailyCredits>[0];
  calls: StubCall[];
}

// Key convention:
//   `YYYY-MM`                    month probe (era-floor scan; no day)
//   `YYYY-MM-DD`                 enterprise day aggregate (no cost_center_id)
//   `YYYY-MM-DD@<cc>`            cost-center day aggregate
function stub(handlers: Record<string, Handler>): StubResult {
  const calls: StubCall[] = [];
  const request = vi.fn(
    async (_route: string, params: { year: number; month: number; day?: number; cost_center_id?: string }) => {
      calls.push({ year: params.year, month: params.month, day: params.day, cost_center_id: params.cost_center_id });
      const mm = String(params.month).padStart(2, '0');
      let key: string;
      if (params.day === undefined) {
        key = `${params.year}-${mm}`;
      } else {
        const dd = String(params.day).padStart(2, '0');
        key = params.cost_center_id ? `${params.year}-${mm}-${dd}@${params.cost_center_id}` : `${params.year}-${mm}-${dd}`;
      }
      const handler = handlers[key];
      if (!handler) throw new Error(`unexpected query: ${key}`);
      return handler();
    },
  );
  return { octokit: { request } as unknown as StubResult['octokit'], calls };
}

describe('backfillDailyCredits', () => {
  it('era floor via a backward month probe, then fans out every day of the data era across enterprise + each CC', async () => {
    // today 2026-06-03. Month scan: 2026-06 has data, 2026-05 empty -> floor
    // 2026-05, earliest-with-data 2026-06. Enumerate 06-01..06-03 (3 days), and
    // for each: enterprise (no cost_center_id) + cc-a + cc-b = 3 rows/day = 9.
    // Enterprise is the tenant TOTAL, deliberately != cc-a+cc-b (unassociated).
    const { octokit, calls } = stub({
      '2026-06': () => ({ data: items(1) }), // nonempty -> has data
      '2026-05': () => ({ data: items() }), // empty aggregate -> era floor
      '2026-06-01': () => ({ data: items(100) }),
      '2026-06-01@cc-a': () => ({ data: items(60) }),
      '2026-06-01@cc-b': () => ({ data: items(30) }),
      '2026-06-02': () => ({ data: items(120) }),
      '2026-06-02@cc-a': () => ({ data: items(70) }),
      '2026-06-02@cc-b': () => ({ data: items(40) }),
      '2026-06-03': () => ({ data: items(50, 30) }), // two items -> Σ netQuantity = 80
      '2026-06-03@cc-a': () => ({ data: items(50) }),
      '2026-06-03@cc-b': () => ({ data: items(20) }),
    });

    const result = await backfillDailyCredits(octokit, 'acme', {
      today: '2026-06-03',
      costCenterIds: ['cc-a', 'cc-b'],
      bankedDates: new Set(),
    });

    expect(result.eraFloorMonth).toBe('2026-05');
    expect(result.daysPersisted).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(result.rows).toEqual([
      { date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
      { date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 60 },
      { date: '2026-06-01', costCenterId: 'cc-b', creditsUsed: 30 },
      { date: '2026-06-02', costCenterId: null, creditsUsed: 120 },
      { date: '2026-06-02', costCenterId: 'cc-a', creditsUsed: 70 },
      { date: '2026-06-02', costCenterId: 'cc-b', creditsUsed: 40 },
      { date: '2026-06-03', costCenterId: null, creditsUsed: 80 },
      { date: '2026-06-03', costCenterId: 'cc-a', creditsUsed: 50 },
      { date: '2026-06-03', costCenterId: 'cc-b', creditsUsed: 20 },
    ]);
    // Unlike the MONTHLY backfill (never touches the current, incomplete month),
    // the daily backfill DOES fetch the current partial month day by day.
    expect(calls.some((c) => c.day === 3 && c.cost_center_id === undefined)).toBe(true);
  });

  it('skips banked days OUTSIDE the trailing 4-day refresh window; REFETCHES banked days inside it; fetches new days', async () => {
    // today 2026-06-10, no cost centers (1 enterprise call/day). Enumerate
    // 06-01..06-10. Refresh window = today and the 3 prior days (diff<=3):
    // 06-07,06-08,06-09,06-10. Banked = {06-01,06-02,06-08}:
    //   06-01 banked, outside -> SKIP     06-02 banked, outside -> SKIP
    //   06-03..06-06 new, outside         -> FETCH
    //   06-07 new, inside                 -> FETCH
    //   06-08 banked, inside              -> REFETCH (refreshed)
    //   06-09,06-10 new, inside           -> FETCH
    // => 8 days fetched, 2 skipped, 1 refreshed.
    const dayHandlers: Record<string, Handler> = {};
    for (const d of ['03', '04', '05', '06', '07', '08', '09', '10']) dayHandlers[`2026-06-${d}`] = () => ({ data: items(10) });
    const { octokit, calls } = stub({
      '2026-06': () => ({ data: items(1) }),
      '2026-05': () => ({ data: items() }),
      ...dayHandlers,
    });

    const result = await backfillDailyCredits(octokit, 'acme', {
      today: '2026-06-10',
      costCenterIds: [],
      bankedDates: new Set(['2026-06-01', '2026-06-02', '2026-06-08']),
    });

    expect(result.daysSkippedBanked).toEqual(['2026-06-01', '2026-06-02']);
    expect(result.daysRefreshed).toEqual(['2026-06-08']);
    expect(result.daysPersisted).toEqual([
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
    ]);
    expect(result.rows).toHaveLength(8);
    // Banked-outside days are NEVER requested.
    expect(calls.some((c) => c.day === 1)).toBe(false);
    expect(calls.some((c) => c.day === 2)).toBe(false);
  });

  it('is day-atomic: one scope throwing aborts that whole day (no partial rows); other days land', async () => {
    // today 2026-06-03, cost centers [cc-a]. 06-02's cc-a call throws -> whole
    // day aborts (0 rows), recorded as failed; 06-01 and 06-03 land 2 rows each.
    const { octokit } = stub({
      '2026-06': () => ({ data: items(1) }),
      '2026-05': () => ({ data: items() }),
      '2026-06-01': () => ({ data: items(100) }),
      '2026-06-01@cc-a': () => ({ data: items(60) }),
      '2026-06-02': () => ({ data: items(120) }),
      '2026-06-02@cc-a': () => {
        throw Object.assign(new Error('boom cost_center_id=cc-a'), { status: 500 });
      },
      '2026-06-03': () => ({ data: items(80) }),
      '2026-06-03@cc-a': () => ({ data: items(50) }),
    });

    const result = await backfillDailyCredits(octokit, 'acme', {
      today: '2026-06-03',
      costCenterIds: ['cc-a'],
      bankedDates: new Set(),
    });

    expect(result.daysFailed).toEqual(['2026-06-02']);
    expect(result.rows.some((r) => r.date === '2026-06-02')).toBe(false); // no partial-day rows
    expect(result.daysPersisted).toEqual(['2026-06-01', '2026-06-03']);
    expect(result.rows).toEqual([
      { date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
      { date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 60 },
      { date: '2026-06-03', costCenterId: null, creditsUsed: 80 },
      { date: '2026-06-03', costCenterId: 'cc-a', creditsUsed: 50 },
    ]);
  });

  it('returns an empty result (no fan-out) when the current month itself has no data (no data era)', async () => {
    // today 2026-06-05, current month empty -> scan stops immediately, no era.
    const { octokit, calls } = stub({ '2026-06': () => ({ data: items() }) });
    const result = await backfillDailyCredits(octokit, 'acme', {
      today: '2026-06-05',
      costCenterIds: ['cc-a'],
      bankedDates: new Set(),
    });
    expect(result.rows).toEqual([]);
    expect(result.daysPersisted).toEqual([]);
    expect(result.eraFloorMonth).toBe('2026-06');
    // Only the one month probe happened -- never a day fan-out.
    expect(calls.every((c) => c.day === undefined)).toBe(true);
  });
});

describe('readDailyCreditsFactsFor (winner rule)', () => {
  let tmpDir: string;
  let db: Db;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'daily-fact-test-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('latest snapshot wins per (date, cost center): a refresh-window refetch supersedes the banked value; untouched dates keep the older generation', () => {
    // Snapshot 1 (older) banks 06-01 ent=100, 06-02 ent=200.
    // Snapshot 2 (newer) refetches only 06-02 ent=250 (settled higher).
    // Winner: 06-01 -> snapshot 1 (100), 06-02 -> snapshot 2 (250).
    const s1 = db.insert(snapshot).values({ capturedAt: new Date('2026-06-02T00:00:00Z'), source: 'github' }).returning().get();
    db.insert(aiCreditDailyFact)
      .values([
        { snapshotId: s1.id, date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
        { snapshotId: s1.id, date: '2026-06-02', costCenterId: null, creditsUsed: 200 },
      ])
      .run();
    const s2 = db.insert(snapshot).values({ capturedAt: new Date('2026-06-04T00:00:00Z'), source: 'github' }).returning().get();
    db.insert(aiCreditDailyFact).values([{ snapshotId: s2.id, date: '2026-06-02', costCenterId: null, creditsUsed: 250 }]).run();

    const winners = readDailyCreditsFactsFor(db, 'github').sort((a, b) => a.date.localeCompare(b.date));
    expect(winners).toEqual([
      { date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
      { date: '2026-06-02', costCenterId: null, creditsUsed: 250 },
    ]);
  });

  it('resolves per (date, cost center) independently and is source-scoped (never reads the other mode)', () => {
    // FK (foreign_keys=ON): the referenced cost center must exist.
    db.insert(costCenter).values({ id: 'cc-a', name: 'CC A', state: 'active' }).run();
    const s1 = db.insert(snapshot).values({ capturedAt: new Date('2026-06-02T00:00:00Z'), source: 'github' }).returning().get();
    db.insert(aiCreditDailyFact)
      .values([
        { snapshotId: s1.id, date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
        { snapshotId: s1.id, date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 40 },
      ])
      .run();
    // A newer snapshot refreshes only cc-a for 06-01; enterprise 06-01 keeps s1.
    const s2 = db.insert(snapshot).values({ capturedAt: new Date('2026-06-04T00:00:00Z'), source: 'github' }).returning().get();
    db.insert(aiCreditDailyFact).values([{ snapshotId: s2.id, date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 45 }]).run();
    // An msw-source row must never leak into the github read.
    const sMsw = db.insert(snapshot).values({ capturedAt: new Date('2026-06-05T00:00:00Z'), source: 'msw' }).returning().get();
    db.insert(aiCreditDailyFact).values([{ snapshotId: sMsw.id, date: '2026-06-01', costCenterId: null, creditsUsed: 9999 }]).run();

    const winners = readDailyCreditsFactsFor(db, 'github').sort(
      (a, b) => a.date.localeCompare(b.date) || String(a.costCenterId).localeCompare(String(b.costCenterId)),
    );
    expect(winners).toEqual([
      { date: '2026-06-01', costCenterId: 'cc-a', creditsUsed: 45 },
      { date: '2026-06-01', costCenterId: null, creditsUsed: 100 },
    ]);
    expect(readDailyCreditsFactsFor(db, 'msw')).toEqual([{ date: '2026-06-01', costCenterId: null, creditsUsed: 9999 }]);
  });
});
