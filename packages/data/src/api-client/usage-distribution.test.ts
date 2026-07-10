import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { createGitHubApiClient } from './github-impl.js';
import type { ApiClient } from './types.js';

// Distribution D2: getUsageDistribution is a PURE local-SQLite read -- no MSW
// server is attached here on purpose. If any code path under test issued a
// GitHub/HTTP request it would fail loudly (nothing is listening), which is
// itself part of the contract ("no GitHub HTTP call", §6.9-exempt).
//
// Every expectation below is hand-computed from the seeded rows; the sums,
// window boundaries, and truncation flags are derived in the comments, never
// copied from the implementation's output.

let tmpDir: string;
let db: Db;
let client: ApiClient;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-usage-distribution-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
  client = createGitHubApiClient({ enterprise: 'test-ent', db, source: 'msw' });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function addSnapshot(source: 'msw' | 'github' = 'msw'): number {
  return db.insert(schema.snapshot).values({ capturedAt: new Date('2026-06-14T00:00:00Z'), source }).returning().get().id;
}

interface SeedFact {
  date: string;
  userId: string;
  userLogin?: string | null; // omitted -> null (a pre-migration-0005 row)
  creditsUsed: number;
}

function addFacts(snapshotId: number, rows: SeedFact[]): void {
  db.insert(schema.creditsUsedFact)
    .values(rows.map((r) => ({ snapshotId, date: r.date, userId: r.userId, userLogin: r.userLogin ?? null, creditsUsed: r.creditsUsed })))
    .run();
}

// The main seeded world (brief: >=100 days, 4+ users):
//   coverage 2026-03-01 .. 2026-06-14 = 31 (Mar) + 30 (Apr) + 31 (May) + 14
//   (Jun) = 106 days inclusive.
//   alice (1001, cc-a "Alpha"):  03-01: 100 | 05-14: 50 | 05-15: 70 | 06-14: 30
//   bob   (1002, unassigned):    04-01: 200 | 06-01: 25.4   (exercises REAL -> round-at-end)
//   carol (1003, cc-b "Beta"):   03-14: 5   | 03-15: 10
//   dave  (1004, cc-a "Alpha"):  licensed, ZERO usage
//   eve   (2001, NO license):    06-10: 40  (defensive fact-only branch)
function seedMainWorld(): void {
  db.insert(schema.costCenter)
    .values([
      { id: 'cc-a', name: 'Alpha', state: 'active' },
      { id: 'cc-b', name: 'Beta', state: 'active' },
    ])
    .run();
  db.insert(schema.license)
    .values([
      { userId: '1001', userLogin: 'alice', costCenterId: 'cc-a', assignedAt: null },
      { userId: '1002', userLogin: 'bob', costCenterId: null, assignedAt: null },
      { userId: '1003', userLogin: 'carol', costCenterId: 'cc-b', assignedAt: null },
      { userId: '1004', userLogin: 'dave', costCenterId: 'cc-a', assignedAt: null },
    ])
    .run();
  const s1 = addSnapshot();
  addFacts(s1, [
    { date: '2026-03-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
    { date: '2026-05-14', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
    { date: '2026-05-15', userId: '1001', userLogin: 'alice', creditsUsed: 70 },
    { date: '2026-06-14', userId: '1001', userLogin: 'alice', creditsUsed: 30 },
    { date: '2026-04-01', userId: '1002', userLogin: 'bob', creditsUsed: 200 },
    { date: '2026-06-01', userId: '1002', userLogin: 'bob', creditsUsed: 25.4 },
    { date: '2026-03-14', userId: '1003', userLogin: 'carol', creditsUsed: 5 },
    { date: '2026-03-15', userId: '1003', userLogin: 'carol', creditsUsed: 10 },
    { date: '2026-06-10', userId: '2001', userLogin: 'eve', creditsUsed: 40 },
  ]);
}

describe('getUsageDistribution', () => {
  it('months=1: window [2026-05-15, 2026-06-14] (toDate minus 1 month plus 1 day), boundary days inclusive, not truncated', async () => {
    seedMainWorld();
    const result = await client.getUsageDistribution({ months: 1 });

    // toDate = MAX(date) = 2026-06-14; requested from = 06-14 minus 1 month
    // (2026-05-14) + 1 day = 2026-05-15; earliest (2026-03-01) is older, so
    // no truncation.
    expect(result.toDate).toBe('2026-06-14');
    expect(result.fromDate).toBe('2026-05-15');
    expect(result.truncated).toBe(false);

    // Hand-computed sums over [05-15, 06-14]:
    //   alice: 70 (ON fromDate, included) + 30 (ON toDate, included) = 100;
    //          her 05-14 row is ONE DAY BEFORE fromDate -> excluded.
    //   eve:   40 (fact-only, no license -> null cost center)
    //   bob:   25.4 -> Math.round -> 25
    //   carol: 0 (licensed roster inclusion; her rows are all pre-window)
    //   dave:  0 (licensed, zero usage anywhere)
    // Order: creditsUsed desc, then login asc.
    expect(result.users).toEqual([
      { userLogin: 'alice', costCenterName: 'Alpha', creditsUsed: 100 },
      { userLogin: 'eve', costCenterName: null, creditsUsed: 40 },
      { userLogin: 'bob', costCenterName: null, creditsUsed: 25 },
      { userLogin: 'carol', costCenterName: 'Beta', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', creditsUsed: 0 },
    ]);
  });

  it('months=3: window [2026-03-15, 2026-06-14]; a fact ON fromDate counts, the day before does not', async () => {
    seedMainWorld();
    const result = await client.getUsageDistribution({ months: 3 });

    // Requested from = 06-14 minus 3 months (2026-03-14) + 1 day = 2026-03-15
    // >= earliest 2026-03-01 -> not truncated.
    expect(result.toDate).toBe('2026-06-14');
    expect(result.fromDate).toBe('2026-03-15');
    expect(result.truncated).toBe(false);

    // Hand-computed sums over [03-15, 06-14]:
    //   bob:   200 + 25.4 = 225.4 -> 225
    //   alice: 50 + 70 + 30 = 150 (03-01 excluded)
    //   eve:   40
    //   carol: 10 (03-15 ON fromDate included; 03-14 one day before, excluded)
    //   dave:  0
    expect(result.users).toEqual([
      { userLogin: 'bob', costCenterName: null, creditsUsed: 225 },
      { userLogin: 'alice', costCenterName: 'Alpha', creditsUsed: 150 },
      { userLogin: 'eve', costCenterName: null, creditsUsed: 40 },
      { userLogin: 'carol', costCenterName: 'Beta', creditsUsed: 10 },
      { userLogin: 'dave', costCenterName: 'Alpha', creditsUsed: 0 },
    ]);
  });

  it('months=9 over ~3.5 months of history: fromDate clamps to the earliest covered day and truncated=true', async () => {
    seedMainWorld();
    const result = await client.getUsageDistribution({ months: 9 });

    // Requested from = 2026-06-14 minus 9 months (2025-09-14) + 1 day =
    // 2025-09-15 < earliest 2026-03-01 -> clamp + truncate.
    expect(result.toDate).toBe('2026-06-14');
    expect(result.fromDate).toBe('2026-03-01');
    expect(result.truncated).toBe(true);

    // Full-coverage sums: alice 100+50+70+30 = 250; bob 225.4 -> 225;
    // eve 40; carol 5+10 = 15; dave 0.
    expect(result.users).toEqual([
      { userLogin: 'alice', costCenterName: 'Alpha', creditsUsed: 250 },
      { userLogin: 'bob', costCenterName: null, creditsUsed: 225 },
      { userLogin: 'eve', costCenterName: null, creditsUsed: 40 },
      { userLogin: 'carol', costCenterName: 'Beta', creditsUsed: 15 },
      { userLogin: 'dave', costCenterName: 'Alpha', creditsUsed: 0 },
    ]);
  });

  it('clamps the day-of-month across a short target month: toDate 2026-07-31, months=1 -> fromDate 2026-07-01 (exactly the month of July)', async () => {
    // 07-31 minus 1 month = "June 31", clamped to June 30, + 1 day = July 1.
    const s1 = addSnapshot();
    addFacts(s1, [
      { date: '2026-06-30', userId: '3001', userLogin: 'zed', creditsUsed: 11 }, // day before fromDate -> excluded
      { date: '2026-07-01', userId: '3001', userLogin: 'zed', creditsUsed: 7 }, // ON fromDate -> included
      { date: '2026-07-31', userId: '3001', userLogin: 'zed', creditsUsed: 3 }, // ON toDate -> included
    ]);

    const result = await client.getUsageDistribution({ months: 1 });
    expect(result.toDate).toBe('2026-07-31');
    expect(result.fromDate).toBe('2026-07-01');
    // Earliest covered day (2026-06-30) is OLDER than the requested start, so
    // the window is fully covered -> not truncated.
    expect(result.truncated).toBe(false);
    expect(result.users).toEqual([{ userLogin: 'zed', costCenterName: null, creditsUsed: 10 }]);
  });

  it("union/latest-wins across overlapping syncs (LIVE 'github' source): a shared date takes the later snapshot's value; a date only in the older snapshot still contributes", async () => {
    // Union-across-snapshots is the LIVE accumulation oracle -- ONE real
    // enterprise, many syncs (readDistributionFactBase's 'github' branch). The
    // 'msw' source now deliberately scopes to the latest snapshot only
    // (scenario-contamination fix 2026-07-10; see the msw-scoping test below),
    // so this test -- unchanged in every assertion -- runs on a 'github' client
    // and 'github' snapshots to keep exercising the union path it was written
    // to protect. (Justified edit per the builder brief's scope guard.)
    const liveClient = createGitHubApiClient({ enterprise: 'test-ent', db, source: 'github' });
    const s1 = addSnapshot('github');
    addFacts(s1, [
      { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 10 }, // only in S1 -> still counts
      { date: '2026-06-10', userId: '1001', userLogin: 'alice', creditsUsed: 100 }, // superseded by S2's 60
    ]);
    const s2 = addSnapshot('github');
    expect(s2).toBeGreaterThan(s1);
    addFacts(s2, [{ date: '2026-06-10', userId: '1001', userLogin: 'alice', creditsUsed: 60 }]);

    const result = await liveClient.getUsageDistribution({ months: 1 });
    // Coverage union = {06-01, 06-10}: toDate 2026-06-10; requested from =
    // 05-10 + 1 day = 2026-05-11 < earliest 2026-06-01 -> clamp + truncate.
    expect(result.toDate).toBe('2026-06-10');
    expect(result.fromDate).toBe('2026-06-01');
    expect(result.truncated).toBe(true);
    // 10 (S1-only date) + 60 (S2 wins over S1's 100) = 70 -- NOT 110, NOT 170.
    expect(result.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 70 }]);
  });

  it('is scenario-scoped on the msw source: only the LATEST snapshot is read, so a later scenario never contaminates an earlier one (and vice versa)', async () => {
    // The reported bug: sync Metered (dates past the 1 Sep cliff), switch to a
    // June scenario, and the "1 month" window still showed the metered world's
    // dates. Fix: the msw source reads the latest snapshot ONLY -- each sim
    // sync persists one scenario's whole world, so the window is whatever the
    // active (latest) scenario wrote, full stop. All on the default msw client.

    // Snapshot A -- a June world.
    const sA = addSnapshot();
    addFacts(sA, [
      { date: '2026-06-05', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
      { date: '2026-06-12', userId: '1001', userLogin: 'alice', creditsUsed: 80 },
    ]);
    // A alone: toDate 2026-06-12, months=1 window [2026-05-13, 2026-06-12],
    // earliest 2026-06-05 -> clamp+truncate; alice 100+80 = 180.
    const afterA = await client.getUsageDistribution({ months: 1 });
    expect(afterA.toDate).toBe('2026-06-12');
    expect(afterA.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 180 }]);

    // Snapshot B -- a LATER world (the metered cliff, Aug/Sep). Under the old
    // union logic B's 2026-09-01 would have hijacked toDate for A too.
    const sB = addSnapshot();
    addFacts(sB, [
      { date: '2026-08-02', userId: '1001', userLogin: 'alice', creditsUsed: 200 },
      { date: '2026-09-01', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
    ]);
    // Now ONLY B is read: toDate 2026-09-01, window [2026-08-02, 2026-09-01],
    // earliest 2026-08-02 == requestedFrom -> not truncated; A's June dates are
    // absent entirely; alice 200+50 = 250.
    const afterB = await client.getUsageDistribution({ months: 1 });
    expect(afterB.toDate).toBe('2026-09-01');
    expect(afterB.fromDate).toBe('2026-08-02');
    expect(afterB.truncated).toBe(false);
    expect(afterB.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 250 }]);

    // Snapshot C -- back to a June world. Only C is read; B's Aug/Sep dates gone.
    const sC = addSnapshot();
    expect(sC).toBeGreaterThan(sB);
    addFacts(sC, [
      { date: '2026-06-03', userId: '1001', userLogin: 'alice', creditsUsed: 30 },
      { date: '2026-06-20', userId: '1001', userLogin: 'alice', creditsUsed: 40 },
    ]);
    // toDate 2026-06-20, window [2026-05-21, 2026-06-20], earliest 2026-06-03
    // -> clamp+truncate; alice 30+40 = 70.
    const afterC = await client.getUsageDistribution({ months: 1 });
    expect(afterC.toDate).toBe('2026-06-20');
    expect(afterC.fromDate).toBe('2026-06-03');
    expect(afterC.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 70 }]);
  });

  it('msw scoping keys off the latest snapshot WITH per-user facts: a later facts-less snapshot never blanks the window (nor re-contaminates)', async () => {
    // Adversarial edge behind the msw latest-snapshot branch: the "latest"
    // snapshot is derived from the credits_used_fact rows themselves (max
    // snapshotId AMONG rows), NOT from the snapshot table. So a newer snapshot
    // that carries NO per-user facts (e.g. a controls-only sync) is invisible
    // here and the reader falls back to the most recent snapshot that DID carry
    // facts -- the sane "latest available per-user data" answer. This pins that:
    // a naive refactor to `MAX(snapshot.id) WHERE source='msw'` would instead
    // return an empty in-window set and blank the view.
    const sWithFacts = addSnapshot();
    addFacts(sWithFacts, [
      { date: '2026-06-05', userId: '1001', userLogin: 'alice', creditsUsed: 90 },
      { date: '2026-06-11', userId: '1001', userLogin: 'alice', creditsUsed: 60 },
    ]);
    // A newer msw snapshot with NO credits_used_fact rows at all.
    const sNoFacts = addSnapshot();
    expect(sNoFacts).toBeGreaterThan(sWithFacts);

    const result = await client.getUsageDistribution({ months: 1 });
    expect(result.toDate).toBe('2026-06-11'); // from the facts-bearing snapshot, not blank
    expect(result.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 150 }]);
  });

  it('returns the sentinel on a fresh, never-synced DB', async () => {
    const result = await client.getUsageDistribution({ months: 3 });
    expect(result).toEqual({ fromDate: '', toDate: '', truncated: false, users: [] });
  });

  it('is source-scoped (§6.8): an msw client never aggregates github-synced facts (and vice versa)', async () => {
    const sGithub = addSnapshot('github');
    addFacts(sGithub, [{ date: '2026-06-14', userId: '1001', userLogin: 'alice', creditsUsed: 500 }]);

    // The msw client sees NO msw-sourced history -> honest sentinel.
    expect(await client.getUsageDistribution({ months: 1 })).toEqual({ fromDate: '', toDate: '', truncated: false, users: [] });

    // A github client over the SAME DB sees its own rows.
    const liveClient = createGitHubApiClient({ enterprise: 'test-ent', db, source: 'github' });
    const live = await liveClient.getUsageDistribution({ months: 1 });
    expect(live.toDate).toBe('2026-06-14');
    expect(live.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 500 }]);
  });

  describe('login fallback ladder (fact login -> license login -> String(userId))', () => {
    it('prefers the latest-dated non-null fact login inside the window (a renamed login settles on the newest)', async () => {
      const s1 = addSnapshot();
      addFacts(s1, [
        { date: '2026-06-01', userId: '1001', userLogin: 'old-name', creditsUsed: 10 },
        { date: '2026-06-10', userId: '1001', userLogin: 'new-name', creditsUsed: 20 },
      ]);
      const result = await client.getUsageDistribution({ months: 1 });
      expect(result.users).toEqual([{ userLogin: 'new-name', costCenterName: null, creditsUsed: 30 }]);
    });

    it('falls back to the license login when every fact row predates migration 0005 (null logins)', async () => {
      db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
      const s1 = addSnapshot();
      addFacts(s1, [{ date: '2026-06-14', userId: '1001', creditsUsed: 42 }]); // userLogin omitted -> null
      const result = await client.getUsageDistribution({ months: 1 });
      expect(result.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 42 }]);
    });

    it('falls back to String(userId) when neither fact rows nor a license row carry a login', async () => {
      // A fact-only user with pre-migration rows...
      const s1 = addSnapshot();
      addFacts(s1, [{ date: '2026-06-14', userId: '9999', creditsUsed: 5 }]);
      // ...and a zero-usage licensed user whose license row is also
      // pre-migration (null login).
      db.insert(schema.license).values({ userId: '1004', userLogin: null, costCenterId: null, assignedAt: null }).run();

      const result = await client.getUsageDistribution({ months: 1 });
      expect(result.users).toEqual([
        { userLogin: '9999', costCenterName: null, creditsUsed: 5 },
        { userLogin: '1004', costCenterName: null, creditsUsed: 0 },
      ]);
    });
  });

  it('rejects a months value outside 1|3|9 (the IPC boundary is untyped at runtime)', async () => {
    await expect(client.getUsageDistribution({ months: 2 as never })).rejects.toThrow('months must be 1, 3, or 9');
    await expect(client.getUsageDistribution({ months: '3' as never })).rejects.toThrow('months must be 1, 3, or 9');
  });
});
