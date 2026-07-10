import { createHash } from 'node:crypto';
import { asc, desc, eq, isNull, or } from 'drizzle-orm';
import {
  AUDIT_CHAIN_GENESIS_PREV_HASH,
  canonicalizeAuditPayload,
  computeEventHash,
  verifyAuditChain,
  type AuditChainVerification,
  type AuditEventFields,
  type StoredAuditEvent,
} from '@copilot-budget/core';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';

// This module is the ONLY place in the codebase that writes `audit_event`
// rows, and it deliberately exports no update/delete function -- mutation of
// an existing row is unrepresentable through this API (CLAUDE.md §6.5: an
// immutable, append-only audit log). `appendAuditEvent` is the sole write
// path; `readAuditChain`/`readScopedAuditChain`/`verifyStoredChain` are
// read-only.
//
// --- Per-source chains (migration 0006, maintainer-approved) --------------
//
// Simulation ('msw') and live ('github') each get their OWN tamper-evident
// hash chain, discriminated by the nullable `source` column. Rows written
// before this change carry a null `source` and form the "legacy"
// (pre-separation) segment. The chain topology is:
//
//   * LEGACY segment: every source-null row, ascending by id, chained from the
//     genesis sentinel exactly as originally written -- and verified under the
//     v1 hash recipe (packages/core's canonicalizeAuditPayload emits no
//     `source` element when it is null), so pre-existing chains verify
//     byte-identically forever.
//   * Each SOURCE segment ('msw', 'github'): every row of that source,
//     ascending by id, chained from that source's own previous row -- and, for
//     the FIRST row of a source, ANCHORED at the legacy tip (the hash of the
//     last legacy row, or the genesis sentinel when no legacy rows exist).
//     Verified under the v2 recipe (`source` folded into the hash).
//
// Anchoring each source chain at the legacy tip (rather than a fresh
// null-genesis) is a deliberate tamper-evidence choice: if the whole legacy
// segment were deleted, the legacy tip recomputes to the genesis sentinel, so
// each source chain's stored first-row prevHash (the real legacy-tip digest)
// no longer matches -- the deletion is detectable from WITHIN the source
// chains. A fresh null-genesis would make that deletion invisible. Because all
// legacy rows predate every source row (no null row is ever written again),
// every legacy id is below every source id, so "ascending by id" reproduces
// each segment's true append order, and legacy-then-source concatenation is
// itself one valid chain from genesis (see readScopedAuditChain).
//
// Node's `node:crypto` SHA-256 is the concrete HashFn packages/core's pure
// hash-chain math (packages/core/src/auditChain.ts) is parameterized over --
// core itself never imports node:crypto (CLAUDE.md §2: it must also run in a
// browser). `createHash(...).update(...).digest('hex')` is synchronous, so
// this satisfies HashFn's `(input: string) => string` (sync, hex) contract.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The two client modes that write audit events (== schema.snapshot.source / ApplyPlanOptions.source). */
export type AuditSource = 'msw' | 'github';

/**
 * Input to `appendAuditEvent`. JSON-valued fields (`envelopeSnapshot`,
 * `before`, `after`) are accepted as plain JS values (objects, arrays,
 * primitives) and JSON.stringify'd exactly once here, at write time -- the
 * resulting string is what's stored AND what's hashed, so verification never
 * needs to re-derive a string from a reconstructed object (see
 * canonicalizeAuditPayload's doc comment in packages/core).
 */
export interface AppendAuditEventInput {
  ts: Date;
  actor: string;
  action: string;
  entityRef: string;
  trigger: string;
  /**
   * The writing client's mode ('msw' | 'github'). REQUIRED (never optional/
   * defaulted) so no call site can silently write an ambiguous (null-source)
   * row -- every event appended from migration 0006 onward belongs to exactly
   * one source chain. Null source is reserved for pre-existing legacy rows,
   * which this writer never produces.
   */
  source: AuditSource;
  envelopeSnapshot?: unknown;
  before?: unknown;
  after?: unknown;
  justification?: string | null;
  dataSnapshotId?: number | null;
}

export interface AuditEventRow {
  id: number;
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
  /** 'msw' | 'github' for a per-source-chain row; null for a legacy (pre-0006) row. */
  source: string | null;
  prevHash: string;
  hash: string;
}

function toJsonField(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// Derives packages/core's hash-input shape from a stored row. `ts` is
// converted back to epoch-ms here (not left as a `Date`) so hashing never
// depends on `Date`'s own stringification -- see packages/core's
// AuditEventFields doc comment ("hashing always uses the raw epoch-ms
// number"). `source` is passed through verbatim (null for legacy rows) so the
// canonicalizer picks the right recipe.
function toFields(row: Omit<AuditEventRow, 'id' | 'prevHash' | 'hash'>): AuditEventFields {
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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Hash of the last legacy (source-null) row, or the genesis sentinel when none exist -- the anchor every source chain's first row links to. */
function legacyTipHash(tx: Tx): string {
  const tip = tx
    .select({ hash: schema.auditEvent.hash })
    .from(schema.auditEvent)
    .where(isNull(schema.auditEvent.source))
    .orderBy(desc(schema.auditEvent.id))
    .limit(1)
    .all()[0];
  return tip ? tip.hash : AUDIT_CHAIN_GENESIS_PREV_HASH;
}

/**
 * The prevHash a new row of `source` must link to: this source's own current
 * tip, or -- when this is the first row of the source -- the legacy tip
 * anchor.
 */
function chainTipHashFor(tx: Tx, source: AuditSource): string {
  const sourceTip = tx
    .select({ hash: schema.auditEvent.hash })
    .from(schema.auditEvent)
    .where(eq(schema.auditEvent.source, source))
    .orderBy(desc(schema.auditEvent.id))
    .limit(1)
    .all()[0];
  return sourceTip ? sourceTip.hash : legacyTipHash(tx);
}

// Appends exactly one row to the calling client's own source chain. Reads that
// chain's current tip and inserts inside a single transaction so a concurrent
// append can never read the same tip twice and fork the chain (mirrors
// sync/sync-now.ts's transaction use). Returns the inserted row (including its
// computed prevHash/hash) so callers (the Task 4.8 write engine) can surface
// it immediately without a re-read.
export function appendAuditEvent(db: Db, input: AppendAuditEventInput): AuditEventRow {
  return db.transaction((tx) => {
    const prevHash = chainTipHashFor(tx, input.source);

    const fields: AuditEventFields = {
      ts: input.ts.getTime(),
      actor: input.actor,
      action: input.action,
      entityRef: input.entityRef,
      trigger: input.trigger,
      envelopeSnapshot: toJsonField(input.envelopeSnapshot),
      before: toJsonField(input.before),
      after: toJsonField(input.after),
      justification: input.justification ?? null,
      dataSnapshotId: input.dataSnapshotId ?? null,
      source: input.source,
    };

    const hash = computeEventHash(prevHash, canonicalizeAuditPayload(fields), sha256Hex);

    return tx
      .insert(schema.auditEvent)
      .values({
        ts: input.ts,
        actor: fields.actor,
        action: fields.action,
        entityRef: fields.entityRef,
        trigger: fields.trigger,
        envelopeSnapshot: fields.envelopeSnapshot,
        before: fields.before,
        after: fields.after,
        justification: fields.justification,
        dataSnapshotId: fields.dataSnapshotId,
        source: input.source,
        prevHash,
        hash,
      })
      .returning()
      .get();
  });
}

/** Read-only surface: the FULL stored chain (every source + legacy), ascending by id. Used by verification/export. */
export function readAuditChain(db: Db): AuditEventRow[] {
  return db.select().from(schema.auditEvent).orderBy(asc(schema.auditEvent.id)).all();
}

/**
 * Read-only surface scoped to ONE mode's view: the legacy (source-null) rows
 * plus the given source's rows, ascending by id. Because every legacy id is
 * below every source id, this is exactly [legacy..., source...], which is one
 * valid chain from genesis (the source segment is anchored at the legacy tip).
 * This is what `getAuditChain()` returns so the Audit screen shows only the
 * current mode's events (legacy rows are badged, shown in both modes).
 */
export function readScopedAuditChain(db: Db, source: AuditSource): AuditEventRow[] {
  return db
    .select()
    .from(schema.auditEvent)
    .where(or(isNull(schema.auditEvent.source), eq(schema.auditEvent.source, source)))
    .orderBy(asc(schema.auditEvent.id))
    .all();
}

function rowToStored(row: AuditEventRow): StoredAuditEvent {
  return { ...toFields(row), prevHash: row.prevHash, hash: row.hash };
}

/** One verified segment: the source it belongs to (null == legacy) and its per-segment result. */
export interface AuditSegmentVerification {
  source: string | null;
  count: number;
  result: AuditChainVerification;
}

export interface SegmentedChainVerification {
  ok: boolean;
  segments: AuditSegmentVerification[];
}

/**
 * The COMPLIANCE verifier (CLAUDE.md §6.5): verifies every segment
 * independently -- the legacy segment from the genesis sentinel, and each
 * source segment from the legacy-tip anchor -- and reports overall
 * intact-ness as the AND of all segments. Tampering ANY segment (a legacy
 * row, a sim row, a live row) or re-labelling a row's source fails this.
 *
 * Segment order in the result: legacy first, then sources sorted by name --
 * deterministic so callers/tests can rely on it.
 */
export function verifyAllSegments(db: Db): SegmentedChainVerification {
  const rows = readAuditChain(db);

  const legacyRows = rows.filter((r) => r.source == null);
  const legacyTip = legacyRows.length > 0 ? legacyRows[legacyRows.length - 1]!.hash : AUDIT_CHAIN_GENESIS_PREV_HASH;

  const sources = [...new Set(rows.filter((r) => r.source != null).map((r) => r.source as string))].sort();

  const segments: AuditSegmentVerification[] = [];

  // Legacy segment: anchored at genesis, verified under the v1 recipe.
  segments.push({
    source: null,
    count: legacyRows.length,
    result: verifyAuditChain(legacyRows.map(rowToStored), sha256Hex, AUDIT_CHAIN_GENESIS_PREV_HASH),
  });

  // Each source segment: anchored at the legacy tip, verified under the v2 recipe.
  for (const source of sources) {
    const sourceRows = rows.filter((r) => r.source === source);
    segments.push({
      source,
      count: sourceRows.length,
      result: verifyAuditChain(sourceRows.map(rowToStored), sha256Hex, legacyTip),
    });
  }

  return { ok: segments.every((s) => s.result.ok), segments };
}

/**
 * Convenience verifier over the FULL stored chain, returning a single
 * AuditChainVerification. It runs the all-segments compliance check
 * (verifyAllSegments) AND, when a `currentSource` is given, maps any failure
 * onto the SCOPED view (legacy + currentSource) that `getAuditChain()` returns
 * -- so `failedAtIndex` lines up with the rows the Audit screen actually
 * shows.
 *
 *   * All segments intact            -> { ok: true }.
 *   * A failure inside the scoped     -> that scoped result verbatim
 *     view (legacy or currentSource)     (failedAtIndex indexes the scoped rows).
 *   * A failure only in ANOTHER        -> ok:false, failedAtIndex = scoped length
 *     mode's chain (hidden segment)      (so every shown row still reads intact),
 *                                        reason names the offending source.
 *
 * Called with no `currentSource` (legacy signature), it returns {ok:true} when
 * all segments are intact, or the first failing segment's result mapped to a
 * whole-chain (all-rows-by-id) index otherwise.
 */
export function verifyStoredChain(db: Db, currentSource?: AuditSource): AuditChainVerification {
  const segmented = verifyAllSegments(db);
  if (segmented.ok) return { ok: true };

  if (currentSource === undefined) {
    // No scoped view to map onto: report the first failing segment against the
    // full ascending-by-id ordering of ALL rows, so failedAtIndex stays
    // globally meaningful.
    const allRows = readAuditChain(db);
    const failing = segmented.segments.find((s) => !s.result.ok)!;
    const failingResult = failing.result as { ok: false; failedAtIndex: number; reason: string };
    const segRows = allRows.filter((r) => (failing.source == null ? r.source == null : r.source === failing.source));
    const failedRowId = segRows[failingResult.failedAtIndex]!.id;
    return {
      ok: false,
      failedAtIndex: allRows.findIndex((r) => r.id === failedRowId),
      reason: `${failing.source == null ? 'legacy' : failing.source} segment: ${failingResult.reason}`,
    };
  }

  // Scoped view = legacy + currentSource, which is one chain from genesis.
  const scopedRows = readScopedAuditChain(db, currentSource);
  const scopedResult = verifyAuditChain(scopedRows.map(rowToStored), sha256Hex, AUDIT_CHAIN_GENESIS_PREV_HASH);
  if (!scopedResult.ok) return scopedResult;

  // Scoped view is intact but the overall check failed -> a hidden segment
  // (the OTHER mode's chain, or a legacy break that the anchor still masks) is
  // broken. Surface it without corrupting the shown rows' indices.
  const hidden = segmented.segments.find((s) => !s.result.ok)!;
  const hiddenReason = (hidden.result as { reason: string }).reason;
  return {
    ok: false,
    failedAtIndex: scopedRows.length,
    reason: `A different mode's audit chain (${hidden.source == null ? 'legacy' : hidden.source}) failed verification: ${hiddenReason}`,
  };
}
