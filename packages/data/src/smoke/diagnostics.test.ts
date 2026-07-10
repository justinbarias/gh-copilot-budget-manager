import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { computeLocalCreditsCoverage } from '../api-client/github-impl.js';
import {
  formatLocalCreditsCoverage,
  formatWireR6Historical,
  summarizeWireR6Historical,
  type LocalCreditsCoverage,
  type WireR6Item,
} from './diagnostics.js';

// Live per-month all-zero diagnostics (2026-07-10). computeLocalCreditsCoverage
// is a PURE local-SQLite read (no MSW server attached -- any GitHub/HTTP call
// under test would fail loudly, part of the §6.9-exempt contract). Every
// expectation is hand-computed from the seeded rows, never copied from output.

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-smoke-diagnostics-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function addSnapshot(source: 'msw' | 'github', capturedAt: string): number {
  return db.insert(schema.snapshot).values({ capturedAt: new Date(capturedAt), source }).returning().get().id;
}

interface SeedFact {
  date: string;
  userId: string;
  userLogin?: string | null;
  creditsUsed: number;
}

function addFacts(snapshotId: number, rows: SeedFact[]): void {
  db.insert(schema.creditsUsedFact)
    .values(rows.map((r) => ({ snapshotId, date: r.date, userId: r.userId, userLogin: r.userLogin ?? null, creditsUsed: r.creditsUsed })))
    .run();
}

describe('computeLocalCreditsCoverage', () => {
  it('reproduces the live all-zero-June symptom: June rows present, every per-user sum 0', () => {
    // A single github snapshot modelling the live tenant's persisted backfill:
    // May rows carry real credits, June rows are ALL zero (the reported bug),
    // and two June rows have a null user_login (identity-shape signal).
    const s1 = addSnapshot('github', '2026-07-09T10:00:00.000Z');
    addFacts(s1, [
      { date: '2026-05-20', userId: '100', userLogin: 'alice', creditsUsed: 40 },
      { date: '2026-05-25', userId: '101', userLogin: 'bob', creditsUsed: 60 },
      { date: '2026-06-01', userId: '100', userLogin: 'alice', creditsUsed: 0 },
      { date: '2026-06-10', userId: '101', userLogin: 'bob', creditsUsed: 0 },
      { date: '2026-06-10', userId: '102', userLogin: null, creditsUsed: 0 },
      { date: '2026-06-20', userId: '100', userLogin: 'alice', creditsUsed: 0 },
      { date: '2026-06-28', userId: '102', userLogin: null, creditsUsed: 0 },
    ]);

    const cov = computeLocalCreditsCoverage(db, 'github');
    expect(cov.source).toBe('github');
    expect(cov.hasData).toBe(true);

    // Per-snapshot raw stats: 7 rows, {100,101,102}=3 users, 05-20..06-28,
    // 2 null-login rows (the two u102 June rows).
    expect(cov.snapshots).toHaveLength(1);
    expect(cov.snapshots[0]).toEqual({
      snapshotId: s1,
      capturedAt: '2026-07-09T10:00:00.000Z',
      rowCount: 7,
      distinctUserIds: 3,
      minDate: '2026-05-20',
      maxDate: '2026-06-28',
      nullLoginCount: 2,
    });

    // Per-month rollup (single snapshot => winner is s1 for every date):
    //   2026-05: u100=40, u101=60 -> total 100, 2 users with rows, both nonzero.
    //   2026-06: u100 (06-01,06-20)=0, u101 (06-10)=0, u102 (06-10,06-28)=0
    //            -> total 0, 3 users with rows, ZERO nonzero (the symptom).
    expect(cov.months).toEqual([
      { month: '2026-05', totalCredits: 100, distinctUsers: 2, usersWithNonzero: 2 },
      { month: '2026-06', totalCredits: 0, distinctUsers: 3, usersWithNonzero: 0 },
    ]);
  });

  it('per-month rollup uses the union/latest-wins WINNING generation per date', () => {
    // Two github snapshots; s2 (later) supersedes 2026-06-10's row with a
    // nonzero value. The rollup must count only s2's winning row for that date.
    const s1 = addSnapshot('github', '2026-07-09T10:00:00.000Z');
    addFacts(s1, [{ date: '2026-06-10', userId: '101', userLogin: 'bob', creditsUsed: 0 }]);
    const s2 = addSnapshot('github', '2026-07-10T10:00:00.000Z');
    addFacts(s2, [{ date: '2026-06-10', userId: '101', userLogin: 'bob', creditsUsed: 30 }]);

    const cov = computeLocalCreditsCoverage(db, 'github');
    // Per-snapshot section shows BOTH snapshots (raw, un-deduped).
    expect(cov.snapshots.map((s) => s.snapshotId)).toEqual([s1, s2]);
    // June winner for 06-10 is s2 -> total 30, 1 user with a (winning) row, nonzero.
    expect(cov.months).toEqual([{ month: '2026-06', totalCredits: 30, distinctUsers: 1, usersWithNonzero: 1 }]);
  });

  it('is source-scoped: a github snapshot never contaminates the msw coverage (and vice versa)', () => {
    const g = addSnapshot('github', '2026-07-09T10:00:00.000Z');
    addFacts(g, [{ date: '2026-06-01', userId: '900', userLogin: 'liveuser', creditsUsed: 500 }]);
    const m = addSnapshot('msw', '2026-06-14T00:00:00.000Z');
    addFacts(m, [{ date: '2026-06-05', userId: '1', userLogin: 'simuser', creditsUsed: 12 }]);

    const gitCov = computeLocalCreditsCoverage(db, 'github');
    expect(gitCov.snapshots.map((s) => s.snapshotId)).toEqual([g]);
    expect(gitCov.months).toEqual([{ month: '2026-06', totalCredits: 500, distinctUsers: 1, usersWithNonzero: 1 }]);

    const mswCov = computeLocalCreditsCoverage(db, 'msw');
    expect(mswCov.snapshots.map((s) => s.snapshotId)).toEqual([m]);
    expect(mswCov.months).toEqual([{ month: '2026-06', totalCredits: 12, distinctUsers: 1, usersWithNonzero: 1 }]);
  });

  it('reports the sentinel (no data) shape for a source with no per-user history', () => {
    const cov = computeLocalCreditsCoverage(db, 'github');
    expect(cov).toEqual({ source: 'github', hasData: false, snapshots: [], months: [] });
  });

  it('still surfaces the raw truth when the whole source is zero-fill (the distribution readers sentinel, but the diagnostic must NOT)', () => {
    // Zero-filled-history fix (2026-07-10): the distribution readers now derive
    // coverage bounds from NONZERO rows only, so a fully zero-filled source
    // sentinels there. computeLocalCreditsCoverage must be UNCHANGED -- its whole
    // purpose is to SHOW the persisted zero rows, so hasData stays true and the
    // all-zero month still appears (readDistributionFactBaseFor returns null only
    // for zero ROWS, not zero credits).
    const s1 = addSnapshot('github', '2026-07-10T10:00:00.000Z');
    addFacts(s1, [
      { date: '2026-06-01', userId: '100', userLogin: 'alice', creditsUsed: 0 },
      { date: '2026-06-10', userId: '101', userLogin: 'bob', creditsUsed: 0 },
    ]);
    const cov = computeLocalCreditsCoverage(db, 'github');
    expect(cov.hasData).toBe(true);
    expect(cov.snapshots).toEqual([
      {
        snapshotId: s1,
        capturedAt: '2026-07-10T10:00:00.000Z',
        rowCount: 2,
        distinctUserIds: 2,
        minDate: '2026-06-01',
        maxDate: '2026-06-10',
        nullLoginCount: 0,
      },
    ]);
    expect(cov.months).toEqual([{ month: '2026-06', totalCredits: 0, distinctUsers: 2, usersWithNonzero: 0 }]);
  });
});

describe('formatLocalCreditsCoverage', () => {
  it('renders the sentinel note when there is no data', () => {
    const text = formatLocalCreditsCoverage({ source: 'github', hasData: false, snapshots: [], months: [] });
    expect(text).toMatch(/Local credits coverage \(DB, source: github\)/);
    expect(text).toMatch(/no per-user credits_used_fact rows/);
  });

  it('renders per-snapshot lines and the per-month rollup as plain indented text', () => {
    const coverage: LocalCreditsCoverage = {
      source: 'github',
      hasData: true,
      snapshots: [
        {
          snapshotId: 7,
          capturedAt: '2026-07-09T10:00:00.000Z',
          rowCount: 7,
          distinctUserIds: 3,
          minDate: '2026-05-20',
          maxDate: '2026-06-28',
          nullLoginCount: 2,
        },
      ],
      months: [
        { month: '2026-05', totalCredits: 100, distinctUsers: 2, usersWithNonzero: 2 },
        { month: '2026-06', totalCredits: 0, distinctUsers: 3, usersWithNonzero: 0 },
      ],
    };
    const text = formatLocalCreditsCoverage(coverage);
    expect(text).toContain('#7 captured 2026-07-09T10:00:00.000Z: rows=7 users=3 dates=2026-05-20..2026-06-28 null_login=2');
    expect(text).toContain('2026-05: total=100 users_with_rows=2 users_nonzero=2');
    expect(text).toContain('2026-06: total=0 users_with_rows=3 users_nonzero=0');
  });
});

describe('summarizeWireR6Historical', () => {
  it('rolls per month: item count, distinct users, login-present, nonzero-credit, and summed credits', () => {
    // The live all-zero symptom on the WIRE side: May items carry credits,
    // June items are all zero with one item missing user_login ('').
    const items: WireR6Item[] = [
      { date: '2026-05-10', user_id: '100', user_login: 'alice', ai_credits_used: 40 },
      { date: '2026-05-11', user_id: '101', user_login: 'bob', ai_credits_used: 60 },
      { date: '2026-05-11', user_id: '100', user_login: 'alice', ai_credits_used: 5 },
      { date: '2026-06-01', user_id: '100', user_login: 'alice', ai_credits_used: 0 },
      { date: '2026-06-02', user_id: '101', user_login: '', ai_credits_used: 0 },
      { date: '2026-06-03', user_id: '102', user_login: 'carol', ai_credits_used: 0 },
    ];
    const summary = summarizeWireR6Historical(items);
    expect(summary.totalItems).toBe(6);
    expect(summary.truncatedMonths).toBe(0);
    expect(summary.monthsShown).toEqual([
      // May: 3 items, {100,101}=2 users, all 3 have a login, all 3 nonzero, sum 105.
      { month: '2026-05', itemCount: 3, distinctUserIds: 2, itemsWithLogin: 3, itemsWithNonzeroCredits: 3, sumCredits: 105 },
      // June: 3 items, {100,101,102}=3 users, only alice+carol carry a login
      // (bob '' does not), ZERO nonzero-credit items, sum 0 (the symptom).
      { month: '2026-06', itemCount: 3, distinctUserIds: 3, itemsWithLogin: 2, itemsWithNonzeroCredits: 0, sumCredits: 0 },
    ]);
  });

  it('caps output at the last 12 months and counts the omitted earlier months', () => {
    // 14 distinct months (2025-01 .. 2026-02), one item each.
    const items: WireR6Item[] = [];
    for (let i = 0; i < 14; i++) {
      const y = 2025 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      items.push({ date: `${y}-${String(m).padStart(2, '0')}-15`, user_id: 'u', user_login: 'u', ai_credits_used: 1 });
    }
    const summary = summarizeWireR6Historical(items);
    expect(summary.totalItems).toBe(14);
    expect(summary.truncatedMonths).toBe(2);
    expect(summary.monthsShown).toHaveLength(12);
    // The LAST 12 ascending months: earliest two (2025-01, 2025-02) dropped.
    expect(summary.monthsShown[0]!.month).toBe('2025-03');
    expect(summary.monthsShown.at(-1)!.month).toBe('2026-02');
  });

  it('handles an empty item set (H1 signal: no historical rows at all)', () => {
    const summary = summarizeWireR6Historical([]);
    expect(summary).toEqual({ totalItems: 0, monthsShown: [], truncatedMonths: 0 });
  });
});

describe('formatWireR6Historical', () => {
  it('renders total items, month count, and one indented line per month', () => {
    const text = formatWireR6Historical({
      totalItems: 6,
      truncatedMonths: 0,
      monthsShown: [
        { month: '2026-06', itemCount: 3, distinctUserIds: 3, itemsWithLogin: 2, itemsWithNonzeroCredits: 0, sumCredits: 0 },
      ],
    });
    expect(text).toMatch(/Live wire R6 historical \(users-1-day backfill -- NOT persisted\)/);
    expect(text).toContain('total items: 6 (1 month)');
    expect(text).toContain('2026-06: items=3 users=3 with_login=2 nonzero_credits=0 sum=0');
  });

  it('notes the last-12 truncation in the header', () => {
    const text = formatWireR6Historical({
      totalItems: 14,
      truncatedMonths: 2,
      monthsShown: [{ month: '2025-03', itemCount: 1, distinctUserIds: 1, itemsWithLogin: 1, itemsWithNonzeroCredits: 1, sumCredits: 1 }],
    });
    expect(text).toContain('showing last 1 of 3 months');
  });

  it('renders the empty-items note', () => {
    const text = formatWireR6Historical({ totalItems: 0, monthsShown: [], truncatedMonths: 0 });
    expect(text).toContain('(no items returned)');
  });
});
