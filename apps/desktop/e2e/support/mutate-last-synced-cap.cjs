// Task 4.15 test-ARRANGEMENT helper -- sibling of mutate-last-synced-budget.cjs
// (see that file's header for the full rationale: why this is not a
// production backdoor, and why it must run under
// `ELECTRON_RUN_AS_NODE=1 <electron binary>` rather than plain Node). This
// one flips an included_cap control's `enabled` flag inside the persisted
// `control_snapshot` row, so controls-drift.spec.ts can prove the "⤺ drift —
// reconcile" marker also renders on the Included-usage caps grid (CLAUDE.md
// build brief: "caps cards if cheap") -- not just the ULB/Spending tables.
//
// Usage: <electron binary> mutate-last-synced-cap.cjs <dbPath> <costCenterName> <newEnabled: true|false>
'use strict';

const path = require('node:path');

const [, , dbPath, costCenterName, newEnabledRaw] = process.argv;
if (!dbPath || !costCenterName || !newEnabledRaw) {
  throw new Error('mutate-last-synced-cap: usage: <dbPath> <costCenterName> <newEnabled: true|false>');
}
if (newEnabledRaw !== 'true' && newEnabledRaw !== 'false') {
  throw new Error(`mutate-last-synced-cap: newEnabled must be "true" or "false", got ${JSON.stringify(newEnabledRaw)}`);
}
const newEnabled = newEnabledRaw === 'true';

const dataPkgDir = path.join(__dirname, '..', '..', '..', '..', 'packages', 'data');
const betterSqlite3Path = require.resolve('better-sqlite3', { paths: [dataPkgDir] });
const Database = require(betterSqlite3Path);

const db = new Database(dbPath);
try {
  const row = db.prepare('SELECT id, controls_json FROM control_snapshot ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    throw new Error('mutate-last-synced-cap: no control_snapshot row found -- run Sync Now before arranging drift');
  }

  const controls = JSON.parse(row.controls_json);
  const target = controls.find((c) => c.kind === 'included_cap' && c.costCenterName === costCenterName);
  if (!target) {
    throw new Error(`mutate-last-synced-cap: no persisted included_cap control found for costCenterName=${costCenterName}`);
  }
  target.enabled = newEnabled;

  db.prepare('UPDATE control_snapshot SET controls_json = ? WHERE id = ?').run(JSON.stringify(controls), row.id);
} finally {
  db.close();
}
