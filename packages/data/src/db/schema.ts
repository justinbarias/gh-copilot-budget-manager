import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

// Task 4.15: one row per `syncNow` ingestion, holding the FULL live-control
// projection (core's ControlState[] -- BudgetControl/IncludedCapControl/
// CostCenterControl) as of that sync. This is the "last synced" reference
// the Controls screen compares a fresh live read against to surface
// out-of-band drift ("⤺ drift — reconcile"); append-only sibling of
// usage_fact/credits_used_fact (CLAUDE.md §6: never updated/deleted, one row
// inserted per sync, scoped by snapshotId).
//
// A single JSON column, not per-field columns, because ControlState is a
// discriminated union of three structurally different shapes -- the same
// "serialize the whole domain object" precedent audit_event already
// establishes (envelopeSnapshot/before/after below). This also keeps the
// table schema-stable as ControlState itself grows fields/kinds across
// Phases 5-7, with no migration required each time.
//
// Considered and rejected: populating the existing `budget` table (its
// single-string `id` primary key has no snapshotId column, so making it
// append-only per generation would mean recreating the table -- not
// additive); a bare column added directly to `snapshot` (rejected only to
// keep `snapshot` a pure ingestion-run marker, matching its own doc comment,
// rather than overloading every snapshot row with a payload every reader of
// that table -- e.g. getSyncStatus's latest-row lookup -- doesn't need).
// `snapshotId` is unique: syncNow inserts exactly one control_snapshot row
// per generation, never zero, never more than one.
export const controlSnapshot = sqliteTable('control_snapshot', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  snapshotId: integer('snapshot_id')
    .notNull()
    .unique()
    .references(() => snapshot.id),
  controlsJson: text('controls_json').notNull(),
});

// Task 5.4: one row per (snapshot generation x scope x entity) forecast
// computed at the end of `syncNow` -- append-only sibling of control_snapshot
// above (never updated/deleted; a fresh generation is inserted every sync
// that computes one). `scope` is 'enterprise' | 'cost_center' | 'user'
// (packages/data/src/api-client/types.ts's ForecastScope); `entityRef` is
// null for the enterprise scope, a cost-center id for 'cost_center', a user
// id for 'user'. `forecastJson` is core's ForecastResult serialized verbatim
// (dailySeries + exhaustionDate(s) + runwayDays + projectedMetered{Credits,
// Dollars} + basis) -- a single JSON column for the same reason
// control_snapshot uses one: the shape is a nested domain object, not a flat
// row, and keeping it schema-stable means no migration is required as
// ForecastResult itself grows fields. `mape` (from core's backtest()) is
// nullable -- null wherever the entity's historical depth was insufficient
// to backtest (packages/data/src/forecast/compute.ts's window-picking logic).
// `computedAt` is the sync's as-of date (SIM_CURRENT_DATE convention --
// never wall-clock), stored as the same ISO 'YYYY-MM-DD' text every other
// as-of-date field in this codebase uses (never an integer timestamp column).
// The (snapshot_id, scope, entity_ref) index backs `getLatestForecast`'s
// per-scope/entity latest-row lookup (packages/data/src/sync/sync-now.ts).
export const forecast = sqliteTable(
  'forecast',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => snapshot.id),
    scope: text('scope').notNull(),
    entityRef: text('entity_ref'),
    computedAt: text('computed_at').notNull(),
    forecastJson: text('forecast_json').notNull(),
    mape: real('mape'),
  },
  (table) => [index('forecast_snapshot_id_scope_entity_ref_idx').on(table.snapshotId, table.scope, table.entityRef)],
);

// Append-only, hash-chained audit log (CLAUDE.md §6.5 / PLAN.md Task 4.7).
// No code path in this package updates or deletes a row here -- the only
// writer is packages/data/src/audit/writer.ts's `appendAuditEvent`, and that
// module exports no update/delete function. Every apply (manual writes from
// Phase 4 onward; rebalancer applies from Phase 7) records exactly one row
// per changed control, chained via prevHash/hash (packages/core's
// `computeEventHash`/`verifyAuditChain`, packages/core/src/auditChain.ts).
export const auditEvent = sqliteTable('audit_event', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityRef: text('entity_ref').notNull(),
  trigger: text('trigger').notNull(),
  // JSON-encoded string, or null. Null for a Phase-4 manual apply (there is
  // no rebalancer envelope to record); populated by Phase 6/7 rebalancer
  // applies with the envelope size, forecast basis, and -- pending
  // Checkpoint 4a ratification (see the Task 4.7 migration review packet) --
  // the per-entity binding constraint, since this table has no dedicated
  // binding_constraint column.
  envelopeSnapshot: text('envelope_snapshot'),
  // JSON-encoded string, or null for an 'add' with no prior state.
  before: text('before'),
  // JSON-encoded string, or null for a 'delete' with no resulting state.
  after: text('after'),
  justification: text('justification'),
  dataSnapshotId: integer('data_snapshot_id').references(() => snapshot.id),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

// Task 9.3-lite (2026-07-09, maintainer-approved additive migration 0004):
// app-local key-value settings. First key: 'app_mode' ('simulation' | 'live')
// -- the persisted in-app mode toggle that RETIRES the
// COPILOT_BUDGET_FORCE_SIMULATION env-var seam. Deliberately generic (a KV
// table, not a mode column) so future app-local settings need no further
// migrations. NOTE: the live-write ARMED state is NOT stored here -- it is
// main-process memory only, by design (relaunch disarms).
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
