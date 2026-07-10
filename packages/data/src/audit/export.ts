import type { AuditEventRow } from './writer.js';

// Task 8.5 (CLAUDE.md §6.5's government/compliance export deliverable): pure,
// dependency-free serializers turning the stored audit chain into JSON/CSV
// text. No I/O, no Electron, no DOM here -- the actual browser download
// (Blob + <a download>) is a renderer concern and lives in
// packages/ui/src/lib/auditExport.ts, which duplicates ONLY this file's CSV
// column list + escaping (see that file's doc comment for why: the UI
// package imports @copilot-budget/data for TYPES ONLY everywhere else in
// this codebase -- CLAUDE.md's portability rule -- so a runtime import of
// this module into the Vite-bundled renderer would be the one exception,
// pulling data's Node-only dependency graph, better-sqlite3/drizzle-orm/
// octokit, along with it). This copy is the vitest-covered, canonical one.
//
// Both formats carry EVERY stored field, including prev_hash/hash AND `source`,
// so either export is independently re-verifiable offline with nothing but
// packages/core/src/auditChain.ts's verifyAuditChain + a SHA-256 stand-in --
// no database, no this package, required to check a chain's integrity later.
// `source` is load-bearing for that offline check: it selects the hash recipe
// (source-null == the v1 10-field recipe; source-set == v2, with `source`
// folded in) -- omitting it would leave an offline verifier unable to recompute
// the hash of any post-migration-0006 row.
//
// envelopeSnapshot/before/after are re-emitted VERBATIM as the strings
// already stored in SQLite (never JSON.parse'd and re-stringified here) --
// canonicalizeAuditPayload hashes the EXACT stored bytes, so any reformatting
// here would silently produce a string an offline verifier can no longer
// match against the recorded hash.

export interface ExportedAuditEvent {
  id: number;
  /** ISO 8601 -- Date.parse(ts) round-trips exactly to the epoch-ms value that was actually hashed (see AuditEventFields's `ts` doc comment). */
  ts: string;
  actor: string;
  action: string;
  entityRef: string;
  trigger: string;
  envelopeSnapshot: string | null;
  before: string | null;
  after: string | null;
  justification: string | null;
  dataSnapshotId: number | null;
  /** 'msw' | 'github', or null for a legacy row. Load-bearing for offline hash-recipe selection (see file header). */
  source: string | null;
  prevHash: string;
  hash: string;
}

/** Projects one stored row (readAuditChain's own shape) into the export/wire projection above. */
export function toExportedAuditEvent(row: AuditEventRow): ExportedAuditEvent {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
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
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

/** Complete, pretty-printed JSON dump: one array, every stored field, in whatever order the caller passed (readAuditChain's own ascending-by-id order, by convention). */
export function auditChainToJson(events: readonly ExportedAuditEvent[]): string {
  return JSON.stringify(events, null, 2);
}

const CSV_COLUMNS = [
  'id',
  'ts',
  'actor',
  'action',
  'entity_ref',
  'trigger',
  'envelope_snapshot',
  'before',
  'after',
  'justification',
  'data_snapshot_id',
  'source',
  'prev_hash',
  'hash',
] as const;

// RFC 4180 quoting: wrap in quotes and double any embedded quote whenever the
// value contains a comma, quote, or newline -- before/after/envelope_snapshot
// are JSON strings, so they routinely contain all three.
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Every row, every field (including prev_hash/hash) -- one header row + one data row per event, CRLF-terminated (RFC 4180). */
export function auditChainToCsv(events: readonly ExportedAuditEvent[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = events.map((e) =>
    [
      e.id,
      e.ts,
      e.actor,
      e.action,
      e.entityRef,
      e.trigger,
      e.envelopeSnapshot,
      e.before,
      e.after,
      e.justification,
      e.dataSnapshotId,
      e.source,
      e.prevHash,
      e.hash,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header, ...rows].join('\r\n');
}
