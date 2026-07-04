import { desc } from 'drizzle-orm';
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
}

export interface SyncResult {
  snapshotId: number;
  capturedAt: Date;
  usageFactCount: number;
  creditsUsedFactCount: number;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  inProgress: boolean;
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

    return {
      snapshotId: snapshotRow.id,
      capturedAt: snapshotRow.capturedAt,
      usageFactCount: data.usageItems.length,
      creditsUsedFactCount: data.creditsUsedItems.length,
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
