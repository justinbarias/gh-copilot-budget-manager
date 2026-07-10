import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_CHAIN_GENESIS_PREV_HASH } from '@copilot-budget/core';
import { costCenter, snapshot } from '../db/schema.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { appendAuditEvent, readAuditChain, verifyStoredChain, type AppendAuditEventInput } from './writer.js';
import * as writerModule from './writer.js';

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-audit-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseInput: AppendAuditEventInput = {
  ts: new Date('2026-06-15T00:00:00.000Z'),
  actor: 'admin@example.com',
  action: 'budget.create',
  entityRef: 'budget:universal:acme-enterprise',
  trigger: 'manual',
  source: 'msw',
  before: null,
  after: { amountCredits: 4000, preventFurtherUsage: true },
  justification: null,
  dataSnapshotId: null,
};

describe('appendAuditEvent', () => {
  it('exposes no update/delete surface -- only append + read-only verification helpers', () => {
    // Locks the module's runtime export surface: if anyone ever adds an
    // `updateAuditEvent`/`deleteAuditEvent` export, this test fails,
    // catching the regression against CLAUDE.md §6.5's append-only invariant
    // at review time rather than relying on convention alone. (Type-only
    // exports -- AuditSource, AppendAuditEventInput, etc. -- are erased at
    // runtime and never appear here; only functions do.) The read/verify
    // helpers grew with migration 0006's per-source chains
    // (readScopedAuditChain, verifyAllSegments) but remain strictly read-only.
    expect(Object.keys(writerModule).sort()).toEqual([
      'appendAuditEvent',
      'readAuditChain',
      'readScopedAuditChain',
      'verifyAllSegments',
      'verifyStoredChain',
    ]);
  });

  it('chains the first event to the genesis sentinel', () => {
    const row = appendAuditEvent(db, baseInput);
    expect(row.prevHash).toBe(AUDIT_CHAIN_GENESIS_PREV_HASH);
    expect(row.hash).toEqual(expect.any(String));
    expect(row.hash).not.toBe(AUDIT_CHAIN_GENESIS_PREV_HASH);
  });

  it('serializes JSON-valued fields and nulls through correctly', () => {
    const row = appendAuditEvent(db, baseInput);
    expect(JSON.parse(row.after!)).toEqual({ amountCredits: 4000, preventFurtherUsage: true });
    expect(row.before).toBeNull();
    expect(row.envelopeSnapshot).toBeNull();
    expect(row.justification).toBeNull();
    expect(row.dataSnapshotId).toBeNull();
  });

  it('links each subsequent event to the previous event\'s hash', () => {
    const first = appendAuditEvent(db, baseInput);
    const second = appendAuditEvent(db, {
      ...baseInput,
      action: 'budget.update',
      before: { amountCredits: 4000 },
      after: { amountCredits: 5000 },
    });
    const third = appendAuditEvent(db, {
      ...baseInput,
      action: 'budget.delete',
      before: { amountCredits: 5000 },
      after: null,
    });

    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    // Distinct payloads (different action/before/after) must produce distinct hashes.
    expect(new Set([first.hash, second.hash, third.hash]).size).toBe(3);
  });

  it('readAuditChain returns rows in append (ascending id) order', () => {
    appendAuditEvent(db, { ...baseInput, action: 'budget.create' });
    appendAuditEvent(db, { ...baseInput, action: 'budget.update' });
    appendAuditEvent(db, { ...baseInput, action: 'budget.delete' });

    const rows = readAuditChain(db);
    expect(rows.map((r) => r.action)).toEqual(['budget.create', 'budget.update', 'budget.delete']);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
  });
});

describe('verifyStoredChain (round-trip: write -> read -> verify with the real SHA-256 primitive)', () => {
  it('verifies a clean multi-event chain written through appendAuditEvent', () => {
    appendAuditEvent(db, baseInput);
    appendAuditEvent(db, {
      ...baseInput,
      actor: 'system:pool-rebalancer',
      action: 'included_cap.update',
      trigger: 'pool_rebalancer',
      envelopeSnapshot: { envelopeCredits: 1200, bindingConstraint: 'included_cap' },
      before: { enabled: true, overflow: 'block' },
      after: { enabled: true, overflow: 'metered' },
    });
    appendAuditEvent(db, { ...baseInput, action: 'budget.delete', before: { amountCredits: 4000 }, after: null });

    expect(verifyStoredChain(db)).toEqual({ ok: true });
  });

  it('detects a directly-tampered row (bypassing the writer) at the tampered event\'s index', () => {
    appendAuditEvent(db, baseInput);
    const middle = appendAuditEvent(db, { ...baseInput, action: 'budget.update' });
    appendAuditEvent(db, { ...baseInput, action: 'budget.delete' });

    // Simulates an out-of-band tamper: directly mutate a stored column,
    // bypassing appendAuditEvent entirely (proving verification -- not just
    // the writer's own discipline -- is what catches this).
    db.update(schema.auditEvent).set({ actor: 'forged-actor' }).where(eq(schema.auditEvent.id, middle.id)).run();

    const result = verifyStoredChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(1);
  });
});

// --- Task 4.7 acceptance: "Migration applies cleanly to an existing MVP
// database (additive only)". Simulates a real upgrade: a database that has
// ONLY migration 0000 applied and already contains real MVP data, then
// migration 0001 is applied on top, then an audit event referencing that
// pre-existing data is written and read back. -----------------------------

const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

// Builds a migrations folder containing ONLY the 0000 entry, by copying the
// real 0000 files and a journal truncated to one entry -- exercising
// drizzle's real migration-tracking table (`__drizzle_migrations`) across
// two separate `runMigrations` calls, exactly as a real app upgrade would.
function buildMigrations0000OnlyFolder(rootDir: string): string {
  const folder = path.join(rootDir, 'migrations-0000-only');
  mkdirSync(path.join(folder, 'meta'), { recursive: true });

  writeFileSync(
    path.join(folder, '0000_init.sql'),
    readFileSync(path.join(REAL_MIGRATIONS_FOLDER, '0000_init.sql')),
  );
  writeFileSync(
    path.join(folder, 'meta', '0000_snapshot.json'),
    readFileSync(path.join(REAL_MIGRATIONS_FOLDER, 'meta', '0000_snapshot.json')),
  );

  const fullJournal = JSON.parse(readFileSync(path.join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const truncatedJournal = { ...fullJournal, entries: fullJournal.entries.slice(0, 1) };
  writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify(truncatedJournal));

  return folder;
}

describe('0001_audit migration -- upgrade path smoke test', () => {
  it('applies additively onto an existing MVP database with real data, and the new audit table works immediately', () => {
    const upgradeTmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-audit-upgrade-test-'));
    try {
      const upgradeDb = createDb(path.join(upgradeTmpDir, 'upgrade.sqlite'));

      // 1. Simulate the pre-existing MVP database: only 0000 applied.
      const partialFolder = buildMigrations0000OnlyFolder(upgradeTmpDir);
      runMigrations(upgradeDb, partialFolder);

      // 2. Seed real MVP data (as an existing user's database would already have).
      const seededSnapshot = upgradeDb
        .insert(snapshot)
        .values({ capturedAt: new Date('2026-06-01T00:00:00.000Z'), source: 'msw' })
        .returning()
        .get();
      upgradeDb.insert(costCenter).values({ id: 'cc-platform', name: 'Platform', state: 'active' }).run();

      // 3. Apply the new migration on top of the existing, data-populated DB.
      runMigrations(upgradeDb, REAL_MIGRATIONS_FOLDER);

      // 4. Pre-existing MVP data survived untouched.
      expect(upgradeDb.select().from(snapshot).all()).toEqual([seededSnapshot]);
      expect(upgradeDb.select().from(costCenter).all()).toHaveLength(1);

      // 5. The new audit_event table works immediately, including its FK to
      // the pre-existing snapshot row.
      const auditRow = appendAuditEvent(upgradeDb, {
        ts: new Date('2026-06-15T00:00:00.000Z'),
        actor: 'admin@example.com',
        action: 'budget.create',
        entityRef: 'budget:universal:acme-enterprise',
        trigger: 'manual',
        source: 'msw',
        after: { amountCredits: 4000 },
        dataSnapshotId: seededSnapshot.id,
      });

      expect(auditRow.prevHash).toBe(AUDIT_CHAIN_GENESIS_PREV_HASH);
      expect(auditRow.dataSnapshotId).toBe(seededSnapshot.id);

      const rows = readAuditChain(upgradeDb);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(auditRow);
      expect(verifyStoredChain(upgradeDb)).toEqual({ ok: true });
    } finally {
      rmSync(upgradeTmpDir, { recursive: true, force: true });
    }
  });
});
