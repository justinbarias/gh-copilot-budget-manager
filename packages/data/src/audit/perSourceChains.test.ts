import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_GENESIS_PREV_HASH,
  canonicalizeAuditPayload,
  computeEventHash,
  verifyAuditChain,
  type AuditEventFields,
  type StoredAuditEvent,
} from '@copilot-budget/core';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import {
  appendAuditEvent,
  readAuditChain,
  readScopedAuditChain,
  verifyAllSegments,
  verifyStoredChain,
  type AppendAuditEventInput,
} from './writer.js';

// CLAUDE.md §6.5's compliance surface: the per-source audit chains introduced
// by migration 0006. These tests independently recompute the v1 (legacy) and
// v2 (per-source) hash recipes against the fixtures rather than trusting the
// writer's own path (MEMORY.md: adversarial verify-don't-trust), and cover the
// migration upgrade path, per-source continuity across interleaved appends,
// the four mandated tamper cases, and reader scoping.

const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

// The SAME primitive convention the writer's internal sha256Hex uses, rebuilt
// here from node:crypto directly so these tests never lean on the writer's own
// hashing closure to compute an "independent" expected hash.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-persource-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseInput: Omit<AppendAuditEventInput, 'source'> = {
  ts: new Date('2026-06-15T00:00:00.000Z'),
  actor: 'admin@example.com',
  action: 'budget.create',
  entityRef: 'budget:universal:acme-enterprise',
  trigger: 'manual',
  before: null,
  after: { amountCredits: 4000 },
  justification: null,
  dataSnapshotId: null,
};

// --- Independent expected-hash recomputation (recipe-aware) ----------------

// Builds packages/core's AuditEventFields from an appended row, exactly as an
// offline verifier would -- source included, so the recipe is chosen the same
// way canonicalizeAuditPayload chooses it.
function fieldsFromRow(row: {
  ts: Date;
  actor: string;
  action: string;
  entityRef: string;
  trigger: string;
  envelopeSnapshot: string | null;
  before: string | null;
  after: string | null;
  justification: string | null;
  dataSnapshotId: number | null;
  source: string | null;
}): AuditEventFields {
  return {
    ts: row.ts.getTime(),
    actor: row.actor,
    action: row.action,
    entityRef: row.entityRef,
    trigger: row.trigger,
    envelopeSnapshot: row.envelopeSnapshot,
    before: row.before,
    after: row.after,
    justification: row.justification,
    dataSnapshotId: row.dataSnapshotId,
    source: row.source,
  };
}

// --- Pre-0006 (legacy) database construction -------------------------------

// A migrations folder holding ONLY 0000..0005 (everything BEFORE 0006's source
// column), by copying the real files + a journal truncated to the first six
// entries -- exactly the existing upgrade-test convention, so drizzle's real
// __drizzle_migrations tracking is exercised across two runMigrations calls.
function buildPre0006Folder(rootDir: string): string {
  const folder = path.join(rootDir, 'migrations-pre-0006');
  mkdirSync(path.join(folder, 'meta'), { recursive: true });

  const fullJournal = JSON.parse(readFileSync(path.join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = fullJournal.entries.filter((e) => e.idx <= 5);
  for (const entry of kept) {
    writeFileSync(
      path.join(folder, `${entry.tag}.sql`),
      readFileSync(path.join(REAL_MIGRATIONS_FOLDER, `${entry.tag}.sql`)),
    );
    const metaName = `${String(entry.idx).padStart(4, '0')}_snapshot.json`;
    writeFileSync(
      path.join(folder, 'meta', metaName),
      readFileSync(path.join(REAL_MIGRATIONS_FOLDER, 'meta', metaName)),
    );
  }
  writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ ...fullJournal, entries: kept }));
  return folder;
}

// Writes genuine LEGACY rows (v1 recipe: no source element in the hash) into a
// pre-0006 DB via raw SQL against the real underlying better-sqlite3 handle --
// the source column does not exist yet, so this is exactly how the maintainer's
// real pre-separation rows were written. Returns the in-memory StoredAuditEvent
// chain it built (hashes computed via core's v1 recipe) so a caller can verify
// it independently BEFORE the migration runs.
function seedLegacyRows(target: Db, specs: { actor: string; action: string }[]): StoredAuditEvent[] {
  const insert = (target as unknown as { $client: import('better-sqlite3').Database }).$client.prepare(
    `INSERT INTO audit_event (ts, actor, action, entity_ref, trigger, envelope_snapshot, before, after, justification, data_snapshot_id, prev_hash, hash)
     VALUES (@ts, @actor, @action, @entityRef, @trigger, NULL, NULL, NULL, NULL, NULL, @prevHash, @hash)`,
  );
  const chain: StoredAuditEvent[] = [];
  let prevHash = AUDIT_CHAIN_GENESIS_PREV_HASH;
  const ts = new Date('2026-05-01T00:00:00.000Z').getTime();
  for (const spec of specs) {
    // source deliberately OMITTED -> canonicalizeAuditPayload uses the v1 recipe.
    const fields: AuditEventFields = {
      ts,
      actor: spec.actor,
      action: spec.action,
      entityRef: 'budget:universal:acme-enterprise',
      trigger: 'manual',
      envelopeSnapshot: null,
      before: null,
      after: null,
      justification: null,
      dataSnapshotId: null,
    };
    const hash = computeEventHash(prevHash, canonicalizeAuditPayload(fields), sha256Hex);
    insert.run({ ts, actor: spec.actor, action: spec.action, entityRef: fields.entityRef, trigger: 'manual', prevHash, hash });
    chain.push({ ...fields, prevHash, hash });
    prevHash = hash;
  }
  return chain;
}

// --- Migration upgrade path ------------------------------------------------

describe('migration 0006 -- populated pre-migration DB verifies before AND after', () => {
  it('legacy rows written under the v1 recipe survive the additive migration and still verify', () => {
    // 1. Pre-0006 schema (no source column) + real legacy rows.
    const preFolder = buildPre0006Folder(tmpDir);
    runMigrations(db, preFolder);
    const legacyChain = seedLegacyRows(db, [
      { actor: 'admin@example.com', action: 'budget.create' },
      { actor: 'admin@example.com', action: 'budget.update' },
      { actor: 'ops@example.com', action: 'budget.delete' },
    ]);

    // 2. BEFORE the migration: the rows form a valid v1 chain (verified by
    // core directly against the independently-recomputed hashes).
    expect(verifyAuditChain(legacyChain, sha256Hex)).toEqual({ ok: true });

    // 3. Apply migration 0006 (ADD COLUMN source) on top.
    runMigrations(db, REAL_MIGRATIONS_FOLDER);

    // 4. AFTER: existing rows now carry a null source and STILL verify -- the
    // migration was additive and the v1 recipe is preserved for null-source
    // rows.
    const migratedRows = readAuditChain(db);
    expect(migratedRows.every((r) => r.source === null)).toBe(true);
    expect(verifyStoredChain(db)).toEqual({ ok: true });
    expect(verifyAllSegments(db).ok).toBe(true);

    // 5. New per-source rows anchor at the legacy tip and extend cleanly.
    const legacyTip = legacyChain[legacyChain.length - 1]!.hash;
    const simRow = appendAuditEvent(db, { ...baseInput, source: 'msw' });
    expect(simRow.prevHash).toBe(legacyTip); // anchored, not a fresh genesis
    expect(simRow.source).toBe('msw');
    const liveRow = appendAuditEvent(db, { ...baseInput, source: 'github' });
    expect(liveRow.prevHash).toBe(legacyTip); // github chain ALSO anchors at the legacy tip

    // 6. Every segment still intact, and each new row's hash matches an
    // independent v2 recomputation (source folded in).
    expect(verifyAllSegments(db).ok).toBe(true);
    for (const row of [simRow, liveRow]) {
      const expected = computeEventHash(row.prevHash, canonicalizeAuditPayload(fieldsFromRow(row)), sha256Hex);
      expect(row.hash).toBe(expected);
    }
  });
});

// --- Per-source continuity across interleaved appends ----------------------

describe('per-source continuity (interleaved sim/live appends)', () => {
  beforeEach(() => runMigrations(db));

  it('each event links to its OWN source predecessor, not the global previous row', () => {
    const sim1 = appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.create' });
    const live1 = appendAuditEvent(db, { ...baseInput, source: 'github', action: 'budget.create' });
    const sim2 = appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.update' });
    const live2 = appendAuditEvent(db, { ...baseInput, source: 'github', action: 'budget.update' });

    // With no legacy rows, both chains anchor at the genesis sentinel.
    expect(sim1.prevHash).toBe(AUDIT_CHAIN_GENESIS_PREV_HASH);
    expect(live1.prevHash).toBe(AUDIT_CHAIN_GENESIS_PREV_HASH);
    // sim2 links to sim1 (NOT to live1, the globally-previous row) and
    // live2 links to live1 (NOT to sim2).
    expect(sim2.prevHash).toBe(sim1.hash);
    expect(live2.prevHash).toBe(live1.hash);

    expect(verifyAllSegments(db).ok).toBe(true);
    const segmented = verifyAllSegments(db);
    expect(segmented.segments.map((s) => ({ source: s.source, count: s.count, ok: s.result.ok }))).toEqual([
      { source: null, count: 0, ok: true },
      { source: 'github', count: 2, ok: true },
      { source: 'msw', count: 2, ok: true },
    ]);
  });
});

// --- The four mandated tamper cases ----------------------------------------

describe('tamper detection across all segments (verifyAllSegments is the compliance surface)', () => {
  it('detects a mutated LEGACY row', () => {
    const preFolder = buildPre0006Folder(tmpDir);
    runMigrations(db, preFolder);
    seedLegacyRows(db, [
      { actor: 'admin@example.com', action: 'budget.create' },
      { actor: 'admin@example.com', action: 'budget.update' },
    ]);
    runMigrations(db, REAL_MIGRATIONS_FOLDER);
    appendAuditEvent(db, { ...baseInput, source: 'msw' });
    expect(verifyAllSegments(db).ok).toBe(true);

    const firstLegacy = readAuditChain(db).find((r) => r.source === null)!;
    db.update(schema.auditEvent).set({ actor: 'forged' }).where(eq(schema.auditEvent.id, firstLegacy.id)).run();

    const segmented = verifyAllSegments(db);
    expect(segmented.ok).toBe(false);
    expect(segmented.segments.find((s) => s.source === null)!.result.ok).toBe(false);
  });

  it('detects a mutated SIM (msw) row', () => {
    runMigrations(db);
    appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.create' });
    const target = appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.update' });
    appendAuditEvent(db, { ...baseInput, source: 'github', action: 'budget.create' });

    db.update(schema.auditEvent).set({ after: JSON.stringify({ amountCredits: 999_999 }) }).where(eq(schema.auditEvent.id, target.id)).run();

    const segmented = verifyAllSegments(db);
    expect(segmented.ok).toBe(false);
    expect(segmented.segments.find((s) => s.source === 'msw')!.result.ok).toBe(false);
    // The untouched github segment stays intact -- failure is isolated.
    expect(segmented.segments.find((s) => s.source === 'github')!.result.ok).toBe(true);
  });

  it('detects a mutated LIVE (github) row', () => {
    runMigrations(db);
    appendAuditEvent(db, { ...baseInput, source: 'github', action: 'budget.create' });
    const target = appendAuditEvent(db, { ...baseInput, source: 'github', action: 'budget.update' });
    appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.create' });

    db.update(schema.auditEvent).set({ actor: 'forged' }).where(eq(schema.auditEvent.id, target.id)).run();

    const segmented = verifyAllSegments(db);
    expect(segmented.ok).toBe(false);
    expect(segmented.segments.find((s) => s.source === 'github')!.result.ok).toBe(false);
    expect(segmented.segments.find((s) => s.source === 'msw')!.result.ok).toBe(true);
  });

  it('detects a RE-LABELLED source (a github event forged to look like msw)', () => {
    runMigrations(db);
    appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.create' });
    const live = appendAuditEvent(db, { ...baseInput, source: 'github', action: 'budget.create' });
    expect(verifyAllSegments(db).ok).toBe(true);

    // Re-label ONLY the source column -- the attacker leaves every other field
    // (and the stored hash) intact, trying to move a live event into the sim
    // chain. Because source is folded into the v2 hash, the recomputed hash no
    // longer matches: the row now verifies under the msw segment against its
    // stored source='msw', but its hash was computed over source='github'.
    db.update(schema.auditEvent).set({ source: 'msw' }).where(eq(schema.auditEvent.id, live.id)).run();

    const segmented = verifyAllSegments(db);
    expect(segmented.ok).toBe(false);
    // The github segment is now empty (the row moved out) and the msw segment
    // carries a row whose hash doesn't match its re-labelled source.
    expect(segmented.segments.find((s) => s.source === 'msw')!.result.ok).toBe(false);
  });
});

// --- Scoped verify + reader scoping (UI-facing) ----------------------------

describe('scoped verify + reader scoping (what the Audit screen consumes)', () => {
  beforeEach(() => runMigrations(db));

  it('readScopedAuditChain returns legacy + the requested source only, ascending by id', () => {
    const preFolder = buildPre0006Folder(tmpDir);
    // Fresh DB on the pre-0006 schema for the legacy rows, then migrate.
    const db2Dir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-persource-scoped-'));
    try {
      const db2 = createDb(path.join(db2Dir, 't.sqlite'));
      runMigrations(db2, preFolder);
      seedLegacyRows(db2, [{ actor: 'a@x', action: 'budget.create' }]);
      runMigrations(db2, REAL_MIGRATIONS_FOLDER);
      const sim = appendAuditEvent(db2, { ...baseInput, source: 'msw', action: 'budget.update' });
      const live = appendAuditEvent(db2, { ...baseInput, source: 'github', action: 'budget.update' });

      const simView = readScopedAuditChain(db2, 'msw');
      expect(simView.map((r) => r.source)).toEqual([null, 'msw']); // legacy + msw, no github
      expect(simView.some((r) => r.id === live.id)).toBe(false);

      const liveView = readScopedAuditChain(db2, 'github');
      expect(liveView.map((r) => r.source)).toEqual([null, 'github']);
      expect(liveView.some((r) => r.id === sim.id)).toBe(false);
    } finally {
      rmSync(db2Dir, { recursive: true, force: true });
    }
  });

  it('a tamper in the CURRENT mode maps failedAtIndex into the scoped view', () => {
    appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.create' });
    const target = appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.update' });
    db.update(schema.auditEvent).set({ actor: 'forged' }).where(eq(schema.auditEvent.id, target.id)).run();

    const result = verifyStoredChain(db, 'msw');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAtIndex).toBe(1); // second row of the scoped view
  });

  it('a tamper ONLY in the hidden mode still fails overall, past the last shown row', () => {
    const sim1 = appendAuditEvent(db, { ...baseInput, source: 'msw', action: 'budget.create' });
    const live1 = appendAuditEvent(db, { ...baseInput, source: 'github', action: 'budget.create' });
    void sim1;
    // Tamper the LIVE row; verify from the SIM client's perspective.
    db.update(schema.auditEvent).set({ actor: 'forged' }).where(eq(schema.auditEvent.id, live1.id)).run();

    const scopedRows = readScopedAuditChain(db, 'msw'); // legacy(0) + msw(1)
    const result = verifyStoredChain(db, 'msw');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // failedAtIndex sits at scoped length so every SHOWN row still reads intact.
      expect(result.failedAtIndex).toBe(scopedRows.length);
      expect(result.reason).toMatch(/different mode's audit chain \(github\)/);
    }
  });

  it('every row carries a source field for the UI badge (null == legacy)', () => {
    const row = appendAuditEvent(db, { ...baseInput, source: 'github' });
    expect(row).toHaveProperty('source', 'github');
    expect(readScopedAuditChain(db, 'github').every((r) => 'source' in r)).toBe(true);
    expect(db.select().from(schema.auditEvent).where(isNull(schema.auditEvent.source)).all()).toHaveLength(0);
  });
});
