import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Ingestion-run marker. Append-only (CLAUDE.md §6): rows are never updated or deleted,
// only inserted by "Sync now"; usage_fact/credits_used_fact rows reference the run that produced them.
export const snapshot = sqliteTable('snapshot', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull(),
  source: text('source').notNull(), // 'msw' | 'github'
});

export const costCenter = sqliteTable('cost_center', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  state: text('state').notNull(), // 'active' | 'archived'
  dewrDivision: text('dewr_division'),
  dewrBranch: text('dewr_branch'),
  dewrProject: text('dewr_project'),
});

export const costCenterMember = sqliteTable('cost_center_member', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  costCenterId: text('cost_center_id')
    .notNull()
    .references(() => costCenter.id),
  resourceType: text('resource_type').notNull(), // 'user' | 'org' | 'repository' | 'enterprise_team'
  resourceId: text('resource_id').notNull(),
});

export const license = sqliteTable('license', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  costCenterId: text('cost_center_id').references(() => costCenter.id),
  assignedAt: integer('assigned_at', { mode: 'timestamp_ms' }),
});

export const usageFact = sqliteTable('usage_fact', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  snapshotId: integer('snapshot_id')
    .notNull()
    .references(() => snapshot.id),
  date: text('date').notNull(), // YYYY-MM-DD
  entity: text('entity').notNull(),
  userId: text('user_id'),
  costCenterId: text('cost_center_id').references(() => costCenter.id),
  model: text('model').notNull(),
  netQuantity: real('net_quantity').notNull(),
  netAmount: real('net_amount').notNull(),
});

// Per-user daily total (Copilot usage metrics API's ai_credits_used), distinct grain from usage_fact's per-model rows.
export const creditsUsedFact = sqliteTable('credits_used_fact', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  snapshotId: integer('snapshot_id')
    .notNull()
    .references(() => snapshot.id),
  date: text('date').notNull(),
  userId: text('user_id').notNull(),
  creditsUsed: real('credits_used').notNull(),
});

// Read-only mirror of GitHub's budget object (PRD §2.1). No write path in MVP.
export const budget = sqliteTable('budget', {
  id: text('id').primaryKey(),
  budgetType: text('budget_type').notNull(), // 'ProductPricing' | 'SkuPricing' | 'BundlePricing'
  budgetProductSku: text('budget_product_sku').notNull(),
  budgetScope: text('budget_scope').notNull(),
  budgetEntityName: text('budget_entity_name').notNull(),
  budgetAmount: real('budget_amount').notNull(),
  preventFurtherUsage: integer('prevent_further_usage', { mode: 'boolean' }).notNull(),
  willAlert: integer('will_alert', { mode: 'boolean' }),
  alertRecipients: text('alert_recipients'), // JSON-encoded string[]
});
