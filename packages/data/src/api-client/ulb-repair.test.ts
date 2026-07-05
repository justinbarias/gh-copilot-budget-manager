import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detectUlbRepairCandidates } from '@copilot-budget/core';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG } from '../msw/fixtures/index.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { createGitHubApiClient, type GitHubApiClientConfig } from './github-impl.js';

// Task 4.14 (PRD FR3): pins the exact fixture-derived repair candidates the
// live DEWR budget list produces once it flows through getControls() (the
// SAME read the UI holds -- no dedicated endpoint/bridge method) and core's
// pure detectUlbRepairCandidates. Runs against the SAME MSW server simulation
// mode + e2e attach (CLAUDE.md §7's "one mock, three consumers") -- a broken
// budgets handler, a dropped `simulatedUiHidden` enrichment, or a
// toBudgetControl that failed to carry it through would all break the running
// app's repair banner and show up here.
describe('ULB repair candidates via getControls()', () => {
  let tmpDir: string;
  let db: Db;
  let client: ReturnType<typeof createGitHubApiClient>;

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-ulb-repair-test-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    const config: GitHubApiClientConfig = { enterprise: ENTERPRISE_SLUG, db, source: 'msw' };
    client = createGitHubApiClient(config);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds exactly the 2 DEWR edge fixtures: liam-obrien (display_bug_hidden) and ext-dmorrow (orphaned_zero)', async () => {
    const controls = await client.getControls();
    const candidates = detectUlbRepairCandidates(controls);
    expect(candidates).toEqual([
      {
        kind: 'display_bug_hidden',
        id: 'budget:individual:liam-obrien',
        scope: 'individual',
        entityName: 'liam-obrien',
        reason: expect.stringContaining('invisible'),
      },
      {
        kind: 'orphaned_zero',
        id: 'budget:individual:ext-dmorrow',
        scope: 'individual',
        entityName: 'ext-dmorrow',
        reason: expect.stringContaining('$0'),
      },
    ]);
  });

  it('does not flag any of the other 10 ULB fixtures (universal, both CCULBs, or the 7 other individual overrides)', async () => {
    const controls = await client.getControls();
    const flaggedIds = new Set(detectUlbRepairCandidates(controls).map((c) => c.id));
    expect(flaggedIds.has('budget:individual:liam-obrien')).toBe(true);
    expect(flaggedIds.has('budget:individual:ext-dmorrow')).toBe(true);
    expect(flaggedIds.size).toBe(2);
    // The universal ULB, both CCULBs, and every other individual ULB
    // (ext-pshah $1,900, sam-kelly $5,400, the 5 "controls scale" fixtures)
    // are ordinary, non-zero, non-hidden ULBs -- none should surface.
    expect(flaggedIds.has('budget:universal:dewr')).toBe(false);
    expect(flaggedIds.has('budget:multi_user_cost_center:Workforce Australia Platform')).toBe(false);
    expect(flaggedIds.has('budget:multi_user_cost_center:Data & Evaluation Platform')).toBe(false);
    expect(flaggedIds.has('budget:individual:ext-pshah')).toBe(false);
    expect(flaggedIds.has('budget:individual:sam-kelly')).toBe(false);
  });

  it('never flags a spending-limit or included-usage-cap control (out of ULB scope entirely)', async () => {
    // Defensive: the enterprise/organization/cost_center-scope budgets in the
    // fixture world are Family B (spending limits), and getControls also
    // returns included_cap + cost_center controls -- this asserts the
    // detector's own kind/scope filter genuinely excludes them rather than
    // relying on "they happen not to be $0/hidden" to keep the count at 2.
    const controls = await client.getControls();
    const candidates = detectUlbRepairCandidates(controls);
    expect(candidates.every((c) => ['universal', 'individual', 'multi_user_cost_center'].includes(c.scope))).toBe(true);
  });
});
