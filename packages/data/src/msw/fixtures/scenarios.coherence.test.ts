import { Octokit } from 'octokit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UsageState } from '@copilot-budget/core';
import { assembleUsageState, fetchLiveControls } from '../../write/live-state.js';
import { server } from '../server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from './constants.js';
import { METERED_SCENARIO_INPUTS, POOL_SCENARIO_INPUTS } from './scenarios.js';
import { SCENARIO_SUMMARIES, resetActiveScenario, setActiveScenarioId, type ScenarioId } from '../scenario-state.js';

// ============================================================================
// WIRE<->ENGINE COHERENCE (the regression guard that was MISSING and would have
// caught the Checkpoint-6 Defect 1: the At-risk scenario's MSW wire summed to
// ~95,000 pool consumed while its exported engine scalar said 511,150 -- one
// scenario, two contradictory worlds. Every alternate now authors its wire so
// the ASSEMBLED state (the SAME assembleUsageState rollup the Overview burn-down
// and the Auto-balance pane both read) AGREES with the scalars the engine-proof
// test pins. This test asserts that agreement directly.)
//
//   assembled Σ(per-CC poolCreditsUsed) == POOL_SCENARIO_INPUTS.poolConsumedCredits
//     -- Σ discount over the in-cycle CC-aggregate rows IS the Overview
//        burn-down's cycle-to-date figure, so this pins burn-down == engine.
//   assembled enterprise.meteredCreditsUsed == the metered scenario's
//     projected enterprise metered (current == projected in that fixture).
// ============================================================================

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetActiveScenario();
});
afterAll(() => server.close());

const octokit = new Octokit({ baseUrl: GITHUB_API_BASE });
const asOfOf = (id: ScenarioId) => new Date(`${SCENARIO_SUMMARIES.find((s) => s.id === id)!.asOfDate}T00:00:00.000Z`);

async function assembled(id: ScenarioId): Promise<UsageState> {
  setActiveScenarioId(id);
  const asOf = asOfOf(id);
  const live = await fetchLiveControls(octokit, ENTERPRISE_SLUG, asOf);
  return assembleUsageState(octokit, ENTERPRISE_SLUG, live.costCenterIdByName, asOf);
}

const sumCcPool = (u: UsageState) => u.costCenters.reduce((s, cc) => s + cc.poolCreditsUsed, 0);

describe('scenario wire <-> engine-scalar coherence', () => {
  // The three pool scenarios: assembled pool consumed == the exported scalar.
  it.each([
    ['healthy', 189_800],
    ['at-risk', 511_150],
    ['surplus', 16_000],
    // Long tail: Σ per-CC pool == the generator's Σ per-seat cycle draw
    // (usage-long-tail.ts; a calm day-13 world, ~22.5% of the 567,000 pool).
    ['long-tail', 127_398],
  ] as const)('%s: assembled Σ(per-CC pool) == poolConsumedCredits (%d)', async (id, expected) => {
    const usage = await assembled(id);
    expect(sumCcPool(usage)).toBe(expected);
    expect(POOL_SCENARIO_INPUTS[id]!.poolConsumedCredits).toBe(expected);
    // Coherence is the point: the wire figure and the engine scalar are equal.
    expect(sumCcPool(usage)).toBe(POOL_SCENARIO_INPUTS[id]!.poolConsumedCredits);
  });

  it('at-risk: Payments Integrity stays the designed cap-bound draw (55,000 of a 56,000 cap)', async () => {
    const usage = await assembled('at-risk');
    const payments = usage.costCenters.find((cc) => cc.costCenterName === 'Payments Integrity Engineering')!;
    expect(payments.poolCreditsUsed).toBe(55_000);
    // Every OTHER cost center is strictly under 95% of its cap (so none reads as
    // an at-risk / cap-bound CC entity -- the engine test's 17 stays 17).
    const capByName: Record<string, number> = {
      'Workforce Australia Platform': 168_000,
      'Employer & Provider Portals': 112_000,
      'Data & Evaluation Platform': 63_000,
      'Cyber & Identity Services': 77_000,
      'Corporate Systems': 91_000,
    };
    for (const cc of usage.costCenters) {
      if (cc.costCenterName === 'Payments Integrity Engineering') continue;
      const cap = capByName[cc.costCenterName!];
      if (cap === undefined) continue;
      expect(cc.poolCreditsUsed / cap).toBeLessThan(0.95);
    }
  });

  it('metered: pool 100% consumed (567,000); assembled enterprise metered == projected (480,000)', async () => {
    const usage = await assembled('metered');
    // Pool is 100% consumed -- every CC sits at its cap, Σ == the 567,000 pool.
    expect(sumCcPool(usage)).toBe(567_000);
    const projected = METERED_SCENARIO_INPUTS['metered']!.projectedUsage.enterprise.meteredCreditsUsed;
    expect(projected).toBe(480_000);
    expect(usage.enterprise.meteredCreditsUsed).toBe(480_000);
    const dataEval = usage.costCenters.find((cc) => cc.costCenterName === 'Data & Evaluation Platform')!;
    expect(dataEval.meteredCreditsUsed).toBe(24_500);
    expect(dataEval.poolCreditsUsed).toBe(63_000); // == cap, exhausted
  });

  it('long-tail: per-CC pool is the members\' cycle draw, every CC far under its cap (no cap-bound team), no metered', async () => {
    const usage = await assembled('long-tail');
    // Per-CC pool draws (Σ each CC's members' generated cycle credits).
    const byName = new Map(usage.costCenters.map((cc) => [cc.costCenterName, cc.poolCreditsUsed] as const));
    expect(byName.get('Workforce Australia Platform')).toBe(40_807);
    expect(byName.get('Employer & Provider Portals')).toBe(22_421);
    expect(byName.get('Payments Integrity Engineering')).toBe(14_733);
    expect(byName.get('Data & Evaluation Platform')).toBe(13_299);
    expect(byName.get('Cyber & Identity Services')).toBe(19_242);
    expect(byName.get('Corporate Systems')).toBe(16_896);
    // Calm world: every CC well under 95% of its included-usage cap (< 27%),
    // so none is a cap-bound / at-risk CC entity.
    const capByName: Record<string, number> = {
      'Workforce Australia Platform': 168_000,
      'Employer & Provider Portals': 112_000,
      'Payments Integrity Engineering': 56_000,
      'Data & Evaluation Platform': 63_000,
      'Cyber & Identity Services': 77_000,
      'Corporate Systems': 91_000,
    };
    for (const cc of usage.costCenters) {
      const cap = capByName[cc.costCenterName!];
      if (cap === undefined) continue;
      expect(cc.poolCreditsUsed / cap).toBeLessThan(0.3);
    }
    // Pool phase -- no metered draw anywhere.
    expect(usage.enterprise.meteredCreditsUsed).toBe(0);
  });
});
