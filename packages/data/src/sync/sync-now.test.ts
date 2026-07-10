import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { BudgetControl, ControlState, ForecastResult, IncludedCapControl } from '@copilot-budget/core';
import { controlSnapshot, costCenter, costCenterMember, creditsUsedFact, license, snapshot, usageFact } from '../db/schema.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { getLastSyncedControls, getLatestForecast, getSyncStatus, syncNow, type IngestData, type IngestForecastItem } from './sync-now.js';

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-sync-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseData: IngestData = {
  entity: 'acme-enterprise',
  usageItems: [
    { date: '2026-06-14', costCenterId: 'cc-platform', userLogin: 'user-01', sku: 'ai_credits', quantity: 420, netAmountUsd: 0 },
    { date: '2026-06-14', costCenterId: 'cc-data-analytics', userLogin: 'user-16', sku: 'ai_credits', quantity: 310, netAmountUsd: 0 },
  ],
  creditsUsedItems: [
    { date: '2026-06-14', userId: '1001', userLogin: 'user-01', creditsUsed: 420 },
    { date: '2026-06-14', userId: '1016', userLogin: 'user-16', creditsUsed: 310 },
  ],
  costCenters: [
    { id: 'cc-platform', name: 'Platform', state: 'active' },
    { id: 'cc-data-analytics', name: 'Data & Analytics', state: 'active' },
  ],
  costCenterMembers: [
    { costCenterId: 'cc-platform', resourceType: 'user', resourceId: 'user-01' },
    { costCenterId: 'cc-data-analytics', resourceType: 'user', resourceId: 'user-16' },
  ],
  licenses: [
    { userId: '1001', userLogin: 'user-01', costCenterId: 'cc-platform', assignedAt: new Date('2026-06-01T00:00:00Z') },
    { userId: '1016', userLogin: 'user-16', costCenterId: 'cc-data-analytics', assignedAt: new Date('2026-06-01T00:00:00Z') },
  ],
  controls: [
    {
      kind: 'budget',
      scope: 'individual',
      entityName: 'user-01',
      amountCredits: 6000,
      preventFurtherUsage: true,
      alerting: { willAlert: true, alertRecipients: ['copilot-admins@acme.example'] },
      // Task 4.15: this is the ONE fixture control here that carries the
      // simulation-only display-bug enrichment -- exercises
      // stripDisplayOnlyFields without needing a second describe block's
      // worth of setup.
      simulatedUiHidden: true,
    } satisfies BudgetControl,
    {
      kind: 'included_cap',
      costCenterName: 'Platform',
      enabled: true,
      overflow: 'block',
      computedLimitCredits: 105_000,
    } satisfies IncludedCapControl,
  ],
  forecasts: [],
};

// Minimal, structurally-valid ForecastResult -- these mode-isolation tests
// only care that a row round-trips through getLatestForecast unmodified, not
// that the forecast math itself is realistic (that's compute.test.ts's job).
function fakeForecastResult(marker: number): ForecastResult {
  return {
    dailySeries: [{ date: '2026-06-14', p50Cumulative: marker, p90Cumulative: marker, allowanceLine: 10_000, provisional: false }],
    exhaustionDate: null,
    exhaustionDateP90: null,
    runwayDays: null,
    projectedMeteredCredits: 0,
    projectedMeteredDollars: 0,
    basis: { runRate: marker, weekdayIndices: [1, 1, 1, 1, 1, 1, 1], settlingWindowDays: 14, asOfDate: '2026-06-14', dailyVariance: 0 },
  };
}

function enterpriseForecastItem(marker: number, computedAt = '2026-06-14'): IngestForecastItem {
  return { scope: 'enterprise', entityId: null, computedAt, result: fakeForecastResult(marker), mape: null };
}

describe('syncNow', () => {
  it('ingests a fresh DB with exactly the fixture data on one call', () => {
    const result = syncNow(db, 'msw', baseData);

    expect(result.usageFactCount).toBe(2);
    expect(result.creditsUsedFactCount).toBe(2);
    expect(result.controlCount).toBe(2);

    const usageRows = db.select().from(usageFact).all();
    expect(usageRows).toHaveLength(2);
    expect(usageRows.every((r) => r.snapshotId === result.snapshotId)).toBe(true);
    expect(usageRows.find((r) => r.userId === 'user-01')).toMatchObject({
      costCenterId: 'cc-platform',
      model: 'ai_credits',
      netQuantity: 420,
      netAmount: 0,
      entity: 'acme-enterprise',
    });

    expect(db.select().from(creditsUsedFact).all()).toHaveLength(2);
    expect(db.select().from(costCenter).all()).toHaveLength(2);
    expect(db.select().from(costCenterMember).all()).toHaveLength(2);
    expect(db.select().from(license).all()).toHaveLength(2);
  });

  it('chunks large fact inserts across the 500-row boundary, all under one snapshot (SQLITE_MAX_VARIABLE_NUMBER guard)', () => {
    // 501 credits rows -> 2 chunks (500 + 1); 500 usage rows -> exactly 1 chunk.
    // The boundary that matters: chunk math must lose no rows and every row must
    // land under the SAME snapshot generation (all chunks share one tx).
    // creditsUsed is i+1 (1..501), all NONZERO, so the persist-time zero-drop
    // (zero-erosion fix) leaves the full 501-row count intact -- keeping this a
    // pure test of chunk math across the 500-row boundary. (Pre-fix this seeded
    // i = 0..501, whose i=0 zero row would now be dropped, collapsing 501 -> 500
    // rows and destroying the two-chunk boundary this test exists to exercise.)
    const bigData: IngestData = {
      ...baseData,
      creditsUsedItems: Array.from({ length: 501 }, (_, i) => ({
        date: '2026-06-14',
        userId: `u-${i}`,
        userLogin: `login-${i}`,
        creditsUsed: i + 1,
      })),
      usageItems: Array.from({ length: 500 }, (_, i) => ({
        date: '2026-06-14',
        costCenterId: 'cc-platform',
        userLogin: `login-${i}`,
        sku: 'ai_credits',
        quantity: i,
        netAmountUsd: 0,
      })),
    };

    const result = syncNow(db, 'msw', bigData);
    expect(result.creditsUsedFactCount).toBe(501);
    expect(result.usageFactCount).toBe(500);

    const credits = db.select().from(creditsUsedFact).all();
    expect(credits).toHaveLength(501);
    expect(credits.every((r) => r.snapshotId === result.snapshotId)).toBe(true);
    // Exact-sum survives chunking: Σ 1..501 = 125,751.
    expect(credits.reduce((s, r) => s + r.creditsUsed, 0)).toBe(125_751);

    const usage = db.select().from(usageFact).all();
    expect(usage).toHaveLength(500);
    expect(usage.every((r) => r.snapshotId === result.snapshotId)).toBe(true);
    // Exactly one snapshot generation for the whole chunked write.
    expect(db.select().from(snapshot).all()).toHaveLength(1);
  });

  it('rolls back EVERY chunk + the snapshot row when a later chunk throws (chunked inserts share the one transaction)', () => {
    // A bad row (null date violates NOT NULL) at index 500 lands in the SECOND
    // credits chunk. Chunk 1 (rows 0..499) inserts first; chunk 2 throws. If the
    // chunked inserts were NOT inside the snapshot's transaction, chunk 1's 500
    // rows and/or the snapshot row would survive. They must not. creditsUsed is
    // i+1 (all nonzero) so the persist-time zero-drop keeps all 501 rows -> the
    // two-chunk split the rollback assertion depends on is preserved.
    const rows = Array.from({ length: 501 }, (_, i) => ({
      date: '2026-06-14',
      userId: `u-${i}`,
      userLogin: `login-${i}`,
      creditsUsed: i + 1,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rows[500] as any).date = null; // NOT NULL violation -> chunk 2 throws
    const badData: IngestData = { ...baseData, creditsUsedItems: rows };

    expect(() => syncNow(db, 'msw', badData)).toThrow();

    // Full rollback: no snapshot, no credits rows, no usage rows, no dimensions.
    expect(db.select().from(snapshot).all()).toHaveLength(0);
    expect(db.select().from(creditsUsedFact).all()).toHaveLength(0);
    expect(db.select().from(usageFact).all()).toHaveLength(0);
    expect(db.select().from(costCenter).all()).toHaveLength(0);
  });

  it('produces two distinct snapshot generations across two calls, without duplicating dimension rows', () => {
    const first = syncNow(db, 'msw', baseData);

    const secondUsage: IngestData = {
      ...baseData,
      usageItems: [
        { date: '2026-06-15', costCenterId: 'cc-platform', userLogin: 'user-01', sku: 'ai_credits', quantity: 50, netAmountUsd: 0 },
      ],
      creditsUsedItems: [{ date: '2026-06-15', userId: '1001', userLogin: 'user-01', creditsUsed: 50 }],
    };
    const second = syncNow(db, 'msw', secondUsage);

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(db.select().from(snapshot).all()).toHaveLength(2);

    // Facts append across generations -- both syncs' rows must survive.
    expect(db.select().from(usageFact).all()).toHaveLength(3);
    expect(db.select().from(creditsUsedFact).all()).toHaveLength(3);

    // Dimensions reflect current state only: re-syncing the same cost
    // centers/members/licenses must not duplicate rows on the second call.
    expect(db.select().from(costCenter).all()).toHaveLength(2);
    expect(db.select().from(costCenterMember).all()).toHaveLength(2);
    expect(db.select().from(license).all()).toHaveLength(2);
  });

  // Distribution D2 (migration 0005): both fact and license rows persist the
  // user's login alongside the numeric id.
  it('persists user_login on credits_used_fact and license rows', () => {
    syncNow(db, 'msw', baseData);

    const factRows = db.select().from(creditsUsedFact).all();
    expect(factRows.find((r) => r.userId === '1001')).toMatchObject({ userLogin: 'user-01', creditsUsed: 420 });
    expect(factRows.find((r) => r.userId === '1016')).toMatchObject({ userLogin: 'user-16', creditsUsed: 310 });

    const licenseRows = db.select().from(license).all();
    expect(licenseRows.find((r) => r.userId === '1001')).toMatchObject({ userLogin: 'user-01', costCenterId: 'cc-platform' });
    expect(licenseRows.find((r) => r.userId === '1016')).toMatchObject({ userLogin: 'user-16' });
  });

  // Persist-time zero-drop (zero-erosion fix, 2026-07-11): rows with
  // creditsUsed <= 0 are never inserted -- they carry no information (roster
  // zeros are reconstructed from the license join at read time) and are the
  // erosion vector for GitHub's zero-filled per-user history.
  it('drops creditsUsed <= 0 rows at persist: a mixed array persists only the nonzero rows', () => {
    const mixed: IngestData = {
      ...baseData,
      creditsUsedItems: [
        { date: '2026-06-14', userId: '1001', userLogin: 'user-01', creditsUsed: 420 }, // kept
        { date: '2026-06-14', userId: '1002', userLogin: 'user-02', creditsUsed: 0 }, // dropped (zero)
        { date: '2026-06-13', userId: '1003', userLogin: 'user-03', creditsUsed: -5 }, // dropped (negative, defensive)
        { date: '2026-06-14', userId: '1016', userLogin: 'user-16', creditsUsed: 310 }, // kept
      ],
    };
    const result = syncNow(db, 'msw', mixed);

    // Only the 2 nonzero rows persist; the count reflects the ACTUAL persisted set.
    expect(result.creditsUsedFactCount).toBe(2);
    const rows = db.select().from(creditsUsedFact).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual(['1001', '1016']);
    // No zero/negative row survives.
    expect(rows.every((r) => r.creditsUsed > 0)).toBe(true);
  });

  it('a whole-date all-zero backfill persists NO rows for those dates (winner-rule fallback keeps the older real snapshot)', () => {
    // A months-long zero-filled backfill (every ai_credits_used = 0) -- the exact
    // shape GitHub returns for history beyond its retention window.
    const allZero: IngestData = {
      ...baseData,
      creditsUsedItems: [
        { date: '2026-04-01', userId: '1001', userLogin: 'user-01', creditsUsed: 0 },
        { date: '2026-05-01', userId: '1001', userLogin: 'user-01', creditsUsed: 0 },
        { date: '2026-06-01', userId: '1001', userLogin: 'user-01', creditsUsed: 0 },
        { date: '2026-04-01', userId: '1016', userLogin: 'user-16', creditsUsed: 0 },
      ],
    };
    const result = syncNow(db, 'msw', allZero);
    expect(result.creditsUsedFactCount).toBe(0);
    expect(db.select().from(creditsUsedFact).all()).toHaveLength(0);
    // The snapshot row itself still exists (append-only; a sync always records a
    // generation even when it persisted no per-user facts).
    expect(db.select().from(snapshot).all()).toHaveLength(1);
  });

  it('reports sync status derived from the latest snapshot, not a separate copy', () => {
    expect(getSyncStatus(db, 'msw').lastSyncedAt).toBeNull();

    const result = syncNow(db, 'msw', baseData);
    const status = getSyncStatus(db, 'msw');

    expect(status.inProgress).toBe(false);
    expect(status.lastSyncedAt).toBe(result.capturedAt.toISOString());
  });

  // Item 24 / CLAUDE.md §6.8 (the maintainer's mode-bleed session: live-synced
  // artifacts rendered under the sim banner): every persisted read is scoped
  // to the session's source. Both directions pinned -- a sim session never
  // reports a live sync as its own, and vice versa; the honest empty is the
  // pre-first-sync state (null), never the other mode's rows.
  it('getSyncStatus is source-scoped in BOTH directions: each mode sees only its own syncs', () => {
    // A LIVE sync lands first -- the sim view must stay pre-first-sync.
    const liveResult = syncNow(db, 'github', baseData);
    expect(getSyncStatus(db, 'msw').lastSyncedAt).toBeNull();
    expect(getSyncStatus(db, 'github').lastSyncedAt).toBe(liveResult.capturedAt.toISOString());

    // A SIM sync follows (newer snapshot id) -- the live view must keep ITS
    // OWN timestamp, not adopt the newer sim one.
    const simResult = syncNow(db, 'msw', baseData);
    expect(getSyncStatus(db, 'msw').lastSyncedAt).toBe(simResult.capturedAt.toISOString());
    expect(getSyncStatus(db, 'github').lastSyncedAt).toBe(liveResult.capturedAt.toISOString());
  });

  // The same both-direction pin for the OTHER persisted reads the UI reaches
  // (they were source-scoped in an earlier round via the snapshot join --
  // forecast rows carry no source column themselves, they inherit it from the
  // snapshot they reference): live-written rows are invisible to sim reads
  // and vice versa.
  it('getLastSyncedControls and getLatestForecast are source-scoped in BOTH directions', () => {
    syncNow(db, 'github', {
      ...baseData,
      controls: [
        { kind: 'budget', scope: 'enterprise', entityName: 'live-ent', amountCredits: 672_000, preventFurtherUsage: false, alerting: { willAlert: false, alertRecipients: [] } },
      ],
      forecasts: [enterpriseForecastItem(360_000, '2026-07-09')],
    });

    // Sim session: honest empties -- the live rows never bleed through.
    expect(getLastSyncedControls(db, 'msw')).toBeNull();
    expect(getLatestForecast(db, 'msw', 'enterprise')).toBeNull();
    // Live session sees its own rows.
    expect(getLastSyncedControls(db, 'github')?.controls[0]).toMatchObject({ entityName: 'live-ent' });
    expect(getLatestForecast(db, 'github', 'enterprise')).not.toBeNull();
  });
});

// Task 4.15: budgets + cap state ingested into snapshots on syncNow, and the
// "last synced" read path (getLastSyncedControls) the Controls screen's
// browse-time drift marker compares a fresh live read against.
describe('syncNow control ingestion (Task 4.15)', () => {
  it('persists exactly one control_snapshot row, referencing the sync generation', () => {
    const result = syncNow(db, 'msw', baseData);

    const rows = db.select().from(controlSnapshot).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snapshotId).toBe(result.snapshotId);
  });

  it('strips BudgetControl.simulatedUiHidden before persisting -- the stored record is faithful GitHub wire truth, not a simulation enrichment', () => {
    syncNow(db, 'msw', baseData);

    const row = db.select().from(controlSnapshot).all()[0]!;
    const persisted = JSON.parse(row.controlsJson) as ControlState[];
    const persistedBudget = persisted.find((c) => c.kind === 'budget') as BudgetControl;
    expect(persistedBudget).toBeDefined();
    expect('simulatedUiHidden' in persistedBudget).toBe(false);
    // Every OTHER field survives the round-trip untouched.
    expect(persistedBudget).toMatchObject({
      scope: 'individual',
      entityName: 'user-01',
      amountCredits: 6000,
      preventFurtherUsage: true,
    });

    // The in-memory input object itself is untouched (stripping produces a
    // new object; syncNow must not mutate the caller's controls array).
    const originalBudget = baseData.controls.find((c) => c.kind === 'budget') as BudgetControl;
    expect(originalBudget.simulatedUiHidden).toBe(true);
  });

  it('is append-only across two syncNow calls: one new control_snapshot row per generation, both retained', () => {
    const first = syncNow(db, 'msw', baseData);

    const secondControls: ControlState[] = [
      {
        kind: 'budget',
        scope: 'individual',
        entityName: 'user-01',
        amountCredits: 9000, // changed out-of-band relative to baseData's 6000
        preventFurtherUsage: true,
        alerting: { willAlert: true, alertRecipients: ['copilot-admins@acme.example'] },
      },
    ];
    const second = syncNow(db, 'msw', { ...baseData, controls: secondControls });

    const rows = db.select().from(controlSnapshot).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.snapshotId).sort((a, b) => a - b)).toEqual([first.snapshotId, second.snapshotId].sort((a, b) => a - b));

    // The FIRST generation's row is untouched by the second call (append,
    // never update) -- still carries the original 6000, not 9000.
    const firstRow = rows.find((r) => r.snapshotId === first.snapshotId)!;
    const firstBudget = (JSON.parse(firstRow.controlsJson) as ControlState[]).find((c) => c.kind === 'budget') as BudgetControl;
    expect(firstBudget.amountCredits).toBe(6000);
  });

  it('produces identical ingested content across two syncNow calls given identical input (determinism)', () => {
    syncNow(db, 'msw', baseData);
    const firstJson = db.select().from(controlSnapshot).all()[0]!.controlsJson;

    // Fresh DB, same input.
    const tmpDir2 = mkdtempSync(path.join(tmpdir(), 'copilot-budget-sync-determinism-'));
    try {
      const db2 = createDb(path.join(tmpDir2, 'test.sqlite'));
      runMigrations(db2);
      syncNow(db2, 'msw', baseData);
      const secondJson = db2.select().from(controlSnapshot).all()[0]!.controlsJson;
      expect(secondJson).toBe(firstJson);
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  describe('getLastSyncedControls', () => {
    it('returns null before any sync has run', () => {
      expect(getLastSyncedControls(db, 'msw')).toBeNull();
    });

    it('returns the ingested controls, matching the fixture-derived input (minus the stripped display-only field)', () => {
      syncNow(db, 'msw', baseData);
      const result = getLastSyncedControls(db, 'msw');

      expect(result).not.toBeNull();
      expect(result!.controls).toHaveLength(2);
      const cap = result!.controls.find((c): c is IncludedCapControl => c.kind === 'included_cap');
      expect(cap).toMatchObject({ costCenterName: 'Platform', enabled: true, overflow: 'block', computedLimitCredits: 105_000 });
    });

    it('returns only the LATEST generation, never an earlier one', () => {
      syncNow(db, 'msw', baseData);

      const secondControls: ControlState[] = [
        { kind: 'included_cap', costCenterName: 'Platform', enabled: false, overflow: 'metered', computedLimitCredits: 105_000 },
      ];
      const second = syncNow(db, 'msw', { ...baseData, controls: secondControls });

      const result = getLastSyncedControls(db, 'msw');
      expect(result!.capturedAt).toEqual(second.capturedAt);
      expect(result!.controls).toEqual(secondControls);
    });
  });
});

// Mode-isolation fix (CLAUDE.md §6.8): getLastSyncedControls/getLatestForecast
// previously took the max-id row across BOTH 'msw' and 'github' generations,
// so an admin who ran simulation mode and then flipped to live saw
// MSW-derived data presented as if it were live, until the first live sync
// ever completed. These tests confirm the read-side `source` filter closes
// that gap without touching the write path (no deletions, no purge, no
// migration -- `syncNow` still writes both sources into the same tables).
describe('mode isolation (source-scoped reads)', () => {
  describe('getLastSyncedControls', () => {
    it('seeding an msw generation and reading as github returns null (the pre-first-live-sync honest empty state)', () => {
      syncNow(db, 'msw', baseData);

      expect(getLastSyncedControls(db, 'github')).toBeNull();
      // The msw read is unaffected by the msw write still being present.
      expect(getLastSyncedControls(db, 'msw')).not.toBeNull();
    });

    it('seeding both sources: each mode reads only its own latest generation, never the other source\'s', () => {
      const mswControls: ControlState[] = [
        { kind: 'included_cap', costCenterName: 'Platform', enabled: true, overflow: 'block', computedLimitCredits: 105_000 },
      ];
      const githubControls: ControlState[] = [
        { kind: 'included_cap', costCenterName: 'Platform', enabled: false, overflow: 'metered', computedLimitCredits: 105_000 },
      ];
      syncNow(db, 'msw', { ...baseData, controls: mswControls });
      syncNow(db, 'github', { ...baseData, controls: githubControls });
      // A second msw generation, LATER (higher id) than the github one -- proves
      // the filter is "latest WITHIN source", not "latest overall, source-permitting".
      const laterMswControls: ControlState[] = [
        { kind: 'included_cap', costCenterName: 'Platform', enabled: true, overflow: 'metered', computedLimitCredits: 105_000 },
      ];
      syncNow(db, 'msw', { ...baseData, controls: laterMswControls });

      expect(getLastSyncedControls(db, 'msw')!.controls).toEqual(laterMswControls);
      expect(getLastSyncedControls(db, 'github')!.controls).toEqual(githubControls);
    });
  });

  describe('getLatestForecast', () => {
    it('seeding an msw generation and reading as github returns null (the pre-first-live-sync honest empty state)', () => {
      syncNow(db, 'msw', { ...baseData, forecasts: [enterpriseForecastItem(111)] });

      expect(getLatestForecast(db, 'github', 'enterprise')).toBeNull();
      expect(getLatestForecast(db, 'msw', 'enterprise')).not.toBeNull();
    });

    it('seeding both sources: each mode reads only its own latest forecast, never the other source\'s', () => {
      syncNow(db, 'msw', { ...baseData, forecasts: [enterpriseForecastItem(1)] });
      syncNow(db, 'github', { ...baseData, forecasts: [enterpriseForecastItem(2)] });
      // A later msw generation (higher id) than the github one, same as above.
      syncNow(db, 'msw', { ...baseData, forecasts: [enterpriseForecastItem(3)] });

      const mswResult = getLatestForecast(db, 'msw', 'enterprise');
      const githubResult = getLatestForecast(db, 'github', 'enterprise');
      expect(mswResult!.result.basis.runRate).toBe(3);
      expect(githubResult!.result.basis.runRate).toBe(2);
    });
  });
});

// --- Task 4.15 acceptance: "Migration applies cleanly to an existing MVP
// database (additive only)" -- mirrors writer.test.ts's Task 4.7 upgrade
// smoke test, one migration further: a database with 0000+0001 already
// applied and real MVP data (including an audit event, so the hash chain
// itself survives the upgrade untouched), then 0002_control_snapshot lands on
// top, then a sync ingests + reads back through the new table immediately. --

const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

// Shared with the 0005 upgrade test below: builds a migrations folder holding
// only the first `count` real migrations, so a test can stand up a database as
// it existed at an earlier schema generation and then land the newer
// migrations on top of real data.
function buildPartialMigrationsFolder(rootDir: string, tags: readonly string[]): string {
  const folder = path.join(rootDir, `migrations-first-${tags.length}-only`);
  mkdirSync(path.join(folder, 'meta'), { recursive: true });

  tags.forEach((tag, i) => {
    writeFileSync(path.join(folder, `${tag}.sql`), readFileSync(path.join(REAL_MIGRATIONS_FOLDER, `${tag}.sql`)));
    const snapshotName = `${String(i).padStart(4, '0')}_snapshot.json`;
    writeFileSync(path.join(folder, 'meta', snapshotName), readFileSync(path.join(REAL_MIGRATIONS_FOLDER, 'meta', snapshotName)));
  });

  const fullJournal = JSON.parse(readFileSync(path.join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  const truncatedJournal = { ...fullJournal, entries: fullJournal.entries.slice(0, tags.length) };
  writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify(truncatedJournal));

  return folder;
}

function buildMigrations0000And0001OnlyFolder(rootDir: string): string {
  return buildPartialMigrationsFolder(rootDir, ['0000_init', '0001_audit']);
}

describe('0002_control_snapshot migration -- upgrade path smoke test', () => {
  it('applies additively onto an existing MVP+audit database with real data, and syncNow ingests + reads back through the new table immediately', () => {
    const upgradeTmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-control-snapshot-upgrade-test-'));
    try {
      const upgradeDb = createDb(path.join(upgradeTmpDir, 'upgrade.sqlite'));

      // 1. Simulate the pre-existing database: only 0000+0001 applied.
      const partialFolder = buildMigrations0000And0001OnlyFolder(upgradeTmpDir);
      runMigrations(upgradeDb, partialFolder);

      // 2. Seed real pre-existing data, including a snapshot generation from
      // BEFORE this migration existed -- it must survive the upgrade untouched
      // (no control_snapshot row for it, and that's correct: it predates the
      // table).
      const preExistingSnapshot = upgradeDb
        .insert(snapshot)
        .values({ capturedAt: new Date('2026-06-01T00:00:00Z'), source: 'msw' })
        .returning()
        .get();
      upgradeDb.insert(costCenter).values({ id: 'cc-platform', name: 'Platform', state: 'active' }).run();

      // 3. Apply the new migration on top of the existing, data-populated DB.
      runMigrations(upgradeDb, REAL_MIGRATIONS_FOLDER);

      // 4. Pre-existing data survived untouched; the pre-migration snapshot
      // generation has no control_snapshot row (never had one recorded).
      expect(upgradeDb.select().from(snapshot).all()).toHaveLength(1);
      expect(upgradeDb.select().from(costCenter).all()).toHaveLength(1);
      expect(getLastSyncedControls(upgradeDb, 'msw')).toBeNull();

      // 5. The new table works immediately: a sync run post-upgrade ingests
      // and is readable straight away, referencing a NEW snapshot generation
      // (not the pre-existing one).
      const result = syncNow(upgradeDb, 'msw', baseData);
      expect(result.snapshotId).not.toBe(preExistingSnapshot.id);

      const lastSynced = getLastSyncedControls(upgradeDb, 'msw');
      expect(lastSynced).not.toBeNull();
      expect(lastSynced!.controls).toHaveLength(2);
    } finally {
      rmSync(upgradeTmpDir, { recursive: true, force: true });
    }
  });
});

// --- Distribution D2 acceptance: migration 0005_user_login applies cleanly
// on an existing database (additive only -- two nullable ADD COLUMNs). A
// database at the 0004 generation with real fact + license rows (which, by
// definition, predate the user_login columns) upgrades in place: existing
// rows read back with userLogin null, and the very next sync persists logins
// on its new rows without touching the old ones (facts are append-only; the
// license table is wholesale-replaced, so it gains logins immediately). --

describe('0005_user_login migration -- upgrade path smoke test', () => {
  it('applies additively onto an existing 0004-generation database; old rows read back with null logins, the next sync fills new rows', () => {
    const upgradeTmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-user-login-upgrade-test-'));
    try {
      const upgradeDb = createDb(path.join(upgradeTmpDir, 'upgrade.sqlite'));

      // 1. Simulate the pre-existing database: 0000..0004 applied, no 0005.
      const partialFolder = buildPartialMigrationsFolder(upgradeTmpDir, [
        '0000_init',
        '0001_audit',
        '0002_control_snapshot',
        '0003_forecast',
        '0004_app_settings',
      ]);
      runMigrations(upgradeDb, partialFolder);

      // 2. Seed pre-migration data via RAW SQL (the drizzle schema object now
      // includes user_login, so inserting through it would fail against the
      // 0004-generation table -- exactly the shape a real pre-upgrade DB has).
      upgradeDb.run(sql`INSERT INTO snapshot (id, captured_at, source) VALUES (1, 1750000000000, 'msw')`);
      upgradeDb.run(
        sql`INSERT INTO credits_used_fact (snapshot_id, date, user_id, credits_used) VALUES (1, '2026-06-01', '1001', 120.5)`,
      );
      upgradeDb.run(sql`INSERT INTO license (user_id, cost_center_id, assigned_at) VALUES ('1001', NULL, NULL)`);

      // 3. Land 0005 on top of the populated DB.
      runMigrations(upgradeDb, REAL_MIGRATIONS_FOLDER);

      // 4. Pre-existing rows survive, readable through the NEW schema, with
      // the honest null login (no backfill is possible or attempted).
      const preFacts = upgradeDb.select().from(creditsUsedFact).all();
      expect(preFacts).toHaveLength(1);
      expect(preFacts[0]).toMatchObject({ userId: '1001', userLogin: null, creditsUsed: 120.5 });
      const preLicenses = upgradeDb.select().from(license).all();
      expect(preLicenses).toHaveLength(1);
      expect(preLicenses[0]).toMatchObject({ userId: '1001', userLogin: null });

      // 5. The very next sync persists logins: its NEW fact rows carry them,
      // the pre-migration fact row stays null (append-only, never updated),
      // and the wholesale-replaced license table now carries logins.
      syncNow(upgradeDb, 'msw', baseData);
      const factRows = upgradeDb.select().from(creditsUsedFact).all();
      expect(factRows).toHaveLength(3); // 1 legacy + baseData's 2
      expect(factRows.filter((r) => r.userLogin === null)).toHaveLength(1);
      expect(factRows.find((r) => r.date === '2026-06-14' && r.userId === '1001')).toMatchObject({ userLogin: 'user-01' });
      const licenseRows = upgradeDb.select().from(license).all();
      expect(licenseRows).toHaveLength(2);
      expect(licenseRows.every((r) => r.userLogin !== null)).toBe(true);
    } finally {
      rmSync(upgradeTmpDir, { recursive: true, force: true });
    }
  });
});
