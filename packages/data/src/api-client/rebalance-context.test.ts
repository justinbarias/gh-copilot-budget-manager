import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  evaluateMeteredRebalance,
  normalCdf,
  runPoolRebalancer,
  type ForecastResult,
  type PoolRebalanceContext,
} from '@copilot-budget/core';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG, GITHUB_API_BASE } from '../msw/fixtures/constants.js';
import { resetActiveScenario } from '../msw/scenario-state.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { syncNow as ingestSnapshot } from '../sync/sync-now.js';
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

  it('metered mode is unavailable on a pool-only scenario (healthy)', async () => {
    const result = await client.getRebalanceContext('metered');
    expect(result).toEqual({ available: false, reason: 'the active scenario ("healthy") carries no metered-rebalancer inputs' });
  });
});

// ============================================================================
// Live-context wiring (2026-07-09 round; maintainer decision: BOTH modes'
// dry-run runs from live data, STRICTLY SIMULATE-ONLY). These live-shaped
// worlds use the maintainer's real tenant magnitudes: a 672,000-credit pool,
// ZERO ULBs and caps disabled (the pool "no levers" outcome), and a metered
// estate with an over-threshold hard-stop cost-center cap + enterprise
// headroom (a real proposal). A source-'github' client still hits MSW (the
// tenant-smoke precedent) -- how live plumbing is proven pre-PAT.
// ============================================================================
describe('getRebalanceContext live branch', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-rebalance-live-test-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function liveClient(): ReturnType<typeof createGitHubApiClient> {
    return createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'github', baseUrl: GITHUB_API_BASE, nowDate: '2026-07-09' });
  }

  // Minimal, structurally-valid stored forecast whose series covers the as-of
  // day (2026-07-09) and the cycle end (2026-07-31) with pinned scalars.
  function persistLiveEnterpriseForecast(series: Array<{ date: string; p50: number; p90: number; allowance: number }>): void {
    const result: ForecastResult = {
      dailySeries: series.map((p) => ({ date: p.date, p50Cumulative: p.p50, p90Cumulative: p.p90, allowanceLine: p.allowance, provisional: false })),
      exhaustionDate: null,
      exhaustionDateP90: null,
      runwayDays: null,
      projectedMeteredCredits: 0,
      projectedMeteredDollars: 0,
      basis: { runRate: 0, weekdayIndices: [1, 1, 1, 1, 1, 1, 1], settlingWindowDays: 14, asOfDate: '2026-07-09', dailyVariance: 0 },
    };
    ingestSnapshot(db, 'github', {
      entity: ENTERPRISE_SLUG,
      usageItems: [],
      creditsUsedItems: [],
      costCenters: [],
      costCenterMembers: [],
      licenses: [],
      controls: [],
      forecasts: [{ scope: 'enterprise', entityId: null, computedAt: '2026-07-09', result, mape: null }],
    });
  }

  // The maintainer's live-shaped wire estate. Pool variant: zero ULBs, caps
  // disabled, one CC with July MTD pool draw. Metered variant adds a
  // hard-stop cost-center spending limit at 94% and enterprise headroom.
  function useLiveWorld(opts: { ccBudgets: boolean }): void {
    server.use(
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/cost-centers`, () =>
        HttpResponse.json({
          costCenters: [
            { id: 'cc-alpha', name: 'CC Alpha', state: 'active', ai_credit_pool_enabled: false, resources: [] },
            { id: 'cc-beta', name: 'CC Beta', state: 'active', ai_credit_pool_enabled: false, resources: [] },
          ],
        }),
      ),
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/budgets`, () =>
        HttpResponse.json({
          budgets: [
            {
              id: 'bud-ent-live',
              budget_type: 'BundlePricing',
              budget_product_sku: 'ai_credits',
              budget_scope: 'enterprise',
              budget_entity_name: ENTERPRISE_SLUG,
              budget_amount: 2000, // $2,000 -> 200,000 credits
              prevent_further_usage: false,
              budget_alerting: { will_alert: true, alert_recipients: [] },
            },
            ...(opts.ccBudgets
              ? [
                  {
                    id: 'bud-cc-alpha',
                    budget_type: 'BundlePricing',
                    budget_product_sku: 'ai_credits',
                    budget_scope: 'cost_center',
                    budget_entity_name: 'CC Alpha',
                    budget_amount: 500, // 50,000 credits, hard-stop -> a metered cap
                    prevent_further_usage: true,
                    budget_alerting: { will_alert: false, alert_recipients: [] },
                  },
                  {
                    id: 'bud-cc-beta',
                    budget_type: 'BundlePricing',
                    budget_product_sku: 'ai_credits',
                    budget_scope: 'cost_center',
                    budget_entity_name: 'CC Beta',
                    budget_amount: 500,
                    prevent_further_usage: true,
                    budget_alerting: { will_alert: false, alert_recipients: [] },
                  },
                ]
              : []),
          ],
        }),
      ),
      http.get(`${GITHUB_API_BASE}/enterprises/:enterprise/settings/billing/usage`, ({ request }) => {
        const ccId = new URL(request.url).searchParams.get('cost_center_id');
        const item = (over: Record<string, unknown>) => ({
          date: '2026-07-01T00:00:00Z',
          product: 'copilot',
          sku: 'Copilot AI Credits',
          quantity: 0,
          unitType: 'credits',
          pricePerUnit: 0.01,
          grossAmount: 0,
          discountAmount: 0,
          netAmount: 0,
          organizationName: 'dewr',
          ...over,
        });
        if (ccId === 'cc-alpha') {
          // Pool world: July MTD pool draw $3,825.88 -> 382,588 credits.
          // Metered world: additionally $480 metered -> 48,000 credits (96%
          // of Alpha's 50,000 hard-stop cap, >= the 95% at-risk threshold).
          return HttpResponse.json({
            usageItems: [item({ quantity: 382_588, discountAmount: 3825.88, grossAmount: 4305.88, netAmount: opts.ccBudgets ? 480 : 0 })],
          });
        }
        if (ccId === 'cc-beta' && opts.ccBudgets) {
          // The donor: $50 metered -> 5,000 credits (10% of its cap).
          return HttpResponse.json({ usageItems: [item({ quantity: 5_000, netAmount: 50, grossAmount: 50 })] });
        }
        return HttpResponse.json({ usageItems: [] });
      }),
    );
  }

  it('pool: never-synced live world gates honestly with the run-Sync-first reason (no fabricated numbers)', async () => {
    const result = await liveClient().getRebalanceContext('pool');
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toMatch(/run Sync now first/);
  });

  it('pool: a stale synced forecast (series does not cover today) gates honestly', async () => {
    persistLiveEnterpriseForecast([{ date: '2026-06-14', p50: 1, p90: 1, allowance: 567_000 }]);
    const result = await liveClient().getRebalanceContext('pool');
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toMatch(/does not cover today/);
    expect(result.reason).toContain('2026-07-09'); // the stale forecast's computedAt is named
  });

  it('pool: assembles the live context from forecast + live reads; the zero-ULB estate yields the honest "no levers" outcome', async () => {
    useLiveWorld({ ccBudgets: false });
    persistLiveEnterpriseForecast([
      { date: '2026-07-09', p50: 382_588, p90: 400_000, allowance: 672_000 },
      { date: '2026-07-31', p50: 560_000, p90: 640_000, allowance: 672_000 },
    ]);

    const result = await liveClient().getRebalanceContext('pool');
    expect(result.available).toBe(true);
    if (!result.available || result.mode !== 'pool') throw new Error('expected an available pool context');

    // Hand-computed context scalars from the authored forecast + usage world.
    expect(result.context.poolTotalCredits).toBe(672_000); // allowanceLine at 2026-07-09
    expect(result.context.poolConsumedCredits).toBe(382_588); // round(3825.88 x 100), July MTD
    expect(result.context.projectedPoolConsumedCredits).toBe(560_000); // p50 at cycle end
    expect(result.context.projectedPoolConsumedP90Credits).toBe(640_000);
    expect(result.context.asOfDate).toBe('2026-07-09');
    expect(result.context.cycleEndDate).toBe('2026-07-31'); // last day of the as-of month
    // No live growth projection exists -> projectedUsage mirrors current (the
    // documented no-growth contract).
    expect(result.context.projectedUsage).toEqual(result.context.currentUsage);

    // The real engine over the real context: zero ULBs -> nothing at risk,
    // nothing grantable, trigger not fired (projected 560,000 < 672,000, not
    // near cycle end). The screen renders this honestly with the no-ULB note.
    const plan = runPoolRebalancer(hydratePoolContext(result.context));
    expect(plan.trigger.fired).toBe(false);
    expect(plan.trigger.atRiskCount).toBe(0);
    expect(plan.allocation.grants).toEqual([]);
    // Q5's recorded 5% reserve (2026-07-07 decision) applies to the live pool
    // path via core's reservePct default -- buildLivePoolContext passes no
    // params, so the envelope holds back round(0.05 x 672,000) = 33,600
    // (validator-added pin, reserve ruling 2026-07-09).
    expect(plan.allocation.envelope.reserveCredits).toBe(33_600);
  });

  it('metered: assembles a live context (no Sync gate needed) and the engine produces a REAL proposal from the maintainer-shaped estate', async () => {
    useLiveWorld({ ccBudgets: true });

    const result = await liveClient().getRebalanceContext('metered');
    expect(result.available).toBe(true);
    if (!result.available || result.mode !== 'metered') throw new Error('expected an available metered context');

    // Entities derived from the live control estate: the two cost centers
    // holding cost_center spending limits (no individual ULBs exist).
    expect(result.context.entities).toEqual([
      { kind: 'cost_center', costCenterName: 'CC Alpha' },
      { kind: 'cost_center', costCenterName: 'CC Beta' },
    ]);
    // Enterprise metered = 48,000 (Alpha) + 5,000 (Beta) = 53,000 -> active.
    expect(result.context.currentUsage.enterprise.meteredCreditsUsed).toBe(53_000);
    expect(result.context.meteredPhaseActive).toBe(true);
    // Metered reserve = 0 (validator ruling, 2026-07-09): Q5's recorded 5%
    // reserve maps unambiguously onto the POOL engine (core's reservePct
    // default, applied since buildLivePoolContext passes no params) but the
    // metered engine takes only ABSOLUTE credits with no percent semantics --
    // "5% of what" is genuinely ambiguous, so 0 stands until Task 7.2's
    // policy store names the metered reserve (5% is its default candidate).
    expect(result.context.reserveCredits).toBe(0);

    // The real engine over the real context: Alpha sits at 96% of its 50,000
    // hard-stop cap (>= core's 95% AT_RISK_THRESHOLD_PCT); the enterprise
    // budget (200,000) has 147,000 of headroom above the 0 reserve -> all
    // three trigger conditions met, and the proposal funds Alpha.
    const plan = evaluateMeteredRebalance({
      controls: result.context.controls,
      currentUsage: result.context.currentUsage,
      projectedUsage: result.context.projectedUsage,
      entities: result.context.entities,
      meteredPhaseActive: result.context.meteredPhaseActive,
      reserveCredits: result.context.reserveCredits,
    });
    expect(plan.trigger.fired).toBe(true);
    expect(plan.trigger.atRiskCount).toBe(1);
    expect(plan.fundedCount).toBeGreaterThan(0);
  });

  it('NO-MUTATION proof: both live context assemblies issue GETs only -- never a POST/PATCH/DELETE', async () => {
    useLiveWorld({ ccBudgets: true });
    persistLiveEnterpriseForecast([
      { date: '2026-07-09', p50: 382_588, p90: 400_000, allowance: 672_000 },
      { date: '2026-07-31', p50: 560_000, p90: 640_000, allowance: 672_000 },
    ]);

    const methods: string[] = [];
    const listener = ({ request }: { request: Request }): void => {
      if (new URL(request.url).hostname === 'api.github.com') methods.push(request.method);
    };
    server.events.on('request:start', listener);
    try {
      const client = liveClient();
      expect((await client.getRebalanceContext('pool')).available).toBe(true);
      expect((await client.getRebalanceContext('metered')).available).toBe(true);
    } finally {
      server.events.removeListener('request:start', listener);
    }
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === 'GET')).toBe(true);
  });
});
