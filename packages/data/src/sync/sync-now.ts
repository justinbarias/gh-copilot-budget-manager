import { desc, eq } from 'drizzle-orm';
import type { ControlState } from '@copilot-budget/core';
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
  costCenterId: string | null;
  assignedAt: Date | null;
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
}

export interface SyncResult {
  snapshotId: number;
  capturedAt: Date;
  usageFactCount: number;
  creditsUsedFactCount: number;
  controlCount: number;
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
      tx.insert(schema.usageFact)
        .values(
          data.usageItems.map((item) => ({
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
        .run();
    }

    if (data.creditsUsedItems.length > 0) {
      tx.insert(schema.creditsUsedFact)
        .values(
          data.creditsUsedItems.map((item) => ({
            snapshotId: snapshotRow.id,
            date: item.date,
            userId: item.userId,
            creditsUsed: item.creditsUsed,
          })),
        )
        .run();
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

    return {
      snapshotId: snapshotRow.id,
      capturedAt: snapshotRow.capturedAt,
      usageFactCount: data.usageItems.length,
      creditsUsedFactCount: data.creditsUsedItems.length,
      controlCount: data.controls.length,
    };
  });
}

export function getSyncStatus(db: Db): SyncStatus {
  const latest = db.select().from(schema.snapshot).orderBy(desc(schema.snapshot.id)).limit(1).all()[0];
  return {
    lastSyncedAt: latest ? latest.capturedAt.toISOString() : null,
    inProgress: false,
  };
}

// Task 4.15: the Controls screen's "last synced" baseline for browse-time
// drift detection (packages/core's driftedControlIds). Null exactly when no
// sync has ever run -- an ungoverned/never-synced app has nothing to compare
// against, so nothing can honestly be called "drifted" yet (Controls.tsx
// treats null as "show no drift markers", never as "everything is drifted").
// INNER JOIN (not a separate lookup keyed off getSyncStatus's snapshotId) so
// this can only ever return a snapshot generation that genuinely has a
// control_snapshot row -- syncNow's transaction inserts both together, so in
// practice this is always the latest snapshot overall.
export function getLastSyncedControls(db: Db): LastSyncedControls | null {
  const latest = db
    .select({ capturedAt: schema.snapshot.capturedAt, controlsJson: schema.controlSnapshot.controlsJson })
    .from(schema.snapshot)
    .innerJoin(schema.controlSnapshot, eq(schema.controlSnapshot.snapshotId, schema.snapshot.id))
    .orderBy(desc(schema.snapshot.id))
    .limit(1)
    .all()[0];
  if (!latest) return null;
  return { capturedAt: latest.capturedAt, controls: JSON.parse(latest.controlsJson) as ControlState[] };
}
