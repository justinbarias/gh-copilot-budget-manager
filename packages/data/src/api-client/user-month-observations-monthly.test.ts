import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { createGitHubApiClient, readMonthlyCreditsFactsFor } from './github-impl.js';
import type { ApiClient } from './types.js';

// Reader-merge tests for the monthly per-user AI-credit backfill (migration
// 0007). getUserMonthObservations now unions daily-derived complete months with
// months present in credits_used_monthly_fact; a month in BOTH is served by the
// MONTHLY fact (billing = money truth). The NULL-user remainder is excluded from
// observations and surfaced via unattributedCredits. Every expected value is
// hand-computed in the comments. getUsageDistribution (Totals) stays daily-only.

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-monthly-merge-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function addSnapshot(source: 'msw' | 'github'): number {
  return db.insert(schema.snapshot).values({ capturedAt: new Date('2026-07-14T00:00:00Z'), source }).returning().get().id;
}
function addDailyFacts(snapshotId: number, rows: Array<{ date: string; userId: string; userLogin?: string | null; creditsUsed: number }>): void {
  db.insert(schema.creditsUsedFact)
    .values(rows.map((r) => ({ snapshotId, date: r.date, userId: r.userId, userLogin: r.userLogin ?? null, creditsUsed: r.creditsUsed })))
    .run();
}
function addMonthlyFacts(snapshotId: number, rows: Array<{ month: string; userId: string | null; userLogin: string | null; creditsUsed: number }>): void {
  db.insert(schema.creditsUsedMonthlyFact)
    .values(rows.map((r) => ({ snapshotId, month: r.month, userId: r.userId, userLogin: r.userLogin, creditsUsed: r.creditsUsed })))
    .run();
}
function seedRoster(): void {
  db.insert(schema.costCenter).values([{ id: 'cc-a', name: 'Alpha', state: 'active' }]).run();
  db.insert(schema.license)
    .values([
      { userId: '1001', userLogin: 'alice', costCenterId: 'cc-a', assignedAt: null },
      { userId: '1002', userLogin: 'bob', costCenterId: null, assignedAt: null },
      { userId: '1004', userLogin: 'dave', costCenterId: 'cc-a', assignedAt: null },
    ])
    .run();
}
function githubClient(): ApiClient {
  return createGitHubApiClient({ enterprise: 'acme', db, source: 'github' });
}

describe('getUserMonthObservations -- monthly-fact merge', () => {
  it('monthly fact wins a conflicting daily month; unions in a monthly-only month; roster zero-fills; remainder is excluded but reported', async () => {
    seedRoster();
    const s = addSnapshot('github');
    // Daily facts: alice 2026-05-10=100 (CONFLICTS with the monthly May below)
    // + alice 2026-06-15=1 to push toDate to 06-15 so MAY is a daily-complete
    // month (month-end 05-31 <= 06-15) while JUNE is not (06-30 > 06-15).
    addDailyFacts(s, [
      { date: '2026-05-10', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
      { date: '2026-06-15', userId: '1001', userLogin: 'alice', creditsUsed: 1 },
    ]);
    // Monthly facts: May (alice 500 + remainder 50) and June (alice 300, no
    // remainder). May is thus in BOTH daily and monthly -> monthly must win
    // (500, not the daily 100). June is monthly-only -> the union adds it.
    addMonthlyFacts(s, [
      { month: '2026-05', userId: '1001', userLogin: 'alice', creditsUsed: 500 },
      { month: '2026-05', userId: null, userLogin: null, creditsUsed: 50 }, // remainder
      { month: '2026-06', userId: '1001', userLogin: 'alice', creditsUsed: 300 },
    ]);

    const result = await githubClient().getUserMonthObservations({ months: 9 });

    // Union complete months = daily{2026-05} ∪ monthly{2026-05, 2026-06}.
    expect(result.months).toEqual(['2026-05', '2026-06']);
    expect(result.truncated).toBe(true); // 2 complete months < 9 requested
    // Roster: alice(cc Alpha), bob(null), dave(cc Alpha) -- each contributes one
    // observation per month. Monthly wins May (alice 500, not 100); June alice 300.
    // bob/dave have no monthly attributed rows -> 0 both months.
    expect(result.observations).toEqual([
      { userLogin: 'alice', costCenterName: 'Alpha', month: '2026-05', creditsUsed: 500 },
      { userLogin: 'alice', costCenterName: 'Alpha', month: '2026-06', creditsUsed: 300 },
      { userLogin: 'bob', costCenterName: null, month: '2026-05', creditsUsed: 0 },
      { userLogin: 'bob', costCenterName: null, month: '2026-06', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', month: '2026-05', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', month: '2026-06', creditsUsed: 0 },
    ]);
    // Remainder surfaced (May only), excluded from observations.
    expect(result.unattributedCredits).toEqual({ '2026-05': 50 });
  });

  it('surfaces monthly history even when the daily report is fully absent (the live zero-fill scenario)', async () => {
    seedRoster();
    const s = addSnapshot('github');
    // No daily facts at all (base === null). Monthly June carries real history.
    addMonthlyFacts(s, [{ month: '2026-06', userId: '1001', userLogin: 'alice', creditsUsed: 300 }]);

    const result = await githubClient().getUserMonthObservations({ months: 1 });
    expect(result.months).toEqual(['2026-06']);
    // alice 300; bob/dave roster-zero. unattributedCredits absent (no remainder).
    expect(result.observations).toEqual([
      { userLogin: 'alice', costCenterName: 'Alpha', month: '2026-06', creditsUsed: 300 },
      { userLogin: 'bob', costCenterName: null, month: '2026-06', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', month: '2026-06', creditsUsed: 0 },
    ]);
    expect(result.unattributedCredits).toBeUndefined();
  });

  it('sim (msw) sees no github monthly facts, and monthly facts never leak into Totals', async () => {
    seedRoster();
    // Only a GITHUB monthly fact exists; an MSW client must not see it.
    const g = addSnapshot('github');
    addMonthlyFacts(g, [{ month: '2026-06', userId: '1001', userLogin: 'alice', creditsUsed: 300 }]);

    // Source-scoped reader helper: msw sees nothing, github sees the one month.
    expect(readMonthlyCreditsFactsFor(db, 'msw').size).toBe(0);
    expect(readMonthlyCreditsFactsFor(db, 'github').size).toBe(1);

    const mswClient = createGitHubApiClient({ enterprise: 'acme', db, source: 'msw' });
    // No msw per-user history at all -> sentinel, EXACT 3-key shape (byte-identical).
    expect(await mswClient.getUserMonthObservations({ months: 1 })).toEqual({ months: [], truncated: false, observations: [] });

    // Totals (getUsageDistribution) is daily-only: github has no daily facts, so
    // it is the sentinel even though a monthly fact exists (no leak).
    expect(await githubClient().getUsageDistribution({ months: 1 })).toEqual({ fromDate: '', toDate: '', truncated: false, users: [] });
  });
});
