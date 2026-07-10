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
  it('months=1: the CURRENT calendar month (June, to 06-14) only, sums bounded by toDate, not truncated', async () => {
    seedMainWorld();
    const result = await client.getUsageDistribution({ months: 1 });

    // Calendar-anchored: toDate = MAX NONZERO date = 2026-06-14, so the current
    // month is JUNE and months=1 is June-to-date only. fromDate = first day of
    // the oldest (only) contributing month = 2026-06-01. monthsIncluded=1 == N,
    // so not truncated.
    expect(result.toDate).toBe('2026-06-14');
    expect(result.fromDate).toBe('2026-06-01');
    expect(result.truncated).toBe(false);
    expect(result.monthsIncluded).toBe(1);
    expect(result.unattributedCredits).toBeUndefined();

    // Hand-computed June sums (rows dated 2026-06-*, <= toDate 06-14):
    //   eve:   40 (06-10; fact-only, no license -> null cost center)
    //   alice: 30 (06-14); her 05-14/05-15 rows are in MAY -> excluded now
    //   bob:   25.4 (06-01) -> Math.round -> 25
    //   carol: 0 (roster inclusion; her rows are all in March)
    //   dave:  0 (licensed, zero usage anywhere)
    // Order: creditsUsed desc, then login asc.
    expect(result.users).toEqual([
      { userLogin: 'eve', costCenterName: null, creditsUsed: 40 },
      { userLogin: 'alice', costCenterName: 'Alpha', creditsUsed: 30 },
      { userLogin: 'bob', costCenterName: null, creditsUsed: 25 },
      { userLogin: 'carol', costCenterName: 'Beta', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', creditsUsed: 0 },
    ]);
  });

  it('months=3: current month June + the two prior calendar months (Apr, May), all daily; not truncated', async () => {
    seedMainWorld();
    const result = await client.getUsageDistribution({ months: 3 });

    // Requested calendar months = [Jun (current), May, Apr]; all three carry
    // nonzero daily data (no monthly facts in sim), so monthsIncluded=3 == N ->
    // not truncated. fromDate = first day of the oldest contributing month
    // (April) = 2026-04-01. MARCH is NOT in the window.
    expect(result.toDate).toBe('2026-06-14');
    expect(result.fromDate).toBe('2026-04-01');
    expect(result.truncated).toBe(false);
    expect(result.monthsIncluded).toBe(3);

    // Hand-computed sums over Apr+May+Jun:
    //   bob:   200 (04-01) + 25.4 (06-01) = 225.4 -> 225
    //   alice: 50 (05-14) + 70 (05-15) + 30 (06-14) = 150
    //   eve:   40 (06-10)
    //   carol: 0 (her only rows are in MARCH -> outside the 3-month window)
    //   dave:  0
    expect(result.users).toEqual([
      { userLogin: 'bob', costCenterName: null, creditsUsed: 225 },
      { userLogin: 'alice', costCenterName: 'Alpha', creditsUsed: 150 },
      { userLogin: 'eve', costCenterName: null, creditsUsed: 40 },
      { userLogin: 'carol', costCenterName: 'Beta', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', creditsUsed: 0 },
    ]);
  });

  it('months=9 over ~4 calendar months of data: only Mar-Jun contribute, fromDate = 1st of the oldest, truncated=true', async () => {
    seedMainWorld();
    const result = await client.getUsageDistribution({ months: 9 });

    // Requested calendar months = [Jun..Oct-2025]; only Jun (current), May, Apr,
    // Mar carry data -> monthsIncluded=4 < 9 -> truncated. fromDate = first day
    // of the oldest contributing month (March) = 2026-03-01.
    expect(result.toDate).toBe('2026-06-14');
    expect(result.fromDate).toBe('2026-03-01');
    expect(result.truncated).toBe(true);
    expect(result.monthsIncluded).toBe(4);

    // Full-coverage sums: alice 100(Mar)+50+70(May)+30(Jun) = 250; bob 200(Apr)+
    // 25.4(Jun) -> 225; eve 40; carol 5+10 (Mar) = 15; dave 0.
    expect(result.users).toEqual([
      { userLogin: 'alice', costCenterName: 'Alpha', creditsUsed: 250 },
      { userLogin: 'bob', costCenterName: null, creditsUsed: 225 },
      { userLogin: 'eve', costCenterName: null, creditsUsed: 40 },
      { userLogin: 'carol', costCenterName: 'Beta', creditsUsed: 15 },
      { userLogin: 'dave', costCenterName: 'Alpha', creditsUsed: 0 },
    ]);
  });

  it('current month is the calendar month of toDate: toDate 2026-07-31, months=1 -> the whole month of July', async () => {
    // Calendar-anchored: the current month is JULY (toDate 07-31); June rows are
    // a prior month, absent from the 1-month window. fromDate = 2026-07-01.
    const s1 = addSnapshot();
    addFacts(s1, [
      { date: '2026-06-30', userId: '3001', userLogin: 'zed', creditsUsed: 11 }, // JUNE -> prior month, excluded at N=1
      { date: '2026-07-01', userId: '3001', userLogin: 'zed', creditsUsed: 7 }, // July
      { date: '2026-07-31', userId: '3001', userLogin: 'zed', creditsUsed: 3 }, // July (toDate)
    ]);

    const result = await client.getUsageDistribution({ months: 1 });
    expect(result.toDate).toBe('2026-07-31');
    expect(result.fromDate).toBe('2026-07-01');
    expect(result.truncated).toBe(false);
    expect(result.monthsIncluded).toBe(1);
    // July only: 7 + 3 = 10 (the June 30 row is a prior month, not in N=1).
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
    // Coverage union = {06-01, 06-10}: toDate 2026-06-10 -> current month June.
    // months=1 is June-to-date; fromDate = 2026-06-01; monthsIncluded=1 == N ->
    // not truncated.
    expect(result.toDate).toBe('2026-06-10');
    expect(result.fromDate).toBe('2026-06-01');
    expect(result.truncated).toBe(false);
    expect(result.monthsIncluded).toBe(1);
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
    // A alone: toDate 2026-06-12 -> current month June; months=1 is June-to-date;
    // both A rows are in June, so alice 100+80 = 180.
    const afterA = await client.getUsageDistribution({ months: 1 });
    expect(afterA.toDate).toBe('2026-06-12');
    expect(afterA.fromDate).toBe('2026-06-01');
    expect(afterA.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 180 }]);

    // Snapshot B -- a LATER world (the metered cliff, Aug/Sep). Under the old
    // union logic B's 2026-09-01 would have hijacked toDate for A too.
    const sB = addSnapshot();
    addFacts(sB, [
      { date: '2026-08-02', userId: '1001', userLogin: 'alice', creditsUsed: 200 },
      { date: '2026-09-01', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
    ]);
    // Now ONLY B is read: toDate 2026-09-01 -> current month SEPTEMBER; months=1
    // is Sept-to-date only, so the 08-02 (August) row is a PRIOR month and drops
    // out. fromDate 2026-09-01; monthsIncluded=1 -> not truncated; alice = 50.
    const afterB = await client.getUsageDistribution({ months: 1 });
    expect(afterB.toDate).toBe('2026-09-01');
    expect(afterB.fromDate).toBe('2026-09-01');
    expect(afterB.truncated).toBe(false);
    expect(afterB.monthsIncluded).toBe(1);
    expect(afterB.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 50 }]);

    // Snapshot C -- back to a June world. Only C is read; B's Aug/Sep dates gone.
    const sC = addSnapshot();
    expect(sC).toBeGreaterThan(sB);
    addFacts(sC, [
      { date: '2026-06-03', userId: '1001', userLogin: 'alice', creditsUsed: 30 },
      { date: '2026-06-20', userId: '1001', userLogin: 'alice', creditsUsed: 40 },
    ]);
    // toDate 2026-06-20 -> current month June; months=1 is June-to-date; both C
    // rows are in June; fromDate 2026-06-01; alice 30+40 = 70.
    const afterC = await client.getUsageDistribution({ months: 1 });
    expect(afterC.toDate).toBe('2026-06-20');
    expect(afterC.fromDate).toBe('2026-06-01');
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

  // Zero-filled-history fix (2026-07-10): GitHub zero-fills per-user history
  // beyond retention (full roster + logins, but ai_credits_used = 0). Coverage
  // bounds (earliest/toDate) must derive from NONZERO winning rows only so the
  // window never anchors to a zero-filled month. The bounds rule is
  // source-independent, so these seed one msw snapshot (the default client).
  describe('nonzero coverage bounds (zero-filled-history fix)', () => {
    it('live repro (zero-filled Apr-Jun + real July 1-8): months=1 window anchors at toDate 07-08, truncated to earliest 07-01', async () => {
      db.insert(schema.license)
        .values([
          { userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null },
          { userId: '1002', userLogin: 'bob', costCenterId: null, assignedAt: null },
        ])
        .run();
      const s1 = addSnapshot();
      addFacts(s1, [
        // Zero-filled leading months (real logins, zero credits) -- these must
        // NOT define coverage. Earliest all-date is 2026-04-01.
        { date: '2026-04-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
        { date: '2026-04-01', userId: '1002', userLogin: 'bob', creditsUsed: 0 },
        { date: '2026-05-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
        { date: '2026-05-01', userId: '1002', userLogin: 'bob', creditsUsed: 0 },
        { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
        { date: '2026-06-01', userId: '1002', userLogin: 'bob', creditsUsed: 0 },
        // Real current cycle.
        { date: '2026-07-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
        { date: '2026-07-08', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
        { date: '2026-07-03', userId: '1002', userLogin: 'bob', creditsUsed: 40 },
      ]);

      const result = await client.getUsageDistribution({ months: 1 });
      // Nonzero toDate 2026-07-08 (the zero-filled Apr-Jun rows are ignored) ->
      // current month JULY; months=1 is July-to-date. fromDate 2026-07-01;
      // monthsIncluded=1 -> not truncated. July: alice 100+50 = 150; bob 40.
      expect(result.toDate).toBe('2026-07-08');
      expect(result.fromDate).toBe('2026-07-01');
      expect(result.truncated).toBe(false);
      expect(result.monthsIncluded).toBe(1);
      expect(result.users).toEqual([
        { userLogin: 'alice', costCenterName: null, creditsUsed: 150 },
        { userLogin: 'bob', costCenterName: null, creditsUsed: 40 },
      ]);
    });

    it('trailing zero-fill (real May then a zero-filled newest June): toDate anchors at the last NONZERO date 2026-05-20', async () => {
      db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
      const s1 = addSnapshot();
      addFacts(s1, [
        { date: '2026-05-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
        { date: '2026-05-20', userId: '1001', userLogin: 'alice', creditsUsed: 50 }, // last NONZERO date
        { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 }, // trailing zero-fill (newest all-date)
        { date: '2026-06-10', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
      ]);

      const result = await client.getUsageDistribution({ months: 1 });
      // toDate is 2026-05-20 (NOT the zero-filled 06-10) -> current month MAY;
      // months=1 is May-to-date; fromDate 2026-05-01; monthsIncluded=1 -> not
      // truncated. May: alice 100+50 = 150 (the zero-filled June rows add nothing
      // and June is not even in the 1-month window).
      expect(result.toDate).toBe('2026-05-20');
      expect(result.fromDate).toBe('2026-05-01');
      expect(result.truncated).toBe(false);
      expect(result.monthsIncluded).toBe(1);
      expect(result.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 150 }]);
    });

    it('all-zero everything: rows exist but no nonzero coverage -> the sentinel', async () => {
      db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
      const s1 = addSnapshot();
      addFacts(s1, [
        { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
        { date: '2026-06-10', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
      ]);
      // Per-user rows exist (base is non-null) but the whole timeline is
      // zero-fill (base.toDate === '') -> no window to anchor -> sentinel.
      expect(await client.getUsageDistribution({ months: 1 })).toEqual({ fromDate: '', toDate: '', truncated: false, users: [] });
    });
  });
});

// Zero-erosion winner rule (2026-07-11, live-observed): GitHub's users-1-day
// report zero-fills history beyond its retention window, so a newer sync's
// zero-filled rows must NEVER supersede an earlier sync's real values for the
// same date. Per date the winning generation is the LATEST snapshot with a
// NONZERO row (fallback: latest snapshot with any row). Union-across-snapshots
// is the LIVE ('github') accumulation model, so these run on a github client.
// Every expectation is hand-computed from the seeded rows.
describe('getUsageDistribution -- zero-erosion winner rule', () => {
  function liveClient(): ApiClient {
    return createGitHubApiClient({ enterprise: 'test-ent', db, source: 'github' });
  }
  function addGithubSnapshot(): number {
    return db.insert(schema.snapshot).values({ capturedAt: new Date('2026-07-11T00:00:00Z'), source: 'github' }).returning().get().id;
  }
  function addGithubFacts(snapshotId: number, rows: SeedFact[]): void {
    db.insert(schema.creditsUsedFact)
      .values(rows.map((r) => ({ snapshotId, date: r.date, userId: r.userId, userLogin: r.userLogin ?? null, creditsUsed: r.creditsUsed })))
      .run();
  }
  function seedTwoUserLicenses(): void {
    db.insert(schema.license)
      .values([
        { userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null },
        { userId: '1002', userLogin: 'bob', costCenterId: null, assignedAt: null },
      ])
      .run();
  }

  it('EROSION REPRO: snap B zero-fills 07-01; the older real snap A still wins that date (self-healing, no migration)', async () => {
    seedTwoUserLicenses();
    // Snap A -- yesterday's sync: 07-01 + 07-02 REAL.
    const sA = addGithubSnapshot();
    addGithubFacts(sA, [
      { date: '2026-07-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
      { date: '2026-07-01', userId: '1002', userLogin: 'bob', creditsUsed: 50 },
      { date: '2026-07-02', userId: '1001', userLogin: 'alice', creditsUsed: 30 },
      { date: '2026-07-02', userId: '1002', userLogin: 'bob', creditsUsed: 20 },
    ]);
    // Snap B -- today's sync: 07-01 ZERO-FILLED (seeded directly, exactly as a
    // pre-fix DB already holds them -- half 2 would drop these at persist, but
    // the read-time winner rule must repair the ones already persisted); 07-02
    // CORRECTED (B wins, it has real data); 07-05/07-09 REAL (B only).
    const sB = addGithubSnapshot();
    expect(sB).toBeGreaterThan(sA);
    addGithubFacts(sB, [
      { date: '2026-07-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
      { date: '2026-07-01', userId: '1002', userLogin: 'bob', creditsUsed: 0 },
      { date: '2026-07-02', userId: '1001', userLogin: 'alice', creditsUsed: 35 },
      { date: '2026-07-02', userId: '1002', userLogin: 'bob', creditsUsed: 25 },
      { date: '2026-07-05', userId: '1001', userLogin: 'alice', creditsUsed: 10 },
      { date: '2026-07-05', userId: '1002', userLogin: 'bob', creditsUsed: 5 },
      { date: '2026-07-09', userId: '1001', userLogin: 'alice', creditsUsed: 7 },
    ]);

    const result = await liveClient().getUsageDistribution({ months: 1 });
    // Winners: 07-01 -> A (B is all-zero there); 07-02 -> B (corrected, both
    // nonzero, higher id); 07-05,07-09 -> B only. Nonzero toDate 2026-07-09 ->
    // current month JULY; months=1 is July-to-date (all winning rows are in
    // July); fromDate 2026-07-01; monthsIncluded=1 -> not truncated.
    expect(result.toDate).toBe('2026-07-09');
    expect(result.fromDate).toBe('2026-07-01');
    expect(result.truncated).toBe(false);
    expect(result.monthsIncluded).toBe(1);
    // alice = 100 (A 07-01) + 35 (B 07-02) + 10 (B 07-05) + 7 (B 07-09) = 152.
    //   (Buggy latest-wins would take B's zero for 07-01 -> 52. The fix -> 152.)
    // bob   = 50 (A 07-01) + 25 (B 07-02) + 5 (B 07-05)             = 80.
    expect(result.users).toEqual([
      { userLogin: 'alice', costCenterName: null, creditsUsed: 152 },
      { userLogin: 'bob', costCenterName: null, creditsUsed: 80 },
    ]);
  });

  it('settling-to-zero user: snap B wins 07-02 (it has a nonzero row) even though bob is ABSENT there, so bob contributes 0', async () => {
    seedTwoUserLicenses();
    // Snap A: 07-02 both users real.
    const sA = addGithubSnapshot();
    addGithubFacts(sA, [
      { date: '2026-07-02', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
      { date: '2026-07-02', userId: '1002', userLogin: 'bob', creditsUsed: 50 },
    ]);
    // Snap B: 07-02 alice nonzero, bob ABSENT (his zero row was dropped at
    // persist by half 2). B has a nonzero row for 07-02 -> B wins the DATE; bob
    // has no row in B, so bob's 07-02 total is 0. Intended: within the wire's
    // real-data window the newest report is the truth, INCLUDING a user's
    // genuine settling to zero -- the winner rule is per-DATE, not per-user.
    const sB = addGithubSnapshot();
    addGithubFacts(sB, [{ date: '2026-07-02', userId: '1001', userLogin: 'alice', creditsUsed: 60 }]);

    const result = await liveClient().getUsageDistribution({ months: 1 });
    // Single covered date 07-02: toDate 07-02 -> current month July; months=1 is
    // July-to-date; fromDate = first day of the current month = 2026-07-01.
    expect(result.toDate).toBe('2026-07-02');
    expect(result.fromDate).toBe('2026-07-01');
    expect(result.users).toEqual([
      { userLogin: 'alice', costCenterName: null, creditsUsed: 60 }, // B wins, NOT A's 100
      { userLogin: 'bob', costCenterName: null, creditsUsed: 0 }, // roster zero -- absent from the winning snap B
    ]);
  });

  it('whole-org idle day: a date with no rows in ANY snapshot is simply not in coverage (unchanged)', async () => {
    seedTwoUserLicenses();
    const s1 = addGithubSnapshot();
    // 07-02 has no rows at all in any snapshot -- a genuine gap between 07-01
    // and 07-03. It never appears in coverage and contributes nothing.
    addGithubFacts(s1, [
      { date: '2026-07-01', userId: '1001', userLogin: 'alice', creditsUsed: 40 },
      { date: '2026-07-03', userId: '1001', userLogin: 'alice', creditsUsed: 60 },
    ]);
    const result = await liveClient().getUsageDistribution({ months: 1 });
    expect(result.toDate).toBe('2026-07-03');
    expect(result.fromDate).toBe('2026-07-01'); // first day of the current month (July)
    expect(result.truncated).toBe(false); // monthsIncluded=1 == N
    expect(result.monthsIncluded).toBe(1);
    // alice 40 + 60 = 100 across the two real days; the idle 07-02 adds nothing.
    expect(result.users).toEqual([
      { userLogin: 'alice', costCenterName: null, creditsUsed: 100 },
      { userLogin: 'bob', costCenterName: null, creditsUsed: 0 },
    ]);
  });
});

// Calendar-anchored windows joining the MONTHLY per-user backfill (migration
// 0007). A PRIOR calendar month uses its monthly fact when one exists (MONTHLY
// WINS over daily -- billing is the money source of truth), else nonzero daily
// coverage, else contributes nothing. Monthly facts are github-source only, so
// these run on a 'github' client. Every value is hand-computed from the seeded
// rows.
describe('getUsageDistribution -- calendar-anchored windows with monthly-fact backfill', () => {
  function liveClient(): ApiClient {
    return createGitHubApiClient({ enterprise: 'test-ent', db, source: 'github' });
  }
  function addGithubSnapshot(): number {
    return db.insert(schema.snapshot).values({ capturedAt: new Date('2026-07-11T00:00:00Z'), source: 'github' }).returning().get().id;
  }
  function addGithubFacts(snapshotId: number, rows: SeedFact[]): void {
    db.insert(schema.creditsUsedFact)
      .values(rows.map((r) => ({ snapshotId, date: r.date, userId: r.userId, userLogin: r.userLogin ?? null, creditsUsed: r.creditsUsed })))
      .run();
  }
  interface MonthlyRow {
    month: string;
    userId: string | null;
    userLogin: string | null;
    creditsUsed: number;
  }
  function addMonthlyFacts(snapshotId: number, rows: MonthlyRow[]): void {
    db.insert(schema.creditsUsedMonthlyFact)
      .values(rows.map((r) => ({ snapshotId, month: r.month, userId: r.userId, userLogin: r.userLogin, creditsUsed: r.creditsUsed })))
      .run();
  }
  function seedTwoUserLicenses(): void {
    db.insert(schema.license)
      .values([
        { userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null },
        { userId: '1002', userLogin: 'bob', costCenterId: null, assignedAt: null },
      ])
      .run();
  }

  it('live-shaped: daily July 1-9 + monthly-fact June (+ NULL remainder); N=1 -> July only, N=3 -> June+July truncated with unattributed', async () => {
    seedTwoUserLicenses();
    const s = addGithubSnapshot();
    addGithubFacts(s, [
      { date: '2026-07-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
      { date: '2026-07-09', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
      { date: '2026-07-03', userId: '1002', userLogin: 'bob', creditsUsed: 40 },
    ]);
    // Closed-month billing backfill for June: alice 5000, bob 3000, remainder 700.
    addMonthlyFacts(s, [
      { month: '2026-06', userId: '1001', userLogin: 'alice', creditsUsed: 5000 },
      { month: '2026-06', userId: '1002', userLogin: 'bob', creditsUsed: 3000 },
      { month: '2026-06', userId: null, userLogin: null, creditsUsed: 700 },
    ]);

    // N=1: current month JULY only (June is a prior month, out of a 1-month
    // window). No monthly fact enters -> no unattributed remainder surfaced.
    const m1 = await liveClient().getUsageDistribution({ months: 1 });
    expect(m1.toDate).toBe('2026-07-09');
    expect(m1.fromDate).toBe('2026-07-01');
    expect(m1.truncated).toBe(false);
    expect(m1.monthsIncluded).toBe(1);
    expect(m1.unattributedCredits).toBeUndefined();
    expect(m1.users).toEqual([
      { userLogin: 'alice', costCenterName: null, creditsUsed: 150 }, // 100 + 50
      { userLogin: 'bob', costCenterName: null, creditsUsed: 40 },
    ]);

    // N=3: requested [Jul, Jun, May]. July daily + June monthly fact; May has no
    // data -> monthsIncluded=2 < 3 -> truncated. fromDate = 1st of oldest
    // contributing month (June). alice 150 + 5000 = 5150; bob 40 + 3000 = 3040.
    // The NULL-user June remainder (700) is EXCLUDED from per-user totals and
    // surfaced as the window-total unattributedCredits.
    const m3 = await liveClient().getUsageDistribution({ months: 3 });
    expect(m3.toDate).toBe('2026-07-09');
    expect(m3.fromDate).toBe('2026-06-01');
    expect(m3.truncated).toBe(true);
    expect(m3.monthsIncluded).toBe(2);
    expect(m3.unattributedCredits).toBe(700);
    expect(m3.users).toEqual([
      { userLogin: 'alice', costCenterName: null, creditsUsed: 5150 },
      { userLogin: 'bob', costCenterName: null, creditsUsed: 3040 },
    ]);
  });

  it('monthly wins: a month with BOTH daily coverage and a monthly fact uses the MONTHLY values for that month', async () => {
    db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
    const s = addGithubSnapshot();
    addGithubFacts(s, [
      { date: '2026-05-10', userId: '1001', userLogin: 'alice', creditsUsed: 999 }, // daily MAY -- must be OVERRIDDEN by the monthly fact
      { date: '2026-06-05', userId: '1001', userLogin: 'alice', creditsUsed: 100 }, // current month June (toDate)
    ]);
    addMonthlyFacts(s, [{ month: '2026-05', userId: '1001', userLogin: 'alice', creditsUsed: 4000 }]);

    // N=3: [Jun, May, Apr]. June daily (100) + May MONTHLY (4000, NOT the daily
    // 999) + April nothing -> monthsIncluded=2, truncated. alice 100 + 4000 = 4100.
    const m3 = await liveClient().getUsageDistribution({ months: 3 });
    expect(m3.toDate).toBe('2026-06-05');
    expect(m3.fromDate).toBe('2026-05-01');
    expect(m3.truncated).toBe(true);
    expect(m3.monthsIncluded).toBe(2);
    expect(m3.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 4100 }]);
  });

  it('gap month: daily Mar, nothing Apr, monthly May, daily current Jun -> contributing Mar/May/Jun, truncated at N=9, fromDate = Mar 1', async () => {
    db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
    const s = addGithubSnapshot();
    addGithubFacts(s, [
      { date: '2026-03-15', userId: '1001', userLogin: 'alice', creditsUsed: 300 }, // daily March
      { date: '2026-06-10', userId: '1001', userLogin: 'alice', creditsUsed: 200 }, // current month June (toDate)
      // April: nothing at all.
    ]);
    addMonthlyFacts(s, [{ month: '2026-05', userId: '1001', userLogin: 'alice', creditsUsed: 1000 }]); // monthly May

    // N=9: requested [Jun..Oct-2025]. Jun (current, 200) + May (monthly, 1000) +
    // Mar (daily, 300) contribute; Apr and everything older contribute nothing
    // -> monthsIncluded=3 < 9 -> truncated. fromDate = 1st of the oldest
    // contributing month (March) = 2026-03-01. alice 200 + 1000 + 300 = 1500.
    const m9 = await liveClient().getUsageDistribution({ months: 9 });
    expect(m9.toDate).toBe('2026-06-10');
    expect(m9.fromDate).toBe('2026-03-01');
    expect(m9.truncated).toBe(true);
    expect(m9.monthsIncluded).toBe(3);
    expect(m9.unattributedCredits).toBeUndefined();
    expect(m9.users).toEqual([{ userLogin: 'alice', costCenterName: null, creditsUsed: 1500 }]);
  });
});
