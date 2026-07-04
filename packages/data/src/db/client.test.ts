import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { budget, costCenter, costCenterMember, creditsUsedFact, license, snapshot, usageFact } from './schema';
import { createDb, runMigrations, type Db } from './client';

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-db-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('schema migrations + smoke round-trip', () => {
  it('applies cleanly and allows inserting/reading a row per table', () => {
    const insertedSnapshot = db
      .insert(snapshot)
      .values({ capturedAt: new Date('2026-06-15T00:00:00.000Z'), source: 'msw' })
      .returning()
      .get();
    expect(insertedSnapshot).toBeDefined();

    const insertedCostCenter = db
      .insert(costCenter)
      .values({
        id: 'cc-1',
        name: 'Platform',
        state: 'active',
        dewrDivision: 'Digital',
        dewrBranch: 'Platform Engineering',
        dewrProject: 'Copilot Rollout',
      })
      .returning()
      .get();
    expect(insertedCostCenter).toEqual({
      id: 'cc-1',
      name: 'Platform',
      state: 'active',
      dewrDivision: 'Digital',
      dewrBranch: 'Platform Engineering',
      dewrProject: 'Copilot Rollout',
    });

    const insertedMember = db
      .insert(costCenterMember)
      .values({ costCenterId: 'cc-1', resourceType: 'user', resourceId: 'octocat' })
      .returning()
      .get();
    expect(insertedMember.resourceId).toBe('octocat');

    const insertedLicense = db
      .insert(license)
      .values({ userId: 'octocat', costCenterId: 'cc-1', assignedAt: new Date('2026-06-01T00:00:00.000Z') })
      .returning()
      .get();
    expect(insertedLicense.userId).toBe('octocat');

    const insertedUsageFact = db
      .insert(usageFact)
      .values({
        snapshotId: insertedSnapshot.id,
        date: '2026-06-15',
        entity: 'my-enterprise',
        userId: 'octocat',
        costCenterId: 'cc-1',
        model: 'claude-sonnet-5',
        netQuantity: 42,
        netAmount: 4.2,
      })
      .returning()
      .get();
    expect(insertedUsageFact.model).toBe('claude-sonnet-5');

    const insertedCreditsUsedFact = db
      .insert(creditsUsedFact)
      .values({ snapshotId: insertedSnapshot.id, date: '2026-06-15', userId: 'octocat', creditsUsed: 12.5 })
      .returning()
      .get();
    expect(insertedCreditsUsedFact.creditsUsed).toBe(12.5);

    const insertedBudget = db
      .insert(budget)
      .values({
        id: 'budget-1',
        budgetType: 'BundlePricing',
        budgetProductSku: 'ai_credits',
        budgetScope: 'multi_user_cost_center',
        budgetEntityName: 'Platform',
        budgetAmount: 500,
        preventFurtherUsage: true,
        willAlert: true,
        alertRecipients: JSON.stringify(['admin@example.com']),
      })
      .returning()
      .get();
    expect(insertedBudget.preventFurtherUsage).toBe(true);

    // Read every table back to confirm the migration produced real, queryable tables — not just insert-shaped stubs.
    expect(db.select().from(snapshot).all()).toHaveLength(1);
    expect(db.select().from(costCenter).all()).toHaveLength(1);
    expect(db.select().from(costCenterMember).all()).toHaveLength(1);
    expect(db.select().from(license).all()).toHaveLength(1);
    expect(db.select().from(usageFact).all()).toHaveLength(1);
    expect(db.select().from(creditsUsedFact).all()).toHaveLength(1);
    expect(db.select().from(budget).all()).toHaveLength(1);
  });

  it('is a fresh, empty database before any insert', () => {
    expect(db.select().from(snapshot).all()).toEqual([]);
  });
});
