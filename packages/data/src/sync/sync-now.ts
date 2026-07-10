import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ControlState, ForecastResult } from '@copilot-budget/core';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';

export interface IngestUsageItem {
  date: string;
  costCenterId: string | null;
  userLogin: string | null;
  sku: string;
  quantity: number;
  netAmountUsd: number;
}

export interface IngestCreditsUsedItem {
  date: string;
  userId: string;
  /**
   * Distribution D2 (migration 0005): the login the R6 users report carries
   * alongside `user_id` (users-report.ts's UsersReportRecord). Required here
   * -- the wire source always has it -- while the COLUMN stays nullable only
   * for rows persisted before the migration existed.
   */
  userLogin: string;
  creditsUsed: number;
}

export interface IngestCostCenter {
  id: string;
  name: string;
  state: 'active' | 'archived';
}

export type IngestResourceType = 'user' | 'org' | 'repository' | 'enterprise_team';

export interface IngestCostCenterMember {
  costCenterId: string;
  resourceType: IngestResourceType;
  resourceId: string;
}

export interface IngestLicense {
  userId: string;
  /**
   * Distribution D2 (migration 0005): the seat's `assignee.login`. Required
   * here -- the seats listing always carries it -- while the COLUMN stays
   * nullable only for rows persisted before the migration existed (the table
   * is wholesale-replaced every sync, so one post-migration sync fills it).
   */
  userLogin: string;
  costCenterId: string | null;
  assignedAt: Date | null;
}

/** Task 5.4: 'enterprise' has no entity (entityRef null); 'cost_center'/'user' are keyed by that entity's id. */
export type ForecastScope = 'enterprise' | 'cost_center' | 'user';

export interface IngestForecastItem {
  scope: ForecastScope;
  /** Null for 'enterprise'; a cost-center id for 'cost_center'; a user id (matching credits_used_fact.userId) for 'user'. */
  entityId: string | null;
  /** The sync's as-of date (SIM_CURRENT_DATE convention -- never wall-clock), ISO 'YYYY-MM-DD'. */
  computedAt: string;
  result: ForecastResult;
  /** From core's backtest(); null wherever historical depth was insufficient (packages/data/src/forecast/compute.ts). */
  mape: number | null;
}

export interface IngestData {
  entity: string;
  usageItems: IngestUsageItem[];
  creditsUsedItems: IngestCreditsUsedItem[];
  costCenters: IngestCostCenter[];
  costCenterMembers: IngestCostCenterMember[];
  licenses: IngestLicense[];
  /**
   * Task 4.15: the SAME live-control projection getControls()/the write
   * engine's re-read use (write/live-state.ts's fetchLiveControls), captured
   * once per sync and persisted append-only (schema.ts's control_snapshot)
   * as the "last synced" baseline the Controls screen's browse-time drift
   * marker compares a fresh live read against.
   */
  controls: ControlState[];
  /**
   * Task 5.4: one forecast per (scope, entity) -- enterprise, every active
   * cost center, every licensed user -- computed by the caller (github-impl.ts,
   * via packages/data/src/forecast/compute.ts) from the SAME sync's fetched
   * usage rows, and persisted append-only (schema.ts's `forecast` table)
   * alongside the snapshot/control rows it derives from (FR18 "forecast basis").
   */
  forecasts: IngestForecastItem[];
}

export interface SyncResult {
  snapshotId: number;
  capturedAt: Date;
  usageFactCount: number;
  creditsUsedFactCount: number;
  controlCount: number;
  forecastCount: number;
}

/** Task 5.4: `getLatestForecast`'s return shape -- the latest persisted forecast for a (scope, entity). */
export interface StoredForecast {
  snapshotId: number;
  scope: ForecastScope;
  entityId: string | null;
  computedAt: string;
  mape: number | null;
  result: ForecastResult;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  inProgress: boolean;
}

/** `getLastSyncedControls`'s return shape -- the "last synced" baseline `driftedControlIds` (packages/core) compares a fresh `getControls()` read against. */
export interface LastSyncedControls {
  capturedAt: Date;
  controls: ControlState[];
}

// Task 4.15: `BudgetControl.simulatedUiHidden` is a simulation-only display
// enrichment (see that field's doc comment in packages/core/src/controls.ts)
// -- a real GitHub budget response never carries it. control_snapshot is
// meant to be a faithful append-only record of GitHub wire truth (the same
// standard budget/cost_center/etc. hold), so it's stripped before
// serializing rather than persisted. Reconstructs the object field-by-field
// (rather than destructure-and-omit) so the shape this function returns can
// never silently gain a stray field later just by adding one to
// BudgetControl and forgetting this function exists.
function stripDisplayOnlyFields(control: ControlState): ControlState {
  if (control.kind !== 'budget') return control;
  const { scope, entityName, amountCredits, preventFurtherUsage, alerting } = control;
  return { kind: 'budget', scope, entityName, amountCredits, preventFurtherUsage, alerting };
}

// A single multi-row INSERT binds one parameter per column per row, so a large
// batch can exceed SQLite's SQLITE_MAX_VARIABLE_NUMBER (32,766) and throw "too
// many SQL variables". The daily-grain fact tables can now carry thousands of
// rows per sync (e.g. the long-tail scenario's full-roster Mar/Apr/May
// backfill), so their inserts are chunked. 500 rows keeps even a wide fact row
// far under the cap while staying inside the one transaction.
const INSERT_CHUNK_ROWS = 500;
function chunked<T>(rows: readonly T[], run: (chunk: T[]) => void): void {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_ROWS) {
    run(rows.slice(i, i + INSERT_CHUNK_ROWS));
  }
}

// Facts (usage_fact/credits_used_fact) are snapshot-scoped and append a new
// generation every call (CLAUDE.md §6: append-only). Dimensions (cost_center,
// cost_center_member, license) have no snapshotId column in the Task 1.2
// schema, so they're synced as current state instead: cost_center is upserted
// by its natural PK, and cost_center_member/license (no natural unique key)
// are replaced wholesale. Naively re-inserting dimensions on every call would
// either violate cost_center's PK or silently duplicate members/licenses.
export function syncNow(db: Db, source: 'msw' | 'github', data: IngestData): SyncResult {
  return db.transaction((tx) => {
    const snapshotRow = tx.insert(schema.snapshot).values({ capturedAt: new Date(), source }).returning().get();

    for (const cc of data.costCenters) {
      tx.insert(schema.costCenter)
        .values({ id: cc.id, name: cc.name, state: cc.state })
        .onConflictDoUpdate({ target: schema.costCenter.id, set: { name: cc.name, state: cc.state } })
        .run();
    }

    tx.delete(schema.costCenterMember).run();
    if (data.costCenterMembers.length > 0) {
      tx.insert(schema.costCenterMember).values(data.costCenterMembers).run();
    }

    tx.delete(schema.license).run();
    if (data.licenses.length > 0) {
      tx.insert(schema.license).values(data.licenses).run();
    }

    if (data.usageItems.length > 0) {
      chunked(data.usageItems, (chunk) =>
        tx
          .insert(schema.usageFact)
          .values(
            chunk.map((item) => ({
              snapshotId: snapshotRow.id,
              date: item.date,
              entity: data.entity,
              userId: item.userLogin,
              costCenterId: item.costCenterId,
              model: item.sku,
              netQuantity: item.quantity,
              netAmount: item.netAmountUsd,
            })),
          )
          .run(),
      );
    }

    if (data.creditsUsedItems.length > 0) {
      chunked(data.creditsUsedItems, (chunk) =>
        tx
          .insert(schema.creditsUsedFact)
          .values(
            chunk.map((item) => ({
              snapshotId: snapshotRow.id,
              date: item.date,
              userId: item.userId,
              userLogin: item.userLogin,
              creditsUsed: item.creditsUsed,
            })),
          )
          .run(),
      );
    }

    // Task 4.15: one control_snapshot row per generation, always inserted
    // (even when `data.controls` is empty) -- append-only, same convention as
    // usage_fact/credits_used_fact above, never conditioned on there being
    // "something new" to record. simulatedUiHidden is stripped so the
    // persisted historical record stays a faithful mirror of GitHub wire
    // truth (see stripDisplayOnlyFields).
    tx.insert(schema.controlSnapshot)
      .values({
        snapshotId: snapshotRow.id,
        controlsJson: JSON.stringify(data.controls.map(stripDisplayOnlyFields)),
      })
      .run();

    // Task 5.4: one forecast row per (scope, entity), in the SAME transaction
    // as the snapshot/control writes above -- append-only, same convention
    // (never conditioned on "something changed"; every row references this
    // generation's snapshotId, the FR18 "forecast basis").
    if (data.forecasts.length > 0) {
      tx.insert(schema.forecast)
        .values(
          data.forecasts.map((f) => ({
            snapshotId: snapshotRow.id,
            scope: f.scope,
            entityRef: f.entityId,
            computedAt: f.computedAt,
            forecastJson: JSON.stringify(f.result),
            mape: f.mape,
          })),
        )
        .run();
    }

    return {
      snapshotId: snapshotRow.id,
      capturedAt: snapshotRow.capturedAt,
      usageFactCount: data.usageItems.length,
      creditsUsedFactCount: data.creditsUsedItems.length,
      controlCount: data.controls.length,
      forecastCount: data.forecasts.length,
    };
  });
}

// Mode-scoped (item 24 / CLAUDE.md §6.8, folding docs/pending/todo.md's
// deferred "getSyncStatus mode-blindness" item -- the same source-scoping
// discipline getLastSyncedControls/getLatestForecast/latestSnapshotId already
// apply): a simulation session's "Last synced" must describe the last SIM
// sync, never a live one performed earlier into the same (mixed-mode, by
// design unpurged) database -- and vice versa. A session whose own source has
// never synced honestly reports the pre-first-sync state (lastSyncedAt null),
// never the other mode's timestamp.
export function getSyncStatus(db: Db, source: 'msw' | 'github'): SyncStatus {
  const latest = db
    .select()
    .from(schema.snapshot)
    .where(eq(schema.snapshot.source, source))
    .orderBy(desc(schema.snapshot.id))
    .limit(1)
    .all()[0];
  return {
    lastSyncedAt: latest ? latest.capturedAt.toISOString() : null,
    inProgress: false,
  };
}

// Task 4.15: the Controls screen's "last synced" baseline for browse-time
// drift detection (packages/core's driftedControlIds). Null exactly when no
// sync of THIS source has ever run -- an ungoverned/never-synced-in-this-mode
// app has nothing to compare against, so nothing can honestly be called
// "drifted" yet (Controls.tsx treats null as "show no drift markers", never
// as "everything is drifted").
//
// `source` is required (mode-isolation fix, CLAUDE.md §6.8): without it this
// query took the max-id row across BOTH 'msw' and 'github' generations, so an
// admin who ran simulation mode and then flipped to live saw an MSW-derived
// drift baseline presented as if it were live data, until the first live
// sync ever completed. Callers pass the SAME 'msw' | 'github' flag
// github-impl.ts's clock seam (resolveClockDate) already keys off
// (GitHubApiClientConfig.source) -- not a second mode flag.
//
// INNER JOIN (not a separate lookup keyed off getSyncStatus's snapshotId) so
// this can only ever return a snapshot generation that genuinely has a
// control_snapshot row -- syncNow's transaction inserts both together, so in
// practice this is always the latest snapshot of that source.
export function getLastSyncedControls(db: Db, source: 'msw' | 'github'): LastSyncedControls | null {
  const latest = db
    .select({ capturedAt: schema.snapshot.capturedAt, controlsJson: schema.controlSnapshot.controlsJson })
    .from(schema.snapshot)
    .innerJoin(schema.controlSnapshot, eq(schema.controlSnapshot.snapshotId, schema.snapshot.id))
    .where(eq(schema.snapshot.source, source))
    .orderBy(desc(schema.snapshot.id))
    .limit(1)
    .all()[0];
  if (!latest) return null;
  return { capturedAt: latest.capturedAt, controls: JSON.parse(latest.controlsJson) as ControlState[] };
}

// Task 5.4: the Forecast screen's (and Overview/Users' forecast overlays,
// Phase 5's later tasks) read surface -- the latest persisted forecast for
// one (scope, entity) OF THIS SOURCE, regardless of which snapshot generation
// produced it (a forecast is recomputed every sync, but a caller asking
// "what's the current forecast for cost center X" wants the newest one for
// its own mode, not necessarily tied to the newest snapshot's OTHER rows).
// `entityId` omitted/undefined selects the row with a NULL entity_ref (the
// 'enterprise' scope's only shape); passing it for 'enterprise' would simply
// match nothing (its rows never carry a non-null entityRef), returning null
// -- not a footgun in practice since ForecastScope callers only ever pass
// entityId for 'cost_center'/'user'. Null exactly when this (scope, entity)
// has never been computed FOR THIS SOURCE -- in practice, pre-sync, or (mode-
// isolation fix, CLAUDE.md §6.8) live mode before the first live sync ever
// completes, even if simulation mode has run many times. Without the
// `source` filter this took the max-id forecast row across BOTH 'msw' and
// 'github' generations, so a live admin with only simulation history would
// see an MSW-derived forecast rendered as if it were live. `source` is the
// SAME 'msw' | 'github' flag github-impl.ts's clock seam (resolveClockDate)
// already keys off (GitHubApiClientConfig.source) -- not a second mode flag.
// An inner join against `snapshot` (rather than a `source` column on
// `forecast` itself) keeps this filter keyed off the one place source
// already lives, matching getLastSyncedControls's join above.
export function getLatestForecast(
  db: Db,
  source: 'msw' | 'github',
  scope: ForecastScope,
  entityId?: string,
): StoredForecast | null {
  const scopeCondition =
    entityId !== undefined
      ? and(eq(schema.forecast.scope, scope), eq(schema.forecast.entityRef, entityId))
      : and(eq(schema.forecast.scope, scope), isNull(schema.forecast.entityRef));

  const row = db
    .select({
      snapshotId: schema.forecast.snapshotId,
      scope: schema.forecast.scope,
      entityRef: schema.forecast.entityRef,
      computedAt: schema.forecast.computedAt,
      forecastJson: schema.forecast.forecastJson,
      mape: schema.forecast.mape,
    })
    .from(schema.forecast)
    .innerJoin(schema.snapshot, eq(schema.snapshot.id, schema.forecast.snapshotId))
    .where(and(scopeCondition, eq(schema.snapshot.source, source)))
    .orderBy(desc(schema.forecast.id))
    .limit(1)
    .all()[0];
  if (!row) return null;

  return {
    snapshotId: row.snapshotId,
    scope: row.scope as ForecastScope,
    entityId: row.entityRef,
    computedAt: row.computedAt,
    mape: row.mape,
    result: JSON.parse(row.forecastJson) as ForecastResult,
  };
}
