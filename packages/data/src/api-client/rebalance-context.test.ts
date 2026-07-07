import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateMeteredRebalance,
  normalCdf,
  runPoolRebalancer,
  type PoolRebalanceContext,
} from '@copilot-budget/core';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/constants.js';
import { resetActiveScenario } from '../msw/scenario-state.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { createGitHubApiClient } from './github-impl.js';
import type { PoolRebalanceContextDto } from './types.js';

// ============================================================================
// Task 6.8 STEP-ONE PROOF -- the bridge's getRebalanceContext (the renderer's
// ONLY data source for the Auto-balance screen) must yield a context that,
// fed to the ACTUAL core engine exactly the way the renderer feeds it
// (rehydrating the ISO date strings), reproduces the engine-proof literals
// pinned in msw/fixtures/scenarios.engine.test.ts BYTE-FOR-BYTE:
//   At-risk: 17 at-risk; envelope segments {reserve 28,350, held 7,500,
//   grants 12,800, slack 7,200} summing to remaining pool 55,850; 7 funded
//   ULB grants + 9 cap-relax rows (unlock 5,000 each); sim 520,000 ->
//   532,800, afterUtil 0.9397.
// This is what proves the screen renders engine truth, not an approximation.
// ============================================================================

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetActiveScenario();
});
afterAll(() => server.close());

// The renderer-side hydration, verbatim (packages/ui/src/screens/AutoBalance/
// poolViewModel.ts does exactly this): ISO date strings -> Dates, everything
// else passes through untouched.
function hydratePoolContext(dto: PoolRebalanceContextDto): PoolRebalanceContext {
  return {
    controls: dto.controls,
    currentUsage: dto.currentUsage,
    projectedUsage: dto.projectedUsage,
    poolTotalCredits: dto.poolTotalCredits,
    poolConsumedCredits: dto.poolConsumedCredits,
    projectedPoolConsumedCredits: dto.projectedPoolConsumedCredits,
    projectedPoolConsumedP90Credits: dto.projectedPoolConsumedP90Credits,
    asOfDate: new Date(`${dto.asOfDate}T00:00:00.000Z`),
    cycleEndDate: new Date(`${dto.cycleEndDate}T00:00:00.000Z`),
  };
}

describe('getRebalanceContext (Task 6.8 bridge assembly)', () => {
  let tmpDir: string;
  let db: Db;
  let client: ReturnType<typeof createGitHubApiClient>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-rebalance-context-test-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    client = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw', baseUrl: GITHUB_API_BASE });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AT-RISK: the assembled pool context run through runPoolRebalancer reproduces the engine-proof literals', async () => {
    await client.setScenario('at-risk');
    const result = await client.getRebalanceContext('pool');
    expect(result.available).toBe(true);
    if (!result.available || result.mode !== 'pool') throw new Error('expected an available pool context');

    // The clock seam anchored the assembly to the scenario's own as-of date.
    expect(result.context.asOfDate).toBe('2026-06-27');
    expect(result.context.cycleEndDate).toBe('2026-06-30');

    const plan = runPoolRebalancer(hydratePoolContext(result.context));

    // Trigger: fires, day 26/30 (3 days out), 17 at-risk (4 blocked).
    expect(plan.trigger.fired).toBe(true);
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([true, true, true]);
    expect(plan.trigger.daysRemaining).toBe(3);
    expect(plan.trigger.atRiskCount).toBe(17);
    expect(plan.trigger.blockedCount).toBe(4);

    // Envelope: segments sum to remaining pool 55,850; 20,000 grantable.
    const a = plan.allocation;
    expect(a.envelope.remainingPoolCredits).toBe(55_850);
    expect(a.envelope.segments).toEqual({ reserve: 28_350, held: 7_500, grants: 12_800, slack: 7_200 });
    expect(a.envelope.envelopeCredits).toBe(20_000);

    // Allocation: 7 funded ULB grants totalling 12,800; 9 cap-relax rows.
    expect(a.grants.length).toBe(7);
    expect(a.fundedCount).toBe(7);
    expect(a.totalGrantedCredits).toBe(12_800);
    expect(a.grants.every((g) => g.status === 'funded')).toBe(true);
    expect(a.capRelax.length).toBe(9);
    expect(a.capRelax.every((r) => r.unlockContributionCredits === 5_000)).toBe(true);

    // Simulation: 520,000 -> 532,800, afterUtil 0.9397, 7 unblocked, ok.
    const s = plan.simulation;
    expect(s.beforeConsumedCredits).toBe(520_000);
    expect(s.afterConsumedCredits).toBe(532_800);
    expect(s.afterUtilization).toBeCloseTo(0.9397, 4);
    expect(s.usersUnblockedCount).toBe(7);
    expect(s.verdict).toBe('ok');
    const expTip = 1 - normalCdf((567_000 - 532_800) / ((545_000 - 520_000) / 1.2816));
    expect(s.tipProbability).toBeCloseTo(expTip, 6);
  });

  it('HEALTHY (the boot default): available, projection mirrors current (no growth), trigger does NOT fire', async () => {
    // No setScenario call -- this is exactly the state the screen boots into.
    const result = await client.getRebalanceContext('pool');
    expect(result.available).toBe(true);
    if (!result.available || result.mode !== 'pool') throw new Error('expected an available pool context');

    expect(result.context.asOfDate).toBe('2026-06-14');
    // Promoted Healthy scalars (ratified 2026-07-07).
    expect(result.context.poolTotalCredits).toBe(567_000);
    expect(result.context.poolConsumedCredits).toBe(189_800);
    expect(result.context.projectedPoolConsumedCredits).toBe(437_800);
    expect(result.context.projectedPoolConsumedP90Credits).toBe(460_000);
    // No-growth contract: the projection IS the assembled current state.
    expect(result.context.projectedUsage).toEqual(result.context.currentUsage);
    expect(result.context.currentUsage.users.length).toBe(81);

    const plan = runPoolRebalancer(hydratePoolContext(result.context));
    expect(plan.trigger.fired).toBe(false);
    // Truthful chips: near-cycle-end UNMET (16 days out), underutilised MET,
    // at-risk MET -- the DEWR world has 10 standing at-risk entities even on
    // a healthy day (the cap-bound Payments team's 8 members + the CC entity,
    // all pinned at the 56,000 cap, plus ext-dmorrow's $0-ULB block), but the
    // trigger needs all three conditions, so it does NOT fire.
    expect(plan.trigger.conditions.map((c) => c.met)).toEqual([false, true, true]);
    expect(plan.trigger.daysRemaining).toBe(16);
    expect(plan.trigger.atRiskCount).toBe(10);
    expect(plan.trigger.blockedCount).toBe(10);
    // No growth projected -> no grantable deltas anywhere: zero ULB grants,
    // and the 9 cap-relax rows each unlock 0 (demand == draw == cap).
    expect(plan.allocation.grants.length).toBe(0);
    expect(plan.allocation.capRelax.length).toBe(9);
    expect(plan.allocation.capRelax.every((r) => r.unlockContributionCredits === 0)).toBe(true);
    expect(plan.allocation.envelope.segments).toEqual({ reserve: 28_350, held: 0, grants: 0, slack: 348_850 });
    expect(plan.simulation.beforeConsumedCredits).toBe(437_800);
    expect(plan.simulation.afterConsumedCredits).toBe(437_800);
  });

  it('METERED scenario: pool mode is unavailable; metered mode assembles a context the metered engine funds 2 grants from', async () => {
    await client.setScenario('metered');

    const pool = await client.getRebalanceContext('pool');
    expect(pool).toEqual({ available: false, reason: 'the active scenario ("metered") carries no pool-rebalancer inputs' });

    const result = await client.getRebalanceContext('metered');
    expect(result.available).toBe(true);
    if (!result.available || result.mode !== 'metered') throw new Error('expected an available metered context');
    const plan = evaluateMeteredRebalance({
      controls: result.context.controls,
      currentUsage: result.context.currentUsage,
      projectedUsage: result.context.projectedUsage,
      entities: result.context.entities,
      meteredPhaseActive: result.context.meteredPhaseActive,
      reserveCredits: result.context.reserveCredits,
    });
    expect(plan.trigger.fired).toBe(true);
    expect(plan.fundedCount).toBe(2);
    expect(plan.envelope.grantedCredits).toBe(6_000);
  });

  it('refuses in live mode before contacting anything', async () => {
    const live = createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'github', baseUrl: GITHUB_API_BASE, nowDate: '2026-06-27' });
    expect(await live.getRebalanceContext('pool')).toEqual({ available: false, reason: 'live mode' });
    expect(await live.getRebalanceContext('metered')).toEqual({ available: false, reason: 'live mode' });
  });

  it('metered mode is unavailable on a pool-only scenario (healthy)', async () => {
    const result = await client.getRebalanceContext('metered');
    expect(result).toEqual({ available: false, reason: 'the active scenario ("healthy") carries no metered-rebalancer inputs' });
  });
});
