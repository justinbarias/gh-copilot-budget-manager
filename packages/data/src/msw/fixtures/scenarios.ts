import type { EntityRef, UsageState } from '@copilot-budget/core';
import { BUDGETS, type Budget } from './budgets.js';
import { COST_CENTERS, COST_CENTER_RESOURCES } from './costCenters.js';
import { BUDGET_IDS, COST_CENTER_IDS, ENTERPRISE_SLUG } from './constants.js';
import { SEATS } from './licenses.js';
import { CREDITS_USED_ITEMS, USAGE_ITEMS, type CreditsUsedItem, type UsageItem } from './usage.js';
import { getActiveScenarioId, type ScenarioId } from '../scenario-state.js';

// ============================================================================
// Task 6.7 -- SCENARIO FIXTURE DATA + the engine inputs the rebalancers prove
// against. The mechanism/metadata lives in ../scenario-state.ts; this module
// owns (a) the MSW-servable wire fixtures per scenario (getActiveFixtures) and
// (b) the assembled rebalancer inputs the engine-proof tests
// (scenarios.engine.test.ts) pin outcomes against.
//
// DESIGN (documented so the 6.8/6.9 UI builder and the validator can re-derive):
//   - 'healthy' is the DEWR world, byte-identical: its wire IS the committed
//     arrays; its rebalancer `currentUsage`/`controls` come from the real
//     assembleUsageState/fetchLiveControls rollup (the test asserts this).
//   - The three alternates REUSE the DEWR roster (SEATS), cost centers, and
//     memberships, and the DEWR budgets ('surplus' drops the $0 ULB so
//     ext-dmorrow is not a standing block, and APPENDS four scenario-local
//     500-credit contractor ULBs so its at-risk cohort is exactly those four).
//     They differ ONLY in usage + dates,
//     authored as a compact `ScenarioSeed` and expanded to wire by `buildWire`
//     -- which is the EXACT inverse of live-state.ts's assembleUsageState, so
//     `assembleUsageState(wire) === currentUsage` round-trips (proven in-test).
//   - The rebalancer also needs a PROJECTION and pool/metered scalars, which no
//     current-usage wire carries (a forecast produces them). The engines are
//     projection/asOf-EXPLICIT by design (they never run a forecast themselves),
//     so each scenario carries them here as `poolInputs`/`meteredInputs` -- the
//     same inputs 6.8/6.9 will thread into the Auto-balance screen.
//
// COHERENCE (per-scenario equations are documented at each seed below).
// ============================================================================

// --- login -> cost-center id, seat id (built once from the roster) ----
const CC_ID_BY_LOGIN: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [ccId, resources] of Object.entries(COST_CENTER_RESOURCES)) {
    for (const r of resources) if (r.type === 'User') map[r.name] = ccId;
  }
  return map;
})();

const SEAT_ID_BY_LOGIN: Record<string, string> = Object.fromEntries(
  SEATS.map((s) => [s.assignee.login, String(s.assignee.id)]),
);

// --- the compact seed a scenario authors (a transformation of the roster) ----

interface SeedUser {
  readonly login: string;
  /** cycle-to-date pool draw (credits). */
  readonly pool: number;
  /** cycle-to-date metered spend (credits); default 0. */
  readonly metered?: number;
}

interface ScenarioSeed {
  /** In-cycle date the per-user metrics/metered rows carry (weekday, inside cycleBounds(asOf)). */
  readonly date: string;
  readonly users: readonly SeedUser[];
  /** Per-CC aggregate POOL draw (billing discount rows, user_login null), by CC id. */
  readonly ccPool: Readonly<Record<string, number>>;
  /** Per-CC aggregate SHARED metered (billing net rows, user_login null), by CC id. */
  readonly ccMetered?: Readonly<Record<string, number>>;
}

interface ScenarioWire {
  readonly budgets: readonly Budget[];
  readonly costCenters: typeof COST_CENTERS;
  readonly costCenterResources: typeof COST_CENTER_RESOURCES;
  readonly seats: typeof SEATS;
  readonly usageItems: readonly UsageItem[];
  readonly creditsUsedItems: readonly CreditsUsedItem[];
}

// ---------------------------------------------------------------------------
// Defect 2(a) fix (Checkpoint-6 maintainer review): the CC-aggregate BILLING
// rows -- the ones that drive BOTH the Overview burn-down (Σ discount_amount)
// AND the persisted enterprise forecast's daily series (Σ quantity) -- are
// spread across EVERY June weekday from day 1 (Jun 2) through day 25 (Jun 26),
// not stamped on a single date. Before this fix the alternates carried one
// Jun-15 (day 14) billing row, so the Forecast screen's last-actual marker
// stopped at day 14 while the header read "Day 26 of 30" (and runway read a
// nonsensical ~87 days). With dense daily rows the marker lands at day 25 and
// runway/exhaustion become story-consistent. Weekends carry no row (the DEWR
// world's existing convention -- fixtures/README.md coherence eq. #2), and
// Jun 1 (cycle day 0) is intentionally absent so the burn-down starts at 0.
// The three alternates all sit at asOfDate 2026-06-27 (day 26/30).
const ALT_CYCLE_WEEKDAYS: readonly string[] = [
  '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
  '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12',
  '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19',
  '2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26',
];

// Split an exact integer `total` into one non-negative credit amount per
// weekday, summing to `total` EXACTLY (near-even: the first `remainder` days
// carry one extra credit). Deterministic -- no rounding drift, no Math.random.
function splitDaily(total: number, days: readonly string[]): Map<string, number> {
  const n = days.length;
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  const out = new Map<string, number>();
  days.forEach((d, i) => out.set(d, base + (i < remainder ? 1 : 0)));
  return out;
}

// buildWire is the exact inverse of assembleUsageState (live-state.ts):
//   per-user TOTAL  = ai_credits_used (metrics report) = pool + metered
//   per-user METERED= Σ net_amount over that login's billing rows
//   per-user POOL   = total - metered
//   per-CC POOL     = Σ discount_amount over that CC's billing rows (Σ daily)
//   per-CC METERED  = Σ net_amount over that CC's billing rows (shared + per-user)
//   enterprise METERED = Σ net_amount over all in-cycle billing rows
// so assembleUsageState(buildWire(seed)) reproduces the seed exactly -- the
// daily split preserves each per-CC total, so the round-trip still holds.
function buildWire(seed: ScenarioSeed): { usageItems: UsageItem[]; creditsUsedItems: CreditsUsedItem[] } {
  const { date } = seed;
  const creditsUsedItems: CreditsUsedItem[] = seed.users.map((u) => ({
    date,
    user_id: SEAT_ID_BY_LOGIN[u.login] ?? '0',
    user_login: u.login,
    ai_credits_used: u.pool + (u.metered ?? 0),
  }));

  const usageItems: UsageItem[] = [];
  // CC-aggregate POOL rows: spread daily across the cycle's weekdays so the
  // burn-down + forecast series are dense through day 25 (Defect 2(a)).
  for (const [ccId, pool] of Object.entries(seed.ccPool)) {
    for (const [day, credits] of splitDaily(pool, ALT_CYCLE_WEEKDAYS)) {
      if (credits <= 0) continue;
      usageItems.push({
        date: day,
        product: 'copilot',
        sku: 'ai_credits',
        cost_center_id: ccId,
        user_login: null,
        quantity: credits,
        gross_amount: credits / 100,
        discount_amount: credits / 100,
        net_amount: 0,
      });
    }
  }
  // CC-aggregate SHARED metered rows: spread daily too, same reason.
  for (const [ccId, metered] of Object.entries(seed.ccMetered ?? {})) {
    for (const [day, credits] of splitDaily(metered, ALT_CYCLE_WEEKDAYS)) {
      if (credits <= 0) continue;
      usageItems.push({
        date: day,
        product: 'copilot',
        sku: 'ai_credits',
        cost_center_id: ccId,
        user_login: null,
        quantity: credits,
        gross_amount: credits / 100,
        discount_amount: 0,
        net_amount: credits / 100,
      });
    }
  }
  // Per-user metered rows stay on the single authored date (small, and the
  // enterprise metered rollup only cares about their Σ, not their daily shape).
  for (const u of seed.users) {
    if (!u.metered) continue;
    usageItems.push({
      date,
      product: 'copilot',
      sku: 'ai_credits',
      cost_center_id: CC_ID_BY_LOGIN[u.login] ?? null,
      user_login: u.login,
      quantity: u.metered,
      gross_amount: u.metered / 100,
      discount_amount: 0,
      net_amount: u.metered / 100,
    });
  }
  return { usageItems, creditsUsedItems };
}

// ===========================================================================
// Cost-center NAMES (must equal CostCenter.name -- resolvers key by name).
// ===========================================================================
const PAYMENTS = 'Payments Integrity Engineering';
const DATA_EVAL = 'Data & Evaluation Platform';
const CYBER = 'Cyber & Identity Services';
const CORPORATE = 'Corporate Systems';
const WORKFORCE = 'Workforce Australia Platform';

// ===========================================================================
// AT-RISK (pool phase, day 26/30 = 2026-06-27, cycleEnd 2026-06-30).
//
// Story: Corporate Systems (universal 4,600 ULB, no CCULB) has a blocked +
// approaching cohort; Payments Integrity is a cap-bound team (its cap-hit team
// is the relax branch); ext-dmorrow's standing $0-ULB block persists. A modest
// non-at-risk Corporate cohort carries per-user projected draw so the envelope's
// `held` segment is nonzero (engine-validator hazard #1).
//
// Universal ULB 4,600. cohorts (per-user pool, projected total):
//   BLOCKED   x3 (karen-fox, ali-rezaei, josh-bright):   4,600 -> 7,000  (grant 2,400)
//   APPROACH  x4 (mia-larsson, tom-becker, wei-sun, colin-hurst): 4,400 -> 6,000 (grant 1,400)
//   HELD      x5 (blake-ferris, noor-jaber, gina-lombardi, ext-rknott, devi-anand):
//                                                        1,000 -> 2,500 (held +1,500 each)
//   ext-dmorrow: $0 ULB, 0 usage -> standing blocked (grant 0, not fundable)
//   COMFORTABLE x21: 2,500 each (54% of the 4,600 universal ULB -> never at-risk),
//     drawn from otherwise-idle Workforce/Employer/Cyber seats so the Users
//     screen reads as a busy month rather than 12 lonely rows. None carries an
//     individual override or a sub-2,632 ULB, so 2,500 is always < 95% of the
//     effective ULB -> none enters the at-risk set (engine test pins 17).
// Cap-bound team Payments Integrity: CC pool 55,000 -> 61,000 vs cap 56,000
//   (8 members carry 0 individual usage, so each resolves cap-bound; +1 CC entity).
//
// WIRE<->ENGINE COHERENCE (Defect 1 fix -- Checkpoint-6 maintainer review).
// The CC-aggregate pool draw now SUMS to the engine's poolConsumedCredits
// scalar (511,150) so the Overview burn-down (Σ discount = 511,150 = 90.1% of
// 567,000) tells the SAME at-risk story the Auto-balance envelope math does --
// previously the wire summed to only 95,000 ("how is that at risk?"). Every CC
// stays UNDER its included cap except Payments (the designed cap-bound team),
// and each non-Payments CC keeps > 8,000 headroom so none reads as amber/
// cap-bound (utilisation < 95% -> not an at-risk CC entity):
//   workforce 152,000 / 168,000   (headroom 16,000)
//   employer  100,000 / 112,000   (headroom 12,000)
//   dataEval   54,000 /  63,000   (headroom  9,000)
//   cyber      68,000 /  77,000   (headroom  9,000)
//   corporate  82,150 /  91,000   (headroom  8,850)
//   capBound   55,000 /  56,000   (headroom  1,000 -- cap-bound, projected 61,000)
//   Σ = 511,150 == poolConsumedCredits.   (Σ caps still = pool 567,000.)
// Per-CC member burns (metrics report) stay < the CC-aggregate draw -- the gap
// is shared/automated draw (service accounts, CI, code-review Actions), maximal
// here by design (README.md coherence eq. #3): an at-risk world's 90% draw is
// dominated by non-attributable consumption, not by the named cohort's 36,400.
//
// Pool scalars: total 567,000; consumed 511,150 -> remaining_pool 55,850;
//   reserve = round(0.05*567,000) = 28,350; held = 5 * 1,500 = 7,500;
//   ENVELOPE = 55,850 - 28,350 - 7,500 = 20,000.
//   grants = 3*2,400 + 4*1,400 = 12,800 (all funded), slack = 7,200.
//   projected P50 520,000 (util 91.71% < 95% -> underutilised); P90 545,000.
//   trigger: near(3d) + underutil + 17 at-risk -> FIRES.
//   at-risk = 3 + 4 + 1(ext-dmorrow) + 8(payments members) + 1(payments CC) = 17.
//   cap-relax rows = 9 (8 members + CC), each unlock = 61,000 - 56,000 = 5,000.
//   sim: before 520,000 (91.71%) -> after 532,800 (93.97%); 7 unblocked.
// ===========================================================================
const AT_RISK_BLOCKED = ['karen-fox', 'ali-rezaei', 'josh-bright'];
const AT_RISK_APPROACHING = ['mia-larsson', 'tom-becker', 'wei-sun', 'colin-hurst'];
const AT_RISK_HELD = ['blake-ferris', 'noor-jaber', 'gina-lombardi', 'ext-rknott', 'devi-anand'];
// Otherwise-idle seats given a comfortable 2,500 draw so the Users/heavy-user
// screens are populated. All universal-ULB (4,600) seats -- no individual
// override, not a Payments member, not one of the controls-scale sub-4,600 ULBs
// (declan-ryan/tegan-ellis/jomo-mburu/nina-popov/devi-anand) -- so 2,500 is
// always comfortably below the 95% at-risk threshold (4,370).
const AT_RISK_COMFORTABLE = [
  'tania-osei', 'mark-vuong', 'hana-said', 'isaac-cole', 'georgia-pappas', 'dan-mercer', 'ruth-abela', 'kofi-asante',
  'mona-eldib', 'ravi-krishnan', 'sam-porter', 'beatrix-cho', 'lachlan-reid', 'omar-said', 'freya-nilsson', 'hamish-doyle',
  'seb-rowe', 'aria-fahey', 'kate-ellery', 'ext-tlau', 'priyanka-nair',
];

const AT_RISK_SEED: ScenarioSeed = {
  date: '2026-06-15',
  users: [
    ...AT_RISK_BLOCKED.map((login) => ({ login, pool: 4_600 })),
    ...AT_RISK_APPROACHING.map((login) => ({ login, pool: 4_400 })),
    ...AT_RISK_HELD.map((login) => ({ login, pool: 1_000 })),
    ...AT_RISK_COMFORTABLE.map((login) => ({ login, pool: 2_500 })),
  ],
  ccPool: {
    [COST_CENTER_IDS.workforce]: 152_000,
    [COST_CENTER_IDS.employer]: 100_000,
    [COST_CENTER_IDS.dataEval]: 54_000,
    [COST_CENTER_IDS.cyber]: 68_000,
    [COST_CENTER_IDS.corporate]: 82_150,
    [COST_CENTER_IDS.capBound]: 55_000,
  },
};

function usr(userLogin: string, costCenterName: string | null, pool: number, metered = 0): UsageState['users'][number] {
  return { userLogin, costCenterName, poolCreditsUsed: pool, meteredCreditsUsed: metered };
}

const AT_RISK_POOL_INPUTS: PoolScenarioInputs = {
  projectedUsage: {
    enterprise: { entityName: ENTERPRISE_SLUG, meteredCreditsUsed: 0 },
    users: [
      ...AT_RISK_BLOCKED.map((l) => usr(l, CORPORATE, 7_000)),
      ...AT_RISK_APPROACHING.map((l) => usr(l, CORPORATE, 6_000)),
      ...AT_RISK_HELD.map((l) => usr(l, CORPORATE, 2_500)),
    ],
    costCenters: [{ costCenterName: PAYMENTS, poolCreditsUsed: 61_000, meteredCreditsUsed: 0 }],
  },
  poolTotalCredits: 567_000,
  poolConsumedCredits: 511_150,
  projectedPoolConsumedCredits: 520_000,
  projectedPoolConsumedP90Credits: 545_000,
  cycleEndDate: '2026-06-30',
};

// ===========================================================================
// SURPLUS (pool phase, day 26/30 = 2026-06-27). Drastic under-consumption AND a
// SMALL at-risk cohort -> the pool trigger FIRES to tell the surplus-
// redistribution story (retune ratified 2026-07-08, Checkpoint-6 review): a
// huge forfeit-bound envelope funds a tiny cohort in full, leaving enormous
// slack -- the visual inverse of At-risk (a thin grants sliver in a sea of green
// slack). Budgets still DROP the $0 ULB (BUDGET_IDS.zeroUlb) so ext-dmorrow (0
// usage) is NOT a standing $0-ULB block; the at-risk set is EXACTLY the four
// authored contractor personas, every one of them fundable.
//
// Cohort (four throttled contractors on a tight 500-credit INDIVIDUAL ULB):
//   BLOCKED   x2 (ext-rknott [Corporate], ext-tlau [Cyber]): used 500 == 500
//                 ULB -> hard-stopped now; projected 2,000 -> grant 1,500 each.
//   APPROACH  x2 (aria-fahey [Cyber], seb-rowe [Cyber]): used 480 of 500 (96%
//                 >= 95% threshold); projected 1,500 -> grant 1,000 each.
//   -> 4 grants totalling 5,000, ALL fully funded (envelope 521,650 >> 5,000).
//   (Every grant converts FROM an individual ULB -> the UI shows no
//   "converts from" sub-label, CONVERTS_FROM['individual'] === null.)
//
//   8 light users at 1,200 pool (26% of 4,600 ULB -> not at-risk). Two of them
//   (rpatel2 [Workforce], ruby-carter [Cyber]) are projected to grow 1,200 ->
//   1,700, so the envelope's `held` (on-track non-at-risk draw) segment is a
//   nonzero 2 * 500 = 1,000 (engine-validator hazard #1). No cap-bound team --
//   this is a surplus world; every CC sits far under its included-usage cap.
//
//   scalars: total 567,000; consumed 16,000; projected P50 20,000
//     -> projected util 3.5%, FORFEIT 96.5% (547,000 credits). at-risk 4 ->
//     near-cycle-end(3d) + underutil(3.5%<95%) + 4 at-risk -> FIRES [T,T,T].
//   envelope: remaining_pool 567,000-16,000 = 551,000; reserve round(5% *
//     567,000) = 28,350; held 1,000; ENVELOPE = 551,000-28,350-1,000 = 521,650.
//     grants 5,000 (all funded) -> slack 516,650. segments sum to 551,000.
//   sim: before 20,000 (3.5%) -> after 25,000 (4.4%); 4 unblocked; tip 0.0%
//     (P90 30,000); verdict ok (5,000 << 521,650). badge = 4.
//
// WIRE<->ENGINE COHERENCE: the CC-aggregate pool draw SUMS to the engine's
// poolConsumedCredits scalar (16,000) so the Overview burn-down reads 16,000.
// Spread daily through day 25 (splitDaily). Each CC-aggregate stays > its named
// member burns (the gap is shared draw), and far under its cap:
//   workforce 8,600 / 168,000  (named 5x1,200 = 6,000; gap 2,600)
//   cyber      6,400 /  77,000  (named 3x1,200 + 500 + 480 + 480 = 5,060; gap 1,340)
//   corporate  1,000 /  91,000  (named ext-rknott 500; gap 500)
//   Σ = 16,000 == poolConsumedCredits (2.8% of the 567,000 pool -- unmistakably
//   distinct from At-risk's 90.1%).
// ===========================================================================
const SURPLUS_LIGHT_USERS = ['rpatel2', 'd-okafor', 'jr-mitchell', 'amir-haddad', 'claire-donnelly', 'ruby-carter', 'omar-farah', 'lucas-meyer'];
// Throttled contractors on a tight 500-credit individual ULB (scenario-local
// budgets, appended to SURPLUS_BUDGETS below -- the base roster leaves these
// four universal-/CCULB-governed, so a surplus-only individual override never
// touches Healthy/At-risk/Metered). ext-rknott/ext-tlau are the roster's own
// ext- contractors; aria-fahey/seb-rowe are Cyber seats given the same throttle.
const SURPLUS_BLOCKED = ['ext-rknott', 'ext-tlau']; // used 500 of 500 -> blocked now
const SURPLUS_APPROACHING = ['aria-fahey', 'seb-rowe']; // used 480 of 500 (96%)
const SURPLUS_CONTRACTOR_ULB_CREDITS = 500;

const SURPLUS_SEED: ScenarioSeed = {
  date: '2026-06-15',
  users: [
    ...SURPLUS_LIGHT_USERS.map((login) => ({ login, pool: 1_200 })),
    ...SURPLUS_BLOCKED.map((login) => ({ login, pool: 500 })),
    ...SURPLUS_APPROACHING.map((login) => ({ login, pool: 480 })),
  ],
  ccPool: {
    [COST_CENTER_IDS.workforce]: 8_600,
    [COST_CENTER_IDS.cyber]: 6_400,
    [COST_CENTER_IDS.corporate]: 1_000,
  },
};

// A tight individual ULB override for one throttled contractor. Scenario-local:
// appended ONLY to SURPLUS_BUDGETS, so the base roster (Healthy/At-risk/Metered)
// is byte-untouched. 500 credits = $5 (above the $1 near-zero warning floor).
function surplusContractorUlb(login: string): Budget {
  return {
    id: `budget-ulb-surplus-${login}`,
    budget_type: 'BundlePricing',
    budget_product_sku: 'ai_credits',
    budget_scope: 'individual',
    budget_entity_name: login,
    budget_amount: SURPLUS_CONTRACTOR_ULB_CREDITS / 100,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['copilot-admins@dewr.gov.au'] },
  };
}

const SURPLUS_BUDGETS: readonly Budget[] = [
  ...BUDGETS.filter((b) => b.id !== BUDGET_IDS.zeroUlb),
  ...[...SURPLUS_BLOCKED, ...SURPLUS_APPROACHING].map(surplusContractorUlb),
];

const SURPLUS_POOL_INPUTS: PoolScenarioInputs = {
  projectedUsage: {
    enterprise: { entityName: ENTERPRISE_SLUG, meteredCreditsUsed: 0 },
    users: [
      // At-risk cohort: projected demand beyond the 500 ULB -> the fundable grant.
      usr('ext-rknott', CORPORATE, 2_000),
      usr('ext-tlau', CYBER, 2_000),
      usr('aria-fahey', CYBER, 1_500),
      usr('seb-rowe', CYBER, 1_500),
      // Two non-at-risk light users projected to grow -> the envelope's `held`
      // (on-track draw the rebalancer must reserve for them, not grant away).
      usr('rpatel2', WORKFORCE, 1_700),
      usr('ruby-carter', CYBER, 1_700),
    ],
    costCenters: [],
  },
  poolTotalCredits: 567_000,
  poolConsumedCredits: 16_000,
  projectedPoolConsumedCredits: 20_000,
  projectedPoolConsumedP90Credits: 30_000,
  cycleEndDate: '2026-06-30',
};

// ===========================================================================
// METERED (metered phase active, 2026-06-27). A hard-stop cost-center budget at
// its cap with enterprise headroom -> the metered rebalancer fires.
//
//   enterprise metered 300,000 of 800,000 budget (headroom 500,000).
//   Data & Evaluation cc-budget $250 = 25,000, HARD-STOP ON: current metered
//     24,500 (98%), projected 30,000 -> needed 5,000 (cc-budget raise, $50 bill).
//   sam-kelly (Cyber, individual ULB 5,400): total 5,400 -> 6,400 -> needed
//     1,000 (individual override, $10 bill).
//   entities CURATED to [Data & Evaluation CC, sam-kelly] -- a CC in ONE branch
//     and a user in a DIFFERENT CC, so no member/CC double-count (hazard #2).
//   envelope base 500,000, reserve 0, held 0, allocatable 500,000, granted 6,000,
//     slack 494,000. trigger FIRES, at-risk 2. bill delta $60; unblocked 2.
//   wire: dataEval shared metered 24,500 + Employer shared 275,000 + sam-kelly
//     500 = 300,000 enterprise metered. dataEval pool 63,000 (== cap, exhausted).
// COHERENCE: the CC-aggregate pool + shared-metered rows are spread daily
// through day 25 (Defect 2(a)) so this scenario's forecast series is dense too;
// each per-CC total is preserved exactly, so every engine literal above holds.
// ===========================================================================
const METERED_SEED: ScenarioSeed = {
  date: '2026-06-15',
  users: [{ login: 'sam-kelly', pool: 4_900, metered: 500 }],
  ccPool: { [COST_CENTER_IDS.dataEval]: 63_000, [COST_CENTER_IDS.cyber]: 4_900 },
  ccMetered: { [COST_CENTER_IDS.dataEval]: 24_500, [COST_CENTER_IDS.employer]: 275_000 },
};

const METERED_INPUTS: MeteredScenarioInputs = {
  projectedUsage: {
    enterprise: { entityName: ENTERPRISE_SLUG, meteredCreditsUsed: 300_000 },
    users: [usr('sam-kelly', CYBER, 4_900, 1_500)],
    costCenters: [{ costCenterName: DATA_EVAL, poolCreditsUsed: 63_000, meteredCreditsUsed: 30_000 }],
  },
  entities: [
    { kind: 'cost_center', costCenterName: DATA_EVAL },
    { kind: 'user', userLogin: 'sam-kelly', costCenterName: CYBER },
  ],
  meteredPhaseActive: true,
  reserveCredits: 0,
};

// ===========================================================================
// Exported engine-input shapes (consumed by scenarios.engine.test.ts and,
// later, the 6.8/6.9 Auto-balance screen). currentUsage/controls are assembled
// from the wire at call time; these carry the projection + scalars.
// ===========================================================================
export interface PoolScenarioInputs {
  /**
   * Forecast end-of-cycle usage per entity. `null` means NO GROWTH: the
   * consumer mirrors the assembled currentUsage as the projection (the
   * 'healthy' scenario's on-pace world -- authoring a static duplicate of the
   * whole 81-seat DEWR rollup here would be a second copy of the wire
   * fixtures that could drift; the engine's overlay semantics make
   * `projectedUsage === currentUsage` and an equal-valued copy identical).
   */
  readonly projectedUsage: UsageState | null;
  readonly poolTotalCredits: number;
  readonly poolConsumedCredits: number;
  readonly projectedPoolConsumedCredits: number;
  readonly projectedPoolConsumedP90Credits: number;
  /** cycle end (YYYY-MM-DD) -- the pool trigger's near-cycle-end reference. */
  readonly cycleEndDate: string;
}

export interface MeteredScenarioInputs {
  readonly projectedUsage: UsageState;
  readonly entities: readonly EntityRef[];
  readonly meteredPhaseActive: boolean;
  readonly reserveCredits: number;
}

// ===========================================================================
// Assembled wire per scenario. 'healthy' is the committed DEWR arrays verbatim.
// ===========================================================================
const AT_RISK_WIRE = buildWire(AT_RISK_SEED);
const SURPLUS_WIRE = buildWire(SURPLUS_SEED);
const METERED_WIRE = buildWire(METERED_SEED);

const SCENARIO_WIRE: Record<ScenarioId, ScenarioWire> = {
  healthy: {
    budgets: BUDGETS,
    costCenters: COST_CENTERS,
    costCenterResources: COST_CENTER_RESOURCES,
    seats: SEATS,
    usageItems: USAGE_ITEMS,
    creditsUsedItems: CREDITS_USED_ITEMS,
  },
  'at-risk': {
    budgets: BUDGETS,
    costCenters: COST_CENTERS,
    costCenterResources: COST_CENTER_RESOURCES,
    seats: SEATS,
    usageItems: AT_RISK_WIRE.usageItems,
    creditsUsedItems: AT_RISK_WIRE.creditsUsedItems,
  },
  surplus: {
    budgets: SURPLUS_BUDGETS,
    costCenters: COST_CENTERS,
    costCenterResources: COST_CENTER_RESOURCES,
    seats: SEATS,
    usageItems: SURPLUS_WIRE.usageItems,
    creditsUsedItems: SURPLUS_WIRE.creditsUsedItems,
  },
  metered: {
    budgets: BUDGETS,
    costCenters: COST_CENTERS,
    costCenterResources: COST_CENTER_RESOURCES,
    seats: SEATS,
    usageItems: METERED_WIRE.usageItems,
    creditsUsedItems: METERED_WIRE.creditsUsedItems,
  },
};

/** The MSW-servable fixture set for the ACTIVE scenario (handlers read this). */
export function getActiveFixtures(): ScenarioWire {
  return SCENARIO_WIRE[getActiveScenarioId()];
}

// ===========================================================================
// HEALTHY (pool phase, day 13/30 = 2026-06-14). The DEWR world, on pace.
// Promoted from scenarios.engine.test.ts's inline literals (Task 6.8,
// maintainer-ratified 2026-07-07) so the Auto-balance screen's default pane
// and the engine-proof test read ONE source of truth:
//   scalars: total 567,000; consumed 189,800 (the Overview burn-down's own
//   cycle-to-date figure); projected P50 437,800 (annualised on-pace run rate
//   -> util 77.2%, underutilised) / P90 460,000.
//   projection: null = no growth (mirror assembled currentUsage). The DEWR
//   world still carries 10 standing at-risk entities even on a healthy day
//   (the cap-bound Payments team's 8 members + its CC entity, all pinned at
//   the 56,000 cap, plus ext-dmorrow's $0-ULB block), so the at-risk chip IS
//   met; but day 13/30 (16 days out) is OUTSIDE the 7-day near-cycle-end
//   window, so the trigger does NOT fire (chips: [false, true, true]).
// ===========================================================================
const HEALTHY_POOL_INPUTS: PoolScenarioInputs = {
  projectedUsage: null,
  poolTotalCredits: 567_000,
  poolConsumedCredits: 189_800,
  projectedPoolConsumedCredits: 437_800,
  projectedPoolConsumedP90Credits: 460_000,
  cycleEndDate: '2026-06-30',
};

/** The pool-rebalancer projection + scalars for a scenario (tests / 6.8). */
export const POOL_SCENARIO_INPUTS: Partial<Record<ScenarioId, PoolScenarioInputs>> = {
  healthy: HEALTHY_POOL_INPUTS,
  'at-risk': AT_RISK_POOL_INPUTS,
  surplus: SURPLUS_POOL_INPUTS,
};

/** The metered-rebalancer projection + curation for a scenario (tests / 6.9). */
export const METERED_SCENARIO_INPUTS: Partial<Record<ScenarioId, MeteredScenarioInputs>> = {
  metered: METERED_INPUTS,
};
