import { applyPlanToControls, isUlbScope, type BudgetControl, type ControlState, type Plan } from './controls.js';

// FR4 / CLAUDE.md §6.3-§6.4: write-time validation. Blockers must stop Apply
// outright (invariant #4: "block enterprise-cap-below-sum-of-cost-centers");
// warnings surface inline but don't block (design/README.md §3's rail:
// "inline validation warnings").

export interface UserLicenseContext {
  userLogin: string;
  /** Org logins this user holds a Copilot seat in -- >1 flags random-org billing risk (FR4). */
  licensedOrgLogins: readonly string[];
}

export interface AlertOnlyOverrideInput {
  controlId: string;
  /**
   * Required justification for turning a hard-stop control alert-only
   * (CLAUDE.md §6.3: "an explicit, logged override"). Blank/whitespace-only
   * is treated as not provided -- see resolveOverrideStatus.
   */
  justification: string;
}

// $1 at $0.01/credit (CLAUDE.md §5) -- only the default; callers parameterize
// via ValidationContext.nearZeroUlbThresholdCredits (FR4: "warn on $0/near-zero ULBs").
export const DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS = 100;

export interface ValidationContext {
  /**
   * Live control state the plan is diffed against. Needed to compute
   * post-plan totals (the enterprise-cap-below-sum blocker looks at the
   * post-plan enterprise cap and cost-center sum, not just what the plan
   * itself touches) via applyPlanToControls.
   */
  live: readonly ControlState[];
  users?: readonly UserLicenseContext[];
  nearZeroUlbThresholdCredits?: number;
  alertOnlyOverrides?: readonly AlertOnlyOverrideInput[];
}

export type Blocker =
  | {
      kind: 'enterprise_cap_below_cost_center_sum';
      enterpriseEntityName: string;
      enterpriseCapCredits: number;
      costCenterSumCredits: number;
    }
  // Beyond FR4's three listed blockers/warnings: a negative budget amount is
  // never valid domain data at any scope. Flagged here (not just at the type
  // level, since BudgetControl.amountCredits is a plain `number`) per the
  // build method's "negative amounts rejected... at validation level" edge case.
  | { kind: 'negative_amount'; controlId: string; amountCredits: number };

// The output type enforces the justification requirement: a caller cannot
// construct an "acknowledged" override without a `justification: string`
// field being present, and resolveOverrideStatus (below) only ever produces
// 'acknowledged' when that string is non-empty -- so a warning can never be
// silently treated as resolved.
export type AlertOnlyOverrideStatus = { status: 'required' } | { status: 'acknowledged'; justification: string };

export type Warning =
  | { kind: 'zero_or_near_zero_ulb'; controlId: string; amountCredits: number; thresholdCredits: number }
  | { kind: 'multi_org_licensed_user'; userLogin: string; orgLogins: readonly string[] }
  | { kind: 'alert_only_without_hard_stop'; controlId: string; override: AlertOnlyOverrideStatus };

export interface ValidationResult {
  blockers: readonly Blocker[];
  warnings: readonly Warning[];
  isBlocked: boolean;
}

export function validatePlan(plan: Plan, context: ValidationContext): ValidationResult {
  const blockers: Blocker[] = [];
  const warnings: Warning[] = [];

  const postPlan = applyPlanToControls(context.live, plan);
  const threshold = context.nearZeroUlbThresholdCredits ?? DEFAULT_NEAR_ZERO_ULB_THRESHOLD_CREDITS;

  checkEnterpriseCapBelowCostCenterSum(postPlan, blockers);
  checkNegativeAmounts(plan, blockers);
  checkNearZeroUlbs(plan, threshold, warnings);
  checkMultiOrgLicensedUsers(context.users ?? [], warnings);
  checkAlertOnlyOverrides(plan, context.alertOnlyOverrides ?? [], warnings);

  return { blockers, warnings, isBlocked: blockers.length > 0 };
}

// Post-plan check (not plan-entries-only): the blocker compares the
// resulting enterprise spending-limit amount against the resulting sum of
// cost-center spending-limit amounts, regardless of whether either was
// touched by *this* plan (raising cost-center budgets without touching the
// enterprise cap must still trip this if the sum now exceeds it).
function checkEnterpriseCapBelowCostCenterSum(postPlan: readonly ControlState[], blockers: Blocker[]): void {
  const enterpriseBudget = postPlan.find(
    (c): c is BudgetControl => c.kind === 'budget' && c.scope === 'enterprise',
  );
  if (!enterpriseBudget) return; // nothing to compare against -- no enterprise spending limit defined post-plan.

  const costCenterSumCredits = postPlan
    .filter((c): c is BudgetControl => c.kind === 'budget' && c.scope === 'cost_center')
    .reduce((sum, c) => sum + c.amountCredits, 0);

  if (enterpriseBudget.amountCredits < costCenterSumCredits) {
    blockers.push({
      kind: 'enterprise_cap_below_cost_center_sum',
      enterpriseEntityName: enterpriseBudget.entityName,
      enterpriseCapCredits: enterpriseBudget.amountCredits,
      costCenterSumCredits,
    });
  }
}

// Plan-entries-only check: only flags amounts the admin is actually staging
// right now (an 'add' or a changed 'amountCredits'), not pre-existing live
// values this plan doesn't touch.
function checkNegativeAmounts(plan: Plan, blockers: Blocker[]): void {
  for (const entry of plan.entries) {
    if (entry.controlKind !== 'budget') continue;
    if (entry.action === 'add' && entry.desired.amountCredits < 0) {
      blockers.push({ kind: 'negative_amount', controlId: entry.id, amountCredits: entry.desired.amountCredits });
    } else if (entry.action === 'change') {
      const amountChange = entry.changes.find((c) => c.field === 'amountCredits');
      if (amountChange && amountChange.new < 0) {
        blockers.push({ kind: 'negative_amount', controlId: entry.id, amountCredits: amountChange.new });
      }
    }
  }
}

// Plan-entries-only (see checkNegativeAmounts for the rationale): warns on a
// staged ULB (universal/individual/multi_user_cost_center) amount at or below
// the near-zero threshold, whether newly added or changed to that amount.
function checkNearZeroUlbs(plan: Plan, thresholdCredits: number, warnings: Warning[]): void {
  for (const entry of plan.entries) {
    if (entry.controlKind !== 'budget') continue;
    if (!isUlbScope(entry.scope)) continue;

    if (entry.action === 'add' && entry.desired.amountCredits <= thresholdCredits) {
      warnings.push({
        kind: 'zero_or_near_zero_ulb',
        controlId: entry.id,
        amountCredits: entry.desired.amountCredits,
        thresholdCredits,
      });
    } else if (entry.action === 'change') {
      const amountChange = entry.changes.find((c) => c.field === 'amountCredits');
      if (amountChange && amountChange.new <= thresholdCredits) {
        warnings.push({
          kind: 'zero_or_near_zero_ulb',
          controlId: entry.id,
          amountCredits: amountChange.new,
          thresholdCredits,
        });
      }
    }
  }
}

// Independent of the plan's contents -- license attribution is a standing
// risk flag (FR4: "flag multi-org-licensed users (random-org billing)"), not
// something the current write introduces or removes.
function checkMultiOrgLicensedUsers(users: readonly UserLicenseContext[], warnings: Warning[]): void {
  for (const user of users) {
    if (user.licensedOrgLogins.length > 1) {
      warnings.push({ kind: 'multi_org_licensed_user', userLogin: user.userLogin, orgLogins: user.licensedOrgLogins });
    }
  }
}

function resolveOverrideStatus(
  controlId: string,
  overrides: readonly AlertOnlyOverrideInput[],
): AlertOnlyOverrideStatus {
  const match = overrides.find((o) => o.controlId === controlId);
  if (match && match.justification.trim().length > 0) {
    return { status: 'acknowledged', justification: match.justification.trim() };
  }
  return { status: 'required' };
}

// CLAUDE.md §6.3: "Enforce prevent_further_usage: true for any intended hard
// cap; making an alert-only limit requires an explicit, logged override."
//
// ULBs (Family A) are *always* a hard stop by domain definition (CLAUDE.md
// §5) -- the Controls UI doesn't even expose a toggle for them (design's
// locked "Hard stop · always" pill) -- so any staged ULB with hard-stop off,
// whether newly added or changed to false, is flagged.
//
// Spending limits (Family B) default to hard-stop OFF (FR4/§1.3), so a fresh
// spending limit staged with prevent_further_usage: false is the *expected*
// default, not a violation. Only the act of *turning off* a previously-true
// hard stop ("making an alert-only limit") requires the override.
function checkAlertOnlyOverrides(
  plan: Plan,
  overrides: readonly AlertOnlyOverrideInput[],
  warnings: Warning[],
): void {
  for (const entry of plan.entries) {
    if (entry.controlKind !== 'budget') continue;

    if (entry.action === 'add') {
      if (isUlbScope(entry.scope) && entry.desired.preventFurtherUsage === false) {
        warnings.push({
          kind: 'alert_only_without_hard_stop',
          controlId: entry.id,
          override: resolveOverrideStatus(entry.id, overrides),
        });
      }
      continue;
    }

    if (entry.action === 'change') {
      const pfu = entry.changes.find((c) => c.field === 'preventFurtherUsage');
      if (!pfu) continue;

      const flagged = isUlbScope(entry.scope) ? pfu.new === false : pfu.old === true && pfu.new === false;
      if (flagged) {
        warnings.push({
          kind: 'alert_only_without_hard_stop',
          controlId: entry.id,
          override: resolveOverrideStatus(entry.id, overrides),
        });
      }
    }
  }
}
