import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costCenter, costCenterMember, creditsUsedFact, license, snapshot, usageFact } from '../db/schema.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { getSyncStatus, syncNow, type IngestData } from './sync-now.js';

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
    { date: '2026-06-14', userId: '1001', creditsUsed: 420 },
    { date: '2026-06-14', userId: '1016', creditsUsed: 310 },
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
    { userId: '1001', costCenterId: 'cc-platform', assignedAt: new Date('2026-06-01T00:00:00Z') },
    { userId: '1016', costCenterId: 'cc-data-analytics', assignedAt: new Date('2026-06-01T00:00:00Z') },
  ],
};

describe('syncNow', () => {
  it('ingests a fresh DB with exactly the fixture data on one call', () => {
    const result = syncNow(db, 'msw', baseData);

    expect(result.usageFactCount).toBe(2);
    expect(result.creditsUsedFactCount).toBe(2);

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

  it('produces two distinct snapshot generations across two calls, without duplicating dimension rows', () => {
    const first = syncNow(db, 'msw', baseData);

    const secondUsage: IngestData = {
      ...baseData,
      usageItems: [
        { date: '2026-06-15', costCenterId: 'cc-platform', userLogin: 'user-01', sku: 'ai_credits', quantity: 50, netAmountUsd: 0 },
      ],
      creditsUsedItems: [{ date: '2026-06-15', userId: '1001', creditsUsed: 50 }],
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

  it('reports sync status derived from the latest snapshot, not a separate copy', () => {
    expect(getSyncStatus(db).lastSyncedAt).toBeNull();

    const result = syncNow(db, 'msw', baseData);
    const status = getSyncStatus(db);

    expect(status.inProgress).toBe(false);
    expect(status.lastSyncedAt).toBe(result.capturedAt.toISOString());
  });
});
