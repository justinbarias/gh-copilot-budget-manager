// CLAUDE.md §6.5 / PLAN.md Task 4.7: the append-only, hash-chained audit log.
// Each row's hash = H(prevHash ‖ canonicalPayload(row's own fields)) -- this
// module is the pure, portable half (canonicalization + hash math +
// verification); packages/data owns the SQLite table, the append-only
// writer, and supplies the real hash primitive (SHA-256 via node:crypto).
// This module imports nothing from node -- it must run identically in
// Electron main, a future Node server, or a browser (CLAUDE.md §2).

// The genesis sentinel is deliberately NOT hash-shaped (a real SHA-256 digest
// is 64 lowercase hex chars) so a reader/db-dump can never mistake it for a
// real chain link. It is the fixed `prevHash` of event #0, always.
export const AUDIT_CHAIN_GENESIS_PREV_HASH = 'AUDIT_CHAIN_GENESIS';

// Synchronous, hex-output hash primitive, injected by the caller so this
// module has zero I/O / zero node:crypto import (CLAUDE.md §2). packages/data
// supplies SHA-256 via node:crypto; this module's own tests use a trivial
// deterministic stub -- the concrete algorithm is not this module's concern,
// only that hashing is total, deterministic, and pure (same input -> same
// output, forever).
export type HashFn = (input: string) => string;

// The exact set of fields a hash covers -- deliberately mirrors (but is not
// coupled to) packages/data's `audit_event` columns minus id/prevHash/hash:
// `id` is a DB auto-increment, not semantically part of the event; `prevHash`
// and `hash` are the chain-linking fields *computed from* this payload, so
// they can never be inputs to it (see computeEventHash).
//
// binding_constraint -- CLAUDE.md §6.5's fifth required field ("actor,
// trigger, envelope, binding constraint, before/after, ... data snapshot")
// -- is deliberately NOT its own field here: PLAN.md Task 4.7's literal
// audit_event column list (13 columns) has no dedicated column for it. The
// convention, pending Checkpoint 4a ratification (see the migration review
// packet handed to the maintainer alongside this code), is that binding
// constraint -- and, later, Phase 6/7's forecast basis -- travel inside
// `envelopeSnapshot`'s JSON as rebalancer context: a manual Phase-4 apply has
// no binding constraint at all (there's no envelope to speak of), so forcing
// a top-level field would mean "null for every event this phase produces".
// If the maintainer instead wants a dedicated column, this type gains one
// additively -- no chain math above it changes.
export interface AuditEventFields {
  /**
   * Epoch milliseconds. The data layer stores this as a `Date` (Drizzle's
   * `timestamp_ms` mode); hashing always uses the raw epoch-ms number so the
   * canonical payload never depends on how a `Date` happens to stringify.
   */
  ts: number;
  actor: string;
  action: string;
  entityRef: string;
  trigger: string;
  /** Pre-serialized JSON string, or null -- see the binding_constraint note above. */
  envelopeSnapshot: string | null;
  /** Pre-serialized JSON string, or null for an 'add'-style create with no prior state. */
  before: string | null;
  /** Pre-serialized JSON string, or null for a 'delete'-style removal with no resulting state. */
  after: string | null;
  justification: string | null;
  dataSnapshotId: number | null;
}

// --- Canonicalization rule (read this before touching this function) ------
//
// - An explicit, hand-written field list in a FIXED order -- never
//   `Object.keys(fields)` or a `{...fields}` spread, either of which would
//   silently change serialized order if a field were added/reordered later.
// - Serialized as a JSON ARRAY, not an object: arrays have no key-ordering
//   question to get wrong, so "stable ordering" is structural, not merely
//   conventional (unlike an object, whose stability would otherwise lean on
//   JSON.stringify's insertion-order behavior for string keys).
// - Nested JSON fields (envelopeSnapshot/before/after) are taken as
//   already-serialized strings and are NOT re-serialized here. This hashes
//   exactly the bytes that get stored in the DB -- there is no "reconstruct
//   JSON from a JS object" step at verify time to drift from what was
//   originally written. That is what makes "a hash computed today must
//   verify forever" true regardless of how some future refactor constructs
//   the objects that produced those strings.
//
// Never change the field order, add a field without appending it at the end,
// or switch away from the array encoding without a migration note -- doing
// so changes every previously-computed hash's meaning.
export function canonicalizeAuditPayload(fields: AuditEventFields): string {
  return JSON.stringify([
    fields.ts,
    fields.actor,
    fields.action,
    fields.entityRef,
    fields.trigger,
    fields.envelopeSnapshot,
    fields.before,
    fields.after,
    fields.justification,
    fields.dataSnapshotId,
  ]);
}

// The NUL character (U+0000) is used as the prevHash/payload separator
// because it cannot appear inside either operand: JSON.stringify never
// emits a raw NUL byte in its output (an embedded NUL in a source string is
// escaped as six literal characters, backslash-u-0-0-0-0, never a raw
// control byte), and `prevHash` is always either the genesis sentinel or a
// hex digest -- neither contains one either. So the two operands can never
// be ambiguously re-split: no pair of different (prevHash, canonicalPayload)
// inputs can concatenate (with this separator) to the same string.
//
// It is written in source as the \u0000 Unicode escape (six ASCII chars,
// NOT a literal 0x00 byte) deliberately: this is a "verify-forever"
// compliance artifact (CLAUDE.md §6.5), and a raw NUL in a source file is
// fragile -- a control-character-stripping formatter/linter could silently
// swap it for a space (which is *also* collision-safe here, so tests would
// still pass) yet change every historical hash and break verification of
// previously-stored chains. The escape produces the identical runtime string
// (U+0000) with none of that tooling risk.
export function computeEventHash(prevHash: string, canonicalPayload: string, hashFn: HashFn): string {
  return hashFn(`${prevHash}\u0000${canonicalPayload}`);
}

export interface StoredAuditEvent extends AuditEventFields {
  prevHash: string;
  hash: string;
}

export type AuditChainVerification = { ok: true } | { ok: false; failedAtIndex: number; reason: string };

// Verifies that every row's hash was actually computed from its own stored
// fields (tamper-evidence) AND that prevHash correctly links to the previous
// row's hash, or the genesis sentinel for row 0 (chain-evidence). Tampering
// ANY field of ANY event -- including prevHash or hash themselves -- changes
// that event's canonical payload and/or breaks the chain-link comparison, so
// verification fails at that event's index. Reordering or deleting a middle
// event breaks the prevHash <-> hash link at the first index where the gap
// or swap manifests.
export function verifyAuditChain(
  events: readonly StoredAuditEvent[],
  hashFn: HashFn,
  genesisPrevHash: string = AUDIT_CHAIN_GENESIS_PREV_HASH,
): AuditChainVerification {
  let expectedPrevHash = genesisPrevHash;

  for (const [index, event] of events.entries()) {
    if (event.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        failedAtIndex: index,
        reason: `prev_hash mismatch: expected "${expectedPrevHash}", found "${event.prevHash}"`,
      };
    }

    const recomputedHash = computeEventHash(event.prevHash, canonicalizeAuditPayload(event), hashFn);
    if (recomputedHash !== event.hash) {
      return {
        ok: false,
        failedAtIndex: index,
        reason: "hash mismatch: stored hash does not match the hash recomputed from this event's stored fields",
      };
    }

    expectedPrevHash = event.hash;
  }

  return { ok: true };
}
