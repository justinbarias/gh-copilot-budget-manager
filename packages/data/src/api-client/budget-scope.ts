// Budget-scope wire<->internal translation (OpenAPI-pinned, 2026-07-08 --
// wire-contract-writes.md §1, machine-verified against
// github/rest-api-description descriptions/ghec/ghec.2026-03-10.json).
//
// The real budget_scope enum has SEVEN values:
//   enterprise | organization | repository | cost_center |
//   multi_user_customer | multi_user_cost_center | user
// Our internal `universal` / `individual` spellings DO NOT EXIST on the wire:
//   - wire `multi_user_customer`          = internal `universal` (the
//     enterprise-wide ULB applied to all users)
//   - wire `user` + separate `user` field = internal `individual` (the `user`
//     field carries the login when scope is `user`)
// This was a REAL live read bug: live budgets already return
// user/multi_user_customer scopes, and classifying by the internal spellings
// misfiled ULBs (wrong family/precedence). Following the cap-mapper precedent
// (cost-center-cap.ts): the internal model stays frozen; translation lives
// HERE, at the parse/serialize boundary, called by github-impl.ts and
// write/live-state.ts (reads) and write/engine.ts (create payloads) -- one
// mapper, never duplicated logic.

/** The internal budget-scope union the rest of the codebase (core/UI/DB) is built against. */
export type InternalBudgetScope =
  | 'universal'
  | 'individual'
  | 'multi_user_cost_center'
  | 'enterprise'
  | 'organization'
  | 'cost_center';

export interface InternalBudgetIdentity {
  scope: InternalBudgetScope;
  entityName: string;
}

// Wire -> internal. Returns null for a wire scope with NO internal home --
// callers skip those rows (never invent an internal scope):
//   - `repository`: pre-existing, deliberate exclusion (packages/core's
//     BudgetScope: "not a scope this tool administers").
//   - anything unrecognized: a future enum widening; skipping (not throwing)
//     keeps reads alive, and the smoke's R4 row is where new scopes surface.
// TRANSITIONAL TOLERANCE: the internal spellings themselves
// (universal/individual) are also accepted as passthrough -- same both-dialect
// posture as the cap mapper. Real GitHub never sends them; this only keeps the
// parse robust across the mock-side cutover to real wire values.
export function wireBudgetToInternal(raw: {
  budget_scope: string;
  budget_entity_name?: string | null;
  user?: string | null;
}): InternalBudgetIdentity | null {
  const entityName = typeof raw.budget_entity_name === 'string' ? raw.budget_entity_name : '';
  switch (raw.budget_scope) {
    case 'multi_user_customer':
      return { scope: 'universal', entityName };
    case 'user':
      // The `user` field is the login (OpenAPI: "the login when scope is
      // user"); budget_entity_name is only a defensive fallback if a response
      // ever omits it.
      return { scope: 'individual', entityName: typeof raw.user === 'string' && raw.user.length > 0 ? raw.user : entityName };
    case 'multi_user_cost_center':
    case 'enterprise':
    case 'organization':
    case 'cost_center':
      return { scope: raw.budget_scope, entityName };
    // Transitional internal-spelling passthrough (see doc comment).
    case 'universal':
    case 'individual':
      return { scope: raw.budget_scope, entityName };
    default:
      return null; // repository + unknown: no internal home
  }
}

// Skip trace (validator hardening, 2026-07-08): a wire budget whose scope has
// no internal home is EXCLUDED from Controls -- for `repository` that is the
// documented product decision (core's BudgetScope: "not a scope this tool
// administers"), but a silent exclusion would also swallow any FUTURE enum
// widening, leaving a money-affecting budget invisible with zero operator cue
// (a §6-grade honesty problem). Both fetch boundaries therefore report what
// they skipped through this one helper: a main-process console.warn (never the
// renderer; carries scope + entity name only -- no token, no amounts). Kept
// out of wireBudgetToInternal itself so the mapper stays a pure function.
export function warnSkippedBudgetScopes(
  skipped: ReadonlyArray<{ budget_scope: string; budget_entity_name?: string | null }>,
  context: string,
): void {
  if (skipped.length === 0) return;
  const summary = skipped.map((s) => `${s.budget_scope}(${s.budget_entity_name ?? '?'})`).join(', ');
  console.warn(
    `[budget-scope] ${context}: skipped ${skipped.length} budget(s) with no internal scope mapping (not administered by this tool): ${summary}`,
  );
}

// ---------------------------------------------------------------------------
// Budget PRODUCT filter (open item 20, 2026-07-09 -- maintainer decision (a)).
// Machine-verified (OpenAPI ghec.2026-03-10.json): budgets carry a pricing
// model -- budget_type BundlePricing (covers ALL AI-credit SKUs under the one
// `budget_product_sku: 'ai_credits'`), ProductPricing (a whole product, e.g.
// 'actions'), SkuPricing (one SKU, e.g. 'actions_linux') -- and real tenants
// hold one budget PER PRODUCT at the same scope. Unfiltered, a same-scope
// actions budget renders as an identical "Enterprise metered budget" row and
// collides with the AI-credit budget's control identity (the maintainer's
// "1115% used" screenshot: the whole unfiltered bill paired against one
// budget's cap). This tool's control families scope to AI-CREDIT budgets
// only; others are excluded at the read boundary WITH a visible trace.
// ---------------------------------------------------------------------------
export const AI_CREDITS_BUDGET_SKU = 'ai_credits';

export function isAiCreditBudget(raw: { budget_product_sku?: string | null }): boolean {
  return raw.budget_product_sku === AI_CREDITS_BUDGET_SKU;
}

// Sibling of warnSkippedBudgetScopes (same honesty rule, same channel): a
// budget excluded for covering a NON-AI-credit product is reported through a
// main-process console.warn -- count + sku + scope + entity, never amounts.
export function warnExcludedProductBudgets(
  excluded: ReadonlyArray<{ budget_product_sku?: string | null; budget_scope: string; budget_entity_name?: string | null }>,
  context: string,
): void {
  if (excluded.length === 0) return;
  const summary = excluded
    .map((b) => `${b.budget_product_sku ?? '<no-sku>'}:${b.budget_scope}(${b.budget_entity_name ?? '?'})`)
    .join(', ');
  console.warn(
    `[budget-product] ${context}: excluded ${excluded.length} non-AI-credit budget(s) (outside this tool's control families): ${summary}`,
  );
}

// Internal -> wire, for the write engine's CREATE payload (PATCH bodies carry
// no scope, DELETE targets an id -- create is the only serialization site).
// `individual` serializes as scope `user` + the `user` login field;
// budget_entity_name is kept alongside (it is the shared identity field on
// every other scope and the create schema carries it) -- both name the same
// login, so no information is invented.
export function internalBudgetIdentityToWire(scope: InternalBudgetScope, entityName: string): {
  budget_scope: string;
  budget_entity_name: string;
  user?: string;
} {
  if (scope === 'universal') return { budget_scope: 'multi_user_customer', budget_entity_name: entityName };
  if (scope === 'individual') return { budget_scope: 'user', budget_entity_name: entityName, user: entityName };
  return { budget_scope: scope, budget_entity_name: entityName };
}
