// Task 4.15 test-ARRANGEMENT helper only -- not a production code path, and
// not imported by any app source. It exists so controls-drift.spec.ts can
// arrange a believable "last-synced snapshot disagrees with a fresh live
// read" scenario against a deliberately STATELESS MSW mock (CLAUDE.md §7:
// the mock resets to fixtures every run and never actually drifts on its
// own). It mutates ONE budget control's `amountCredits` inside the most
// recent `control_snapshot` row's `controls_json` blob directly via SQL,
// bypassing packages/data/src/sync/sync-now.ts -- the ONLY writer of that
// table in every real code path. This mirrors packages/data/src/audit/
// writer.test.ts's own "directly UPDATE a stored column, bypassing the
// writer" tamper-test precedent (there: forging an audit_event's actor to
// prove hash-chain tamper detection; here: forging a stale sync baseline to
// prove browse-time drift detection) -- an established pattern in this repo
// for exercising append-only tables' consumers, not a new kind of backdoor.
//
// Must run under Electron's OWN bundled Node (ELECTRON_RUN_AS_NODE=1), never
// plain system Node: apps/desktop's `e2e` script's `rebuild:electron`
// pre-step (root CLAUDE.md's better-sqlite3 ABI note) leaves the ONE shared
// better-sqlite3 native module compiled for Electron's ABI for the whole
// `pnpm e2e` run -- requiring it from plain Node here would throw
// NODE_MODULE_VERSION mismatch. apps/desktop doesn't depend on
// better-sqlite3 directly (only transitively via @copilot-budget/data), so
// it's resolved explicitly against that package's directory below rather
// than a plain `require('better-sqlite3')` (which would fail to resolve from
// this file's own node_modules chain).
//
// Usage: <electron binary> mutate-last-synced-budget.cjs <dbPath> <scope> <entityName> <newAmountCredits>
'use strict';

const path = require('node:path');

const [, , dbPath, scope, entityName, newAmountCreditsRaw] = process.argv;
if (!dbPath || !scope || !entityName || !newAmountCreditsRaw) {
  throw new Error('mutate-last-synced-budget: usage: <dbPath> <scope> <entityName> <newAmountCredits>');
}
const newAmountCredits = Number(newAmountCreditsRaw);
if (!Number.isFinite(newAmountCredits)) {
  throw new Error(`mutate-last-synced-budget: newAmountCredits must be a finite number, got ${JSON.stringify(newAmountCreditsRaw)}`);
}

const dataPkgDir = path.join(__dirname, '..', '..', '..', '..', 'packages', 'data');
const betterSqlite3Path = require.resolve('better-sqlite3', { paths: [dataPkgDir] });
const Database = require(betterSqlite3Path);

const db = new Database(dbPath);
try {
  const row = db.prepare('SELECT id, controls_json FROM control_snapshot ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    throw new Error('mutate-last-synced-budget: no control_snapshot row found -- run Sync Now before arranging drift');
  }

  const controls = JSON.parse(row.controls_json);
  const target = controls.find((c) => c.kind === 'budget' && c.scope === scope && c.entityName === entityName);
  if (!target) {
    throw new Error(`mutate-last-synced-budget: no persisted budget control found for scope=${scope} entityName=${entityName}`);
  }
  target.amountCredits = newAmountCredits;

  db.prepare('UPDATE control_snapshot SET controls_json = ? WHERE id = ?').run(JSON.stringify(controls), row.id);
} finally {
  db.close();
}
