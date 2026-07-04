import { createHash } from 'node:crypto';
import { asc, desc } from 'drizzle-orm';
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
// path; `readAuditChain`/`verifyStoredChain` are read-only.
//
// Node's `node:crypto` SHA-256 is the concrete HashFn packages/core's pure
// hash-chain math (packages/core/src/auditChain.ts) is parameterized over --
// core itself never imports node:crypto (CLAUDE.md §2: it must also run in a
// browser). `createHash(...).update(...).digest('hex')` is synchronous, so
// this satisfies HashFn's `(input: string) => string` (sync, hex) contract.
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

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
// number").
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
  };
}

// Appends exactly one row. Reads the current chain tip and inserts inside a
// single transaction so a concurrent append can never read the same tip
// twice and fork the chain (mirrors sync/sync-now.ts's transaction use).
// Returns the inserted row (including its computed prevHash/hash) so callers
// (the Task 4.8 write engine) can surface it immediately without a re-read.
export function appendAuditEvent(db: Db, input: AppendAuditEventInput): AuditEventRow {
  return db.transaction((tx) => {
    const tip = tx
      .select({ hash: schema.auditEvent.hash })
      .from(schema.auditEvent)
      .orderBy(desc(schema.auditEvent.id))
      .limit(1)
      .all()[0];
    const prevHash = tip ? tip.hash : AUDIT_CHAIN_GENESIS_PREV_HASH;

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
        prevHash,
        hash,
      })
      .returning()
      .get();
  });
}

/** Read-only surface for verification/export (Phase 8's audit export reuses this). Ascending by id -- the chain's actual append order. */
export function readAuditChain(db: Db): AuditEventRow[] {
  return db.select().from(schema.auditEvent).orderBy(asc(schema.auditEvent.id)).all();
}

/** Convenience: reads the full stored chain and verifies it with the real SHA-256 primitive. */
export function verifyStoredChain(db: Db): AuditChainVerification {
  const rows = readAuditChain(db);
  const events: StoredAuditEvent[] = rows.map((row) => ({
    ...toFields(row),
    prevHash: row.prevHash,
    hash: row.hash,
  }));
  return verifyAuditChain(events, sha256Hex);
}
