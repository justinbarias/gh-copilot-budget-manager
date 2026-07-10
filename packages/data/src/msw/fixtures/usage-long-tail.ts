import { COST_CENTER_IDS } from './constants.js';
import { SEATS } from './licenses.js';
import { COST_CENTER_RESOURCES } from './costCenters.js';
import { AI_CREDITS_SKU, type CreditsUsedItem, type UsageItem } from './usage.js';

// ============================================================================
// The 'long-tail' scenario's per-user usage world (new-scenario data only --
// ADDITIVE; it never touches the committed 'healthy'/'at-risk'/'surplus'/
// 'metered' arrays). Built for the Users -> Distribution view, which demos
// poorly on the other worlds (~44 of 81 seats idle -> P30 = P50 = 0). This
// world gives most seats a right-skewed, log-normal spread so the distribution
// reads as a real bell-curve-in-log-space with a heavy power-user tail.
//
// DETERMINISTIC (CLAUDE.md §4): a closed-form, seeded generator -- no
// Math.random, no Date.now. Each seat's cycle draw is exp(MU + SIGMA * z) where
// z is the seat's Gaussian quantile (Acklam's inverse-normal, below) at its
// rank in the login-sorted roster. Re-running always reproduces the same rows.
//
// COHERENCE with hard-stop ULBs (spec §1.3): a ULB caps a person's TOTAL draw
// per cycle, always hard-stop, so a single cycle's authored draw can never
// exceed the seat's EFFECTIVE ULB (most-specific wins: individual > CCULB >
// universal). Every generated cycle value is therefore clamped to that ceiling
// (`effectiveUlbCredits`). Users legitimately ABOVE the 4,600 universal ULB in
// the distribution are exactly those governed by a higher, more-specific ULB
// (Workforce CCULB 5,200; Data & Evaluation CCULB 6,000; liam-obrien 5,800;
// sam-kelly 5,400) PLUS the five history-carrying personas whose ROLLING-month
// window (getUsageDistribution sums a trailing month that spans the prior
// cycle) legitimately adds a cross-cycle tail on top of this cycle's draw.
// ext-dmorrow's $0 ULB clamps it to 0 (the standing offboarded-contractor
// block), coherent with every other scenario.
// ============================================================================

// --- effective ULB (credits) per seat, most-specific wins (budgets.ts) ------
const UNIVERSAL_ULB_CREDITS = 4_600;
const CCULB_CREDITS: Readonly<Record<string, number>> = {
  [COST_CENTER_IDS.workforce]: 5_200,
  [COST_CENTER_IDS.dataEval]: 6_000,
};
const INDIVIDUAL_ULB_CREDITS: Readonly<Record<string, number>> = {
  'liam-obrien': 5_800,
  'sam-kelly': 5_400,
  'nina-popov': 4_800,
  'tegan-ellis': 3_700,
  'devi-anand': 3_300,
  'jomo-mburu': 2_900,
  'declan-ryan': 2_500,
  'ext-pshah': 1_900,
  'ext-dmorrow': 0,
};

const CC_ID_BY_LOGIN: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const [ccId, resources] of Object.entries(COST_CENTER_RESOURCES)) {
    for (const r of resources) if (r.type === 'User') map[r.name] = ccId;
  }
  return map;
})();

const SEAT_ID_BY_LOGIN: Readonly<Record<string, string>> = Object.fromEntries(
  SEATS.map((s) => [s.assignee.login, String(s.assignee.id)]),
);

/** Most-specific ULB ceiling (credits) governing this seat's per-cycle draw. */
export function effectiveUlbCredits(login: string): number {
  if (login in INDIVIDUAL_ULB_CREDITS) return INDIVIDUAL_ULB_CREDITS[login] as number;
  const cc = CC_ID_BY_LOGIN[login];
  if (cc !== undefined && cc in CCULB_CREDITS) return CCULB_CREDITS[cc] as number;
  return UNIVERSAL_ULB_CREDITS;
}

// --- Acklam's inverse normal CDF (pure, closed-form, |err| < 1.2e-9) --------
// Places each seat's log-normal quantile deterministically -- no RNG.
function invNormalCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

// --- generator parameters (tuned so months=1 hits the brief's targets) ------
const LOGINS_SORTED: readonly string[] = SEATS.map((s) => s.assignee.login).sort((a, b) => a.localeCompare(b));
const N = LOGINS_SORTED.length; // 81
const MU = Math.log(1_100); // median-ish anchor (P50 target ~900-1,500)
const SIGMA = 1.02; // spread (P95 target ~4,500-6,500)
// The lowest INACTIVE_RANKS seats by roster rank carry NO usage this cycle (a
// realistic adoption gap). ext-dmorrow ($0 ULB) also clamps to 0, so the idle
// count is INACTIVE_RANKS + 1 ~= 8% of 81.
const INACTIVE_RANKS = 6;

/** This cycle's authored draw (credits) for a seat, clamped to its ULB. */
function cycleCreditsFor(login: string, rank: number): number {
  if (rank < INACTIVE_RANKS) return 0;
  const p = (rank + 0.5) / N;
  const raw = Math.round(Math.exp(MU + SIGMA * invNormalCdf(p)));
  return Math.min(raw, effectiveUlbCredits(login));
}

/** login -> this-cycle authored credits (the generator's output, pinned by tests). */
export const LONG_TAIL_CYCLE_BY_LOGIN: ReadonlyMap<string, number> = new Map(
  LOGINS_SORTED.map((login, rank) => [login, cycleCreditsFor(login, rank)]),
);

// --- weekday cadence: all <= 2026-06-12 (day 12) so the cycle filter at the
// scenario's as-of date (2026-06-14, day 13) includes every row, and the last
// weekday (06-12) anchors the per-user report's MAX date -- getUsageDistribution's
// window `toDate`. Mirrors 'healthy''s current-cycle cadence (never 06-01/day 0,
// never a weekend). ----------------------------------------------------------
const LONG_TAIL_WEEKDAYS: readonly string[] = ['2026-06-03', '2026-06-05', '2026-06-08', '2026-06-10', '2026-06-11', '2026-06-12'];

// Split an integer total into one non-negative amount per weekday, summing to
// `total` EXACTLY (remainder front-loaded). Deterministic. The last weekday
// (06-12) always carries `floor(total/n)`, so every active seat (total >= 100)
// has a 06-12 row -> the report's max date is 06-12.
function splitDaily(total: number, days: readonly string[]): Map<string, number> {
  const n = days.length;
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  const out = new Map<string, number>();
  days.forEach((d, i) => out.set(d, base + (i < remainder ? 1 : 0)));
  return out;
}

// --- per-user metrics rows (drives the Users screen + getUsageDistribution) --
export const LONG_TAIL_CREDITS_USED_ITEMS: readonly CreditsUsedItem[] = (() => {
  const rows: CreditsUsedItem[] = [];
  for (const login of LOGINS_SORTED) {
    const total = LONG_TAIL_CYCLE_BY_LOGIN.get(login) ?? 0;
    if (total <= 0) continue;
    for (const [date, credits] of splitDaily(total, LONG_TAIL_WEEKDAYS)) {
      if (credits <= 0) continue;
      rows.push({ date, user_id: SEAT_ID_BY_LOGIN[login] ?? '0', user_login: login, ai_credits_used: credits });
    }
  }
  return rows;
})();

// --- per-CC aggregate pool draw = Σ its members' cycle draw (derived, never
// independent) -> the Overview burn-down + the coherence equation
// (Σ per-CC pool == poolConsumedCredits). Every CC lands far under its
// included-usage cap (no cap-bound team; this is a calm day-13 world). --------
export const LONG_TAIL_CC_POOL: Readonly<Record<string, number>> = (() => {
  const byCc: Record<string, number> = {};
  for (const login of LOGINS_SORTED) {
    const cc = CC_ID_BY_LOGIN[login];
    if (cc === undefined) continue;
    byCc[cc] = (byCc[cc] ?? 0) + (LONG_TAIL_CYCLE_BY_LOGIN.get(login) ?? 0);
  }
  return byCc;
})();

/** Enterprise pool consumed this cycle = Σ per-CC pool = Σ all seats' cycle draw. */
export const LONG_TAIL_POOL_CONSUMED_CREDITS: number = Object.values(LONG_TAIL_CC_POOL).reduce((s, v) => s + v, 0);

// --- CC-aggregate billing rows (user_login null, discount-covered pool draw),
// spread across the same weekdays so the burn-down ramps through day 12. -----
export const LONG_TAIL_USAGE_ITEMS: readonly UsageItem[] = (() => {
  const rows: UsageItem[] = [];
  for (const [ccId, pool] of Object.entries(LONG_TAIL_CC_POOL)) {
    for (const [date, credits] of splitDaily(pool, LONG_TAIL_WEEKDAYS)) {
      if (credits <= 0) continue;
      rows.push({
        date,
        product: 'copilot',
        sku: AI_CREDITS_SKU,
        cost_center_id: ccId,
        user_login: null,
        quantity: credits,
        gross_amount: credits / 100,
        discount_amount: credits / 100,
        net_amount: 0,
      });
    }
  }
  return rows;
})();
