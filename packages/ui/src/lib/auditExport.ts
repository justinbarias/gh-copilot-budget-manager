import type { AuditChainEvent } from '@copilot-budget/data';

// Task 8.5 (CLAUDE.md §6.5's export deliverable): the ACTUAL download the
// renderer performs. Deliberately client-side only, per the ratified
// ask-first decision -- no additional bridge method, no Electron save
// dialog, no fs in the renderer. This is the same browser-native
// Blob + <a download> mechanism a future apps/web deployment would use
// unchanged (CLAUDE.md §2's portability rule).
//
// JSON export needs no bespoke serializer at all: every field
// `getAuditChain()` hands back (AuditChainEvent -- including prev_hash/hash,
// and before/after/envelopeSnapshot as the untouched originally-stored
// strings, see that type's doc comment in @copilot-budget/data) is already
// exactly what an offline reader needs, so `JSON.stringify` IS the entire
// serializer.
//
// CSV needs real column/escaping logic, so this file duplicates that one
// piece from packages/data/src/audit/export.ts's `auditChainToCsv` (the
// vitest-covered, canonical copy) rather than importing it at runtime: every
// other file in this package imports `@copilot-budget/data` for TYPES ONLY
// (grep the codebase before changing this) -- a runtime import here would be
// the one exception, and would pull data's Node-only dependency graph
// (better-sqlite3, drizzle-orm, octokit) into the Vite-bundled renderer.
// Keep the column list/order and escaping rule identical to that file if
// either ever changes.

export function auditChainToJson(events: readonly AuditChainEvent[]): string {
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

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function auditChainToCsv(events: readonly AuditChainEvent[]): string {
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

/** Browser-native download: a Blob URL + a transient <a download> click, revoked immediately after. No Electron save dialog, no `fs` (CLAUDE.md §2 portability rule). */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
