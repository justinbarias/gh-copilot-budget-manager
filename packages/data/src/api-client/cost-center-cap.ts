// Included-usage-cap wire->model normalization (live crash fix, 2026-07-08).
//
// The internal model -- included_usage_cap { enabled, computed_limit_credits,
// overflow } -- is what MSW emits and what every downstream consumer (core
// controls, forecasts, UI) is built against (standing ruling: the internal
// model stays; MSW keeps emitting it until the real overflow field is pinned).
// Real GitHub cost centers (github.com GHEC, confirmed live) carry a FLAT
// `ai_credit_pool_enabled: boolean` plus a read-only `ai_credit_pool_state
// { target_amount, current_amount }` instead -- reading
// `.included_usage_cap.enabled` off that shape was the live TypeError this
// module fixes. This is the ONE shared mapper (github-impl.ts and
// write/live-state.ts both call it -- never two divergent copies), living in
// the PARSE layer per the ruling: core/UI/schema never see the wire shape.
//
// TWO FLAGGED ASSUMPTIONS (unpinned wire facts -- the smoke R2 row's raw-field
// dump is what pins them on the maintainer's next live run):
//
// 1. UNITS of ai_credit_pool_state.target_amount: assumed **USD dollars**,
//    converted to credits via the platform-wide $0.01/credit rule
//    (credits = round(USD x 100)) -- the SAME conversion budget_amount and
//    every usage amount already use. Reasoning: every other amount field on
//    the billing platform's wire (budget_amount, netAmount, pricePerUnit) is
//    USD; a lone credits-denominated amount would be the inconsistency, so
//    USD is the least-surprising default. RISK: if it is actually credits,
//    displayed limits read 100x too high. The raw, untransformed value cannot
//    ride the internal model (computed_limit_credits is its only field, and
//    the model is frozen), so the smoke R2 details surface it verbatim
//    instead -- that output is the unit pin.
//
// 2. OVERFLOW (block vs metered at cap exhaustion): the real wire field is
//    undocumented ANYWHERE we could reach. We sniff obvious candidate keys
//    (any key on the cost-center object or its ai_credit_pool_state whose
//    name matches /overflow|exceed|block/i AND whose value is literally
//    'block' or 'metered' -- boolean candidates like a hypothetical
//    `block_on_exceed` are deliberately NOT mapped: `allow_overflow: true`
//    and `block_on_exceed: true` would mean opposite things, so guessing a
//    boolean's polarity is worse than defaulting). When nothing sniffs:
//    default **'block'**. Reasoning: (a) it matches the platform's own
//    default posture -- pool exhaustion BLOCKS unless the "AI credit paid
//    usage" policy is explicitly enabled (CLAUDE.md §5); (b) downstream,
//    overflow==='metered' is what enables paid-usage forecasting for the CC,
//    so a wrong 'block' fails conservative (earlier exhaustion warnings, no
//    phantom spend capacity), while a wrong 'metered' would project spending
//    room that a hard stop will actually deny -- the worse failure for a
//    hard-stop-biased FinOps guardrail tool.

export interface IncludedUsageCapShape {
  enabled: boolean;
  computed_limit_credits: number;
  overflow: 'block' | 'metered';
}

const OVERFLOW_KEY_PATTERN = /overflow|exceed|block/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Flagged assumption #1 (see module comment): USD dollars -> credits.
function usdToCredits(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

function sniffOverflow(...objects: Array<Record<string, unknown> | undefined>): 'block' | 'metered' | null {
  for (const obj of objects) {
    if (!obj) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (!OVERFLOW_KEY_PATTERN.test(key)) continue;
      if (value === 'block' || value === 'metered') return value;
    }
  }
  return null;
}

/**
 * Normalize a raw cost-center wire object's cap fields into the internal
 * included_usage_cap shape. Total function -- NEVER throws, whatever the
 * shape: a cost center carrying none of the cap fields maps to the disabled
 * default ({ enabled: false, computed_limit_credits: 0, overflow: 'block' }).
 *
 * - Internal/MSW shape (`included_usage_cap` present): used exactly as-is
 *   (simulation stays byte-identical), with per-field defaults only against
 *   partial objects.
 * - Real GHEC wire: enabled <- ai_credit_pool_enabled ?? false;
 *   computed_limit_credits <- usdToCredits(ai_credit_pool_state.target_amount)
 *   (flagged unit assumption #1); overflow <- sniffed candidate key or the
 *   flagged 'block' default (#2).
 */
export function normalizeIncludedUsageCap(rawCostCenter: unknown): IncludedUsageCapShape {
  if (!isRecord(rawCostCenter)) {
    return { enabled: false, computed_limit_credits: 0, overflow: 'block' };
  }

  const internal = rawCostCenter.included_usage_cap;
  if (isRecord(internal)) {
    return {
      enabled: internal.enabled === true,
      computed_limit_credits: typeof internal.computed_limit_credits === 'number' ? internal.computed_limit_credits : 0,
      overflow: internal.overflow === 'metered' ? 'metered' : 'block',
    };
  }

  const poolState = isRecord(rawCostCenter.ai_credit_pool_state) ? rawCostCenter.ai_credit_pool_state : undefined;
  const targetAmount = poolState && typeof poolState.target_amount === 'number' ? poolState.target_amount : null;

  return {
    enabled: rawCostCenter.ai_credit_pool_enabled === true,
    computed_limit_credits: targetAmount !== null ? usdToCredits(targetAmount) : 0,
    overflow: sniffOverflow(rawCostCenter, poolState) ?? 'block',
  };
}
