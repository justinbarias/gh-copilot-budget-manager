import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain, type StoredAuditEvent } from '@copilot-budget/core';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { appendAuditEvent, readAuditChain, verifyStoredChain, type AppendAuditEventInput } from './writer.js';
import { auditChainToCsv, auditChainToJson, toExportedAuditEvent, type ExportedAuditEvent } from './export.js';

// Task 8.5's data-side tests (CLAUDE.md §6.5's government/compliance
// deliverable): the tamper case (payload corruption AND hash corruption, each
// pinpointed to the exact tampered event's index) and the export round-trip
// (a JSON export is independently re-verifiable offline via packages/core's
// own verifier, with zero help from this package) -- plus CSV field/row
// coverage. Mirrors writer.test.ts's db-setup convention exactly (createDb +
// runMigrations against a throwaway tmp sqlite file per test).

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-audit-export-test-'));
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

// The SAME hash primitive convention writer.ts's own (internal, non-exported)
// sha256Hex uses -- built fresh here via node:crypto directly, so the
// round-trip tests below prove the export doesn't secretly rely on this
// package's own hashing closure for its "independently re-verifiable
// offline" claim.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function seedThreeEventChain(): void {
  appendAuditEvent(db, baseInput);
  appendAuditEvent(db, {
    ...baseInput,
    action: 'budget.update',
    entityRef: 'budget:cost_center:Workforce Australia Platform',
    before: { amountCredits: 60_000 },
    after: { amountCredits: 65_000 },
    justification: 'e2e: raise Workforce metered cap for Q1 crunch',
  });
  appendAuditEvent(db, {
    ...baseInput,
    action: 'cost_center.membership',
    entityRef: 'cost_center:Platform',
    trigger: 'manual',
    before: { members: ['a'] },
    after: { members: ['a', 'b'] },
  });
}

// --- Tamper case: payload corruption AND hash corruption, each pinpointed --

describe('tamper detection (via verifyStoredChain, the exact surface the Audit screen\'s "Verify chain" action calls)', () => {
  it('reports fail at exactly the tampered index when a PAYLOAD field is corrupted out-of-band', () => {
    seedThreeEventChain();
    const rows = readAuditChain(db);
    expect(rows).toHaveLength(3);
    const middle = rows[1]!;

    // Bypasses appendAuditEvent entirely -- a direct column mutation, exactly
    // like writer.test.ts's own tamper test, but here corrupting the AFTER
    // payload rather than the actor, to prove the money-affecting field
    // (before/after) is covered too.
    db.update(schema.auditEvent)
      .set({ after: JSON.stringify({ amountCredits: 999_999 }) })
      .where(eq(schema.auditEvent.id, middle.id))
      .run();

    const result = verifyStoredChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedAtIndex).toBe(1);
      expect(result.reason).toMatch(/hash mismatch/);
    }
  });

  it('reports fail at exactly the tampered index when the HASH field itself is corrupted out-of-band', () => {
    seedThreeEventChain();
    const rows = readAuditChain(db);
    const middle = rows[1]!;

    db.update(schema.auditEvent).set({ hash: 'deadbeef'.repeat(8) }).where(eq(schema.auditEvent.id, middle.id)).run();

    const result = verifyStoredChain(db);
    expect(result.ok).toBe(false);
    // Corrupting event 1's OWN hash breaks event 1's self-check first (its
    // stored hash no longer matches what's recomputed from its own stored
    // fields) -- the very next row's prevHash-link check never even runs,
    // since verification fails at the earliest index where anything's wrong.
    if (!result.ok) {
      expect(result.failedAtIndex).toBe(1);
      expect(result.reason).toMatch(/hash mismatch/);
    }
  });

  it('a genesis-adjacent corruption (row 0) is pinpointed at index 0, not wrongly blamed on row 1', () => {
    seedThreeEventChain();
    const rows = readAuditChain(db);
    const first = rows[0]!;

    db.update(schema.auditEvent).set({ actor: 'forged' }).where(eq(schema.auditEvent.id, first.id)).run();

    const result = verifyStoredChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(0);
  });
});

// --- Export round-trip: independently re-verifiable OFFLINE, with zero help
// from this package -- proves Task 8.5's "complete dump" claim for real. ----

describe('auditChainToJson round-trip', () => {
  it('re-verifies offline via core\'s own verifyAuditChain + a fresh SHA-256 stand-in (no packages/data import at all)', () => {
    seedThreeEventChain();
    const exported: ExportedAuditEvent[] = readAuditChain(db).map(toExportedAuditEvent);

    const json = auditChainToJson(exported);
    // Simulates a genuinely offline reader: parse the exported text, and
    // reconstruct core's StoredAuditEvent shape using ONLY publicly-known
    // conversions (Date.parse for ts) -- no access to this package's db or
    // internal row types.
    const parsed = JSON.parse(json) as ExportedAuditEvent[];
    expect(parsed).toHaveLength(3);

    const reconstructed: StoredAuditEvent[] = parsed.map((e) => ({
      ts: Date.parse(e.ts),
      actor: e.actor,
      action: e.action,
      entityRef: e.entityRef,
      trigger: e.trigger,
      envelopeSnapshot: e.envelopeSnapshot,
      before: e.before,
      after: e.after,
      justification: e.justification,
      dataSnapshotId: e.dataSnapshotId,
      // Load-bearing: an offline verifier MUST carry source to pick the hash
      // recipe (v1 for legacy/null, v2 for a source-set row) -- omitting it
      // would recompute a post-0006 row under the wrong recipe and spuriously
      // fail an untampered chain.
      source: e.source,
      prevHash: e.prevHash,
      hash: e.hash,
    }));

    expect(verifyAuditChain(reconstructed, sha256Hex)).toEqual({ ok: true });
  });

  it('a tampered export is caught the same way a tampered live chain is', () => {
    seedThreeEventChain();
    const exported = readAuditChain(db).map(toExportedAuditEvent);
    const tampered = exported.map((e, i) => (i === 1 ? { ...e, before: JSON.stringify({ forged: true }) } : e));

    const parsed = JSON.parse(auditChainToJson(tampered)) as ExportedAuditEvent[];
    const reconstructed: StoredAuditEvent[] = parsed.map((e) => ({
      ts: Date.parse(e.ts),
      actor: e.actor,
      action: e.action,
      entityRef: e.entityRef,
      trigger: e.trigger,
      envelopeSnapshot: e.envelopeSnapshot,
      before: e.before,
      after: e.after,
      justification: e.justification,
      dataSnapshotId: e.dataSnapshotId,
      // Load-bearing: an offline verifier MUST carry source to pick the hash
      // recipe (v1 for legacy/null, v2 for a source-set row) -- omitting it
      // would recompute a post-0006 row under the wrong recipe and spuriously
      // fail an untampered chain.
      source: e.source,
      prevHash: e.prevHash,
      hash: e.hash,
    }));

    const result = verifyAuditChain(reconstructed, sha256Hex);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(1);
  });
});

describe('auditChainToCsv', () => {
  it('contains a header row plus one row per event, every column, in order', () => {
    seedThreeEventChain();
    const exported = readAuditChain(db).map(toExportedAuditEvent);
    const csv = auditChainToCsv(exported);
    const lines = csv.split('\r\n');

    expect(lines).toHaveLength(4); // header + 3 events
    expect(lines[0]).toBe(
      'id,ts,actor,action,entity_ref,trigger,envelope_snapshot,before,after,justification,data_snapshot_id,source,prev_hash,hash',
    );

    // Every row ends with the row's own (unquoted, since a hex digest never
    // contains a comma/quote/newline) hash -- the field the whole export
    // exists to preserve.
    for (const [i, e] of exported.entries()) {
      expect(lines[i + 1]!.endsWith(e.hash)).toBe(true);
      expect(lines[i + 1]).toContain(String(e.id));
      expect(lines[i + 1]).toContain(e.action);
      expect(lines[i + 1]).toContain(e.prevHash);
    }
  });

  it('quotes JSON-valued fields (which contain commas) without corrupting the column count', () => {
    seedThreeEventChain();
    const exported = readAuditChain(db).map(toExportedAuditEvent);
    const csv = auditChainToCsv(exported);
    const lines = csv.split('\r\n');

    // The second event's after payload is `{"amountCredits":65000}` --
    // contains a comma-free JSON object in this case, but the FIRST event's
    // after payload `{"amountCredits":4000,"preventFurtherUsage":true}` does
    // contain a comma, and must be quoted (wrapped in one pair of double
    // quotes) rather than split across extra CSV columns.
    const firstEventAfterRaw = exported[0]!.after!;
    expect(firstEventAfterRaw).toContain(',');
    expect(lines[1]).toContain(`"${firstEventAfterRaw.replace(/"/g, '""')}"`);
  });

  it('emits an empty cell (not the literal string "null") for null-valued fields', () => {
    seedThreeEventChain();
    const exported = readAuditChain(db).map(toExportedAuditEvent);
    const csv = auditChainToCsv(exported);
    const lines = csv.split('\r\n');

    // Event 0's `before` is null (an 'add' with no prior state) and its
    // `justification`/`data_snapshot_id` are also null.
    expect(lines[1]).not.toMatch(/null/);
  });
});
