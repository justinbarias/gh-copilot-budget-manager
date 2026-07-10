import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { createGitHubApiClient } from './github-impl.js';
import type { ApiClient } from './types.js';

// Distribution "Per month" lens: getUserMonthObservations is a PURE local-SQLite
// read (no MSW server attached -- any GitHub/HTTP call would fail loudly), the
// per-(user, complete-calendar-month) counterpart to getUsageDistribution. It
// reuses the SAME union/latest-wins winning-rows base + roster/name lookups,
// re-bucketed by whole calendar month.
//
// Every expectation below is hand-computed from the seeded rows; the sums,
// complete-month sets, and truncation flags are derived in the comments, never
// copied from the implementation's output.

let tmpDir: string;
let db: Db;
let client: ApiClient;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-user-month-obs-test-'));
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
  userLogin?: string | null;
  creditsUsed: number;
}

function addFacts(snapshotId: number, rows: SeedFact[]): void {
  db.insert(schema.creditsUsedFact)
    .values(rows.map((r) => ({ snapshotId, date: r.date, userId: r.userId, userLogin: r.userLogin ?? null, creditsUsed: r.creditsUsed })))
    .run();
}

// Main seeded world -- coverage 2026-03-01 .. 2026-06-12, so complete calendar
// months are Mar/Apr/May 2026 (June's month-end 06-30 exceeds toDate 06-12 ->
// the partial current month is excluded):
//   alice (1001, cc-a "Alpha"): 03-01: 100 | 03-15: 50 | 04-10: 200 | 05-20: 30 | 06-05: 999(Jun,excl)
//   bob   (1002, unassigned):   04-01: 300 | 05-01: 25.4  (REAL -> round-at-end)
//   carol (1003, cc-b "Beta"):  03-14: 5
//   dave  (1004, cc-a "Alpha"): licensed, ZERO usage
//   frank (2002, NO license):   04-20: 60  (fact-only WITH an in-window fact -> appears, D2-consistent)
//   eve   (2001, NO license):   06-12: 40  (fact-only whose ONLY fact is the partial June -> NEVER appears in a complete-month call; also sets toDate)
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
    { date: '2026-03-15', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
    { date: '2026-04-10', userId: '1001', userLogin: 'alice', creditsUsed: 200 },
    { date: '2026-05-20', userId: '1001', userLogin: 'alice', creditsUsed: 30 },
    { date: '2026-06-05', userId: '1001', userLogin: 'alice', creditsUsed: 999 }, // Jun (partial) -> excluded everywhere
    { date: '2026-04-01', userId: '1002', userLogin: 'bob', creditsUsed: 300 },
    { date: '2026-05-01', userId: '1002', userLogin: 'bob', creditsUsed: 25.4 },
    { date: '2026-03-14', userId: '1003', userLogin: 'carol', creditsUsed: 5 },
    { date: '2026-04-20', userId: '2002', userLogin: 'frank', creditsUsed: 60 }, // fact-only, in-window
    { date: '2026-06-12', userId: '2001', userLogin: 'eve', creditsUsed: 40 }, // fact-only, partial-June only -> excluded
  ]);
}

describe('getUserMonthObservations', () => {
  it('months=1: the single most-recent complete month [2026-05]; roster zeros; partial June + out-of-window fact-only users excluded', async () => {
    seedMainWorld();
    const result = await client.getUserMonthObservations({ months: 1 });

    // Coverage 03-01..06-12 -> complete months Mar/Apr/May; last 1 = [2026-05].
    // 3 complete months >= 1 -> not truncated.
    expect(result.months).toEqual(['2026-05']);
    expect(result.truncated).toBe(false);

    // May sums (winning rows in 2026-05 only):
    //   alice: 05-20 30
    //   bob:   05-01 25.4 -> round 25
    //   carol: 0 (no May row)  |  dave: 0 (no usage)
    // frank (fact-only, April) has NO May-or-earlier in-window fact for a
    // May-only call -> absent; eve (June-only) -> absent. So 4 licensed users.
    expect(result.observations).toEqual([
      { userLogin: 'alice', costCenterName: 'Alpha', month: '2026-05', creditsUsed: 30 },
      { userLogin: 'bob', costCenterName: null, month: '2026-05', creditsUsed: 25 },
      { userLogin: 'carol', costCenterName: 'Beta', month: '2026-05', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', month: '2026-05', creditsUsed: 0 },
    ]);
  });

  it('months=3: all three complete months [Mar,Apr,May]; one observation per (user, month) incl. zeros; a fact-only in-window user appears', async () => {
    seedMainWorld();
    const result = await client.getUserMonthObservations({ months: 3 });

    // Last 3 of [Mar,Apr,May] = all three; 3 complete >= 3 -> not truncated.
    expect(result.months).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(result.truncated).toBe(false);

    // Per (user, month) sums:
    //   alice Mar = 100+50 = 150 | Apr = 200 | May = 30
    //   bob   Mar = 0 | Apr = 300 | May = 25.4 -> 25
    //   carol Mar = 5 | Apr = 0 | May = 0
    //   dave  0 | 0 | 0
    //   frank Mar = 0 | Apr = 60 | May = 0  (fact-only, appears now that April is in scope)
    // eve is STILL absent (its only fact is the excluded partial June).
    // 5 users x 3 months = 15 observations; sorted login asc, then month asc.
    expect(result.observations).toEqual([
      { userLogin: 'alice', costCenterName: 'Alpha', month: '2026-03', creditsUsed: 150 },
      { userLogin: 'alice', costCenterName: 'Alpha', month: '2026-04', creditsUsed: 200 },
      { userLogin: 'alice', costCenterName: 'Alpha', month: '2026-05', creditsUsed: 30 },
      { userLogin: 'bob', costCenterName: null, month: '2026-03', creditsUsed: 0 },
      { userLogin: 'bob', costCenterName: null, month: '2026-04', creditsUsed: 300 },
      { userLogin: 'bob', costCenterName: null, month: '2026-05', creditsUsed: 25 },
      { userLogin: 'carol', costCenterName: 'Beta', month: '2026-03', creditsUsed: 5 },
      { userLogin: 'carol', costCenterName: 'Beta', month: '2026-04', creditsUsed: 0 },
      { userLogin: 'carol', costCenterName: 'Beta', month: '2026-05', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', month: '2026-03', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', month: '2026-04', creditsUsed: 0 },
      { userLogin: 'dave', costCenterName: 'Alpha', month: '2026-05', creditsUsed: 0 },
      { userLogin: 'frank', costCenterName: null, month: '2026-03', creditsUsed: 0 },
      { userLogin: 'frank', costCenterName: null, month: '2026-04', creditsUsed: 60 },
      { userLogin: 'frank', costCenterName: null, month: '2026-05', creditsUsed: 0 },
    ]);
  });

  it('months=9 over ~3 complete months: includes every available complete month and sets truncated=true', async () => {
    seedMainWorld();
    const result = await client.getUserMonthObservations({ months: 9 });

    // Only 3 complete months exist -> last 9 = all 3; 3 < 9 -> truncated.
    expect(result.months).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(result.truncated).toBe(true);
    expect(result.observations).toHaveLength(15); // 5 users (4 licensed + frank) x 3 months
  });

  it('excludes a month straddling `earliest` and includes a month ending EXACTLY on toDate', async () => {
    db.insert(schema.license).values({ userId: '3001', userLogin: 'zed', costCenterId: null, assignedAt: null }).run();
    const s1 = addSnapshot();
    addFacts(s1, [
      { date: '2026-04-15', userId: '3001', userLogin: 'zed', creditsUsed: 10 }, // earliest; April's start 04-01 < 04-15 -> April excluded
      { date: '2026-05-10', userId: '3001', userLogin: 'zed', creditsUsed: 20 }, // May complete
      { date: '2026-06-30', userId: '3001', userLogin: 'zed', creditsUsed: 7 }, // toDate; June's end 06-30 == toDate -> June complete
    ]);

    // earliest 2026-04-15, toDate 2026-06-30. Complete: May (05-01>=04-15,
    // 05-31<=06-30) and June (06-01>=04-15, 06-30<=06-30). April straddles
    // earliest -> excluded.
    const r3 = await client.getUserMonthObservations({ months: 3 });
    expect(r3.months).toEqual(['2026-05', '2026-06']);
    expect(r3.truncated).toBe(true); // 2 complete < 3
    expect(r3.observations).toEqual([
      { userLogin: 'zed', costCenterName: null, month: '2026-05', creditsUsed: 20 },
      { userLogin: 'zed', costCenterName: null, month: '2026-06', creditsUsed: 7 },
    ]);

    const r1 = await client.getUserMonthObservations({ months: 1 });
    expect(r1.months).toEqual(['2026-06']);
    expect(r1.truncated).toBe(false);
    expect(r1.observations).toEqual([{ userLogin: 'zed', costCenterName: null, month: '2026-06', creditsUsed: 7 }]);
  });

  it("union/latest-wins within a month (LIVE 'github' source): a superseded day takes the later snapshot; an older-only day still contributes", async () => {
    // Union-across-snapshots is the LIVE accumulation oracle (one real
    // enterprise, many syncs). The 'msw' source now scopes to the latest
    // snapshot only (scenario-contamination fix 2026-07-10; see the msw-scoping
    // test below), so this test -- unchanged in every assertion -- runs on a
    // 'github' client + 'github' snapshots to keep exercising the union path.
    const liveClient = createGitHubApiClient({ enterprise: 'test-ent', db, source: 'github' });
    db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
    const s1 = addSnapshot('github');
    addFacts(s1, [
      { date: '2026-05-01', userId: '1001', userLogin: 'alice', creditsUsed: 10 }, // only in S1 -> still counts
      { date: '2026-05-10', userId: '1001', userLogin: 'alice', creditsUsed: 100 }, // superseded by S2's 60
      { date: '2026-05-31', userId: '1001', userLogin: 'alice', creditsUsed: 5 }, // makes May's end covered
    ]);
    const s2 = addSnapshot('github');
    expect(s2).toBeGreaterThan(s1);
    addFacts(s2, [{ date: '2026-05-10', userId: '1001', userLogin: 'alice', creditsUsed: 60 }]);

    // Coverage {05-01,05-10,05-31}: earliest 05-01, toDate 05-31 -> May complete.
    const result = await liveClient.getUserMonthObservations({ months: 1 });
    expect(result.months).toEqual(['2026-05']);
    expect(result.truncated).toBe(false);
    // 10 (S1-only) + 60 (S2 wins over S1's 100) + 5 = 75 -- NOT 175, NOT 115.
    expect(result.observations).toEqual([{ userLogin: 'alice', costCenterName: null, month: '2026-05', creditsUsed: 75 }]);
  });

  it('is scenario-scoped on the msw source: the complete-month set comes from the LATEST snapshot only (a later scenario never contaminates an earlier one)', async () => {
    // Per-month counterpart to the D2 scenario-contamination fix: the reported
    // bug had a later scenario widen an earlier one's month set. Latest-snapshot
    // scoping keeps each scenario's month set its own. Default msw client.
    db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();

    // Snapshot A -- a March world (complete March: earliest 03-01, toDate 03-31).
    const sA = addSnapshot();
    addFacts(sA, [
      { date: '2026-03-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
      { date: '2026-03-31', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
    ]);
    const afterA = await client.getUserMonthObservations({ months: 1 });
    expect(afterA.months).toEqual(['2026-03']);
    expect(afterA.observations).toEqual([{ userLogin: 'alice', costCenterName: null, month: '2026-03', creditsUsed: 150 }]);

    // Snapshot B -- a LATER world (August). Under old union, earliest 03-01 +
    // toDate 08-31 would have made Mar..Aug all complete (contamination).
    const sB = addSnapshot();
    addFacts(sB, [
      { date: '2026-08-01', userId: '1001', userLogin: 'alice', creditsUsed: 300 },
      { date: '2026-08-31', userId: '1001', userLogin: 'alice', creditsUsed: 200 },
    ]);
    // ONLY B: earliest 08-01, toDate 08-31 -> August complete; March absent.
    const afterB = await client.getUserMonthObservations({ months: 3 });
    expect(afterB.months).toEqual(['2026-08']);
    expect(afterB.truncated).toBe(true); // 1 complete < 3
    expect(afterB.observations).toEqual([{ userLogin: 'alice', costCenterName: null, month: '2026-08', creditsUsed: 500 }]);

    // Snapshot C -- back to a May world; only C is read, B's August gone.
    const sC = addSnapshot();
    expect(sC).toBeGreaterThan(sB);
    addFacts(sC, [
      { date: '2026-05-01', userId: '1001', userLogin: 'alice', creditsUsed: 70 },
      { date: '2026-05-31', userId: '1001', userLogin: 'alice', creditsUsed: 30 },
    ]);
    const afterC = await client.getUserMonthObservations({ months: 1 });
    expect(afterC.months).toEqual(['2026-05']);
    expect(afterC.observations).toEqual([{ userLogin: 'alice', costCenterName: null, month: '2026-05', creditsUsed: 100 }]);
  });

  it('returns the sentinel on a fresh, never-synced DB', async () => {
    expect(await client.getUserMonthObservations({ months: 3 })).toEqual({ months: [], truncated: false, observations: [] });
  });

  it('returns the sentinel when synced history has no complete calendar month (only a partial current month)', async () => {
    db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
    const s1 = addSnapshot();
    addFacts(s1, [
      { date: '2026-06-03', userId: '1001', userLogin: 'alice', creditsUsed: 10 },
      { date: '2026-06-12', userId: '1001', userLogin: 'alice', creditsUsed: 20 },
    ]);
    // earliest 06-03, toDate 06-12; June's start 06-01 < 06-03 -> no complete month.
    expect(await client.getUserMonthObservations({ months: 1 })).toEqual({ months: [], truncated: false, observations: [] });
  });

  it('is source-scoped (§6.8): an msw client never aggregates github-synced facts (and vice versa)', async () => {
    const sGithub = addSnapshot('github');
    addFacts(sGithub, [
      { date: '2026-05-01', userId: '1001', userLogin: 'alice', creditsUsed: 500 },
      { date: '2026-05-31', userId: '1001', userLogin: 'alice', creditsUsed: 5 },
    ]);

    // The msw client sees NO msw-sourced history -> honest sentinel.
    expect(await client.getUserMonthObservations({ months: 1 })).toEqual({ months: [], truncated: false, observations: [] });

    // A github client over the SAME DB sees its own rows: coverage 05-01..05-31
    // -> May complete; alice May = 500 + 5 = 505.
    const liveClient = createGitHubApiClient({ enterprise: 'test-ent', db, source: 'github' });
    const live = await liveClient.getUserMonthObservations({ months: 1 });
    expect(live.months).toEqual(['2026-05']);
    expect(live.observations).toEqual([{ userLogin: 'alice', costCenterName: null, month: '2026-05', creditsUsed: 505 }]);
  });

  it('rejects a months value outside 1|3|9 (the IPC boundary is untyped at runtime)', async () => {
    await expect(client.getUserMonthObservations({ months: 2 as never })).rejects.toThrow('months must be 1, 3, or 9');
    await expect(client.getUserMonthObservations({ months: '3' as never })).rejects.toThrow('months must be 1, 3, or 9');
  });

  // Zero-filled-history fix (2026-07-10): completeness anchors on the NONZERO
  // coverage bounds so a zero-filled month (GitHub zero-fills history beyond
  // retention) never masquerades as a complete month of all-zero observations.
  describe('nonzero coverage bounds (zero-filled-history fix)', () => {
    it('live repro (zero-filled Apr-Jun + real July 1-8): NO complete calendar month -> sentinel', async () => {
      db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
      const s1 = addSnapshot();
      addFacts(s1, [
        { date: '2026-04-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 }, // zero-fill
        { date: '2026-05-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 }, // zero-fill
        { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 }, // zero-fill
        { date: '2026-07-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
        { date: '2026-07-08', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
      ]);
      // Nonzero bounds: earliest 07-01, toDate 07-08. July's month-end 07-31 >
      // toDate 07-08 -> July is the partial current month, excluded. No other
      // month is covered (Apr-Jun are zero-fill, outside the nonzero bounds) ->
      // no complete calendar month -> sentinel.
      expect(await client.getUserMonthObservations({ months: 1 })).toEqual({ months: [], truncated: false, observations: [] });
    });

    it('interior all-zero month (nonzero March + May, zero-filled April): April still counts as complete, yielding all-zero observations', async () => {
      db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
      const s1 = addSnapshot();
      addFacts(s1, [
        { date: '2026-03-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
        { date: '2026-03-31', userId: '1001', userLogin: 'alice', creditsUsed: 50 },
        { date: '2026-04-10', userId: '1001', userLogin: 'alice', creditsUsed: 0 }, // interior zero
        { date: '2026-04-20', userId: '1001', userLogin: 'alice', creditsUsed: 0 }, // interior zero
        { date: '2026-05-01', userId: '1001', userLogin: 'alice', creditsUsed: 30 },
        { date: '2026-05-31', userId: '1001', userLogin: 'alice', creditsUsed: 20 },
      ]);
      // Nonzero bounds: earliest 03-01, toDate 05-31. Complete months Mar/Apr/May
      // (April sits INSIDE [earliest, toDate], so it is complete despite being
      // all-zero -- bounds are edge-based, not a per-month filter).
      const result = await client.getUserMonthObservations({ months: 3 });
      expect(result.months).toEqual(['2026-03', '2026-04', '2026-05']);
      expect(result.truncated).toBe(false);
      expect(result.observations).toEqual([
        { userLogin: 'alice', costCenterName: null, month: '2026-03', creditsUsed: 150 },
        { userLogin: 'alice', costCenterName: null, month: '2026-04', creditsUsed: 0 }, // all-zero, still emitted
        { userLogin: 'alice', costCenterName: null, month: '2026-05', creditsUsed: 50 },
      ]);
    });

    it('all-zero everything: rows exist but no nonzero coverage -> the sentinel', async () => {
      db.insert(schema.license).values({ userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null }).run();
      const s1 = addSnapshot();
      addFacts(s1, [
        { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
        { date: '2026-06-30', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
      ]);
      // Base non-null (rows exist) but base.toDate === '' -> sentinel.
      expect(await client.getUserMonthObservations({ months: 3 })).toEqual({ months: [], truncated: false, observations: [] });
    });
  });
});

// Zero-erosion winner rule (2026-07-11, live-observed): a newer sync's
// zero-filled rows must never supersede an earlier sync's real values for the
// same date. Per date the winner is the LATEST snapshot with a NONZERO row.
// Union-across-snapshots is the LIVE ('github') model, so these run on a github
// client. Every expectation is hand-computed from the seeded rows.
describe('getUserMonthObservations -- zero-erosion winner rule', () => {
  function liveClient(): ApiClient {
    return createGitHubApiClient({ enterprise: 'test-ent', db, source: 'github' });
  }

  it('EROSION REPRO: snap B zero-fills 06-01; the older real snap A still wins that date, so June is complete with the REAL totals', async () => {
    db.insert(schema.license)
      .values([
        { userId: '1001', userLogin: 'alice', costCenterId: null, assignedAt: null },
        { userId: '1002', userLogin: 'bob', costCenterId: null, assignedAt: null },
      ])
      .run();
    // Snap A -- yesterday's sync: June REAL (06-01 anchors the month start).
    const sA = addSnapshot('github');
    addFacts(sA, [
      { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 100 },
      { date: '2026-06-01', userId: '1002', userLogin: 'bob', creditsUsed: 50 },
      { date: '2026-06-20', userId: '1001', userLogin: 'alice', creditsUsed: 40 },
      { date: '2026-06-20', userId: '1002', userLogin: 'bob', creditsUsed: 10 },
    ]);
    // Snap B -- today's sync: 06-01 ZERO-FILLED (seeded directly, as pre-fix DBs
    // hold them); 06-20 CORRECTED (B wins); 07-10 REAL (anchors toDate so June
    // is a COMPLETE month and July stays the excluded partial current month).
    const sB = addSnapshot('github');
    expect(sB).toBeGreaterThan(sA);
    addFacts(sB, [
      { date: '2026-06-01', userId: '1001', userLogin: 'alice', creditsUsed: 0 },
      { date: '2026-06-01', userId: '1002', userLogin: 'bob', creditsUsed: 0 },
      { date: '2026-06-20', userId: '1001', userLogin: 'alice', creditsUsed: 45 },
      { date: '2026-06-20', userId: '1002', userLogin: 'bob', creditsUsed: 12 },
      { date: '2026-07-10', userId: '1001', userLogin: 'alice', creditsUsed: 8 },
    ]);

    const result = await liveClient().getUserMonthObservations({ months: 1 });
    // Nonzero coverage: earliest 06-01, toDate 07-10. Complete months: June only
    // (06-30 <= 07-10); July's 07-31 > toDate -> excluded partial. 1 complete
    // month, months=1 -> not truncated.
    expect(result.months).toEqual(['2026-06']);
    expect(result.truncated).toBe(false);
    // Winners: 06-01 -> A (B all-zero there), 06-20 -> B (corrected).
    // alice June = 100 (A) + 45 (B) = 145; bob June = 50 (A) + 12 (B) = 62.
    //   (Buggy latest-wins would take B's 06-01 zeros -> alice 45, bob 12.)
    expect(result.observations).toEqual([
      { userLogin: 'alice', costCenterName: null, month: '2026-06', creditsUsed: 145 },
      { userLogin: 'bob', costCenterName: null, month: '2026-06', creditsUsed: 62 },
    ]);
  });
});
