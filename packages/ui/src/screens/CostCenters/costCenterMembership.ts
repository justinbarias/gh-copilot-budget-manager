import type { ControlState } from '@copilot-budget/core';

// Task 4.13 (maintainer ruling): cost-center membership is a partition -- a user
// is attributed to at most one cost center at a time (the DEWR world attributes
// all 81 seats, so in practice there are no unassigned seats). Therefore adding
// a user who already belongs to ANOTHER cost center must be a MOVE, never a bare
// add that would double-count their seat in two included-usage caps (money-
// loosening: it breaks the Σ(cost-center caps) = pool-allowance coherence).
//
// Both membership surfaces converge on this one primitive: the Users-row
// reassignment modal (moveUserToCostCenter) and the drill-in "add member" flow
// (which strips the added user from their prior cost center via
// removeUserFromOtherCostCenters). The resulting plan carries the move on BOTH
// sides -- a removal entry on the source cost center and an addition entry on
// the target -- and the engine's removals-first apply order issues the source
// DELETE /resource before the target POST /resource, so a mid-move partial
// failure leaves the seat briefly UNATTRIBUTED (conservative) rather than
// briefly double-counted (money-loosening).

/** Remove the `{ User, login }` resource from every cost center EXCEPT `keepCostCenterName`. */
export function removeUserFromOtherCostCenters(
  controls: readonly ControlState[],
  login: string,
  keepCostCenterName: string,
): ControlState[] {
  return controls.map((control) => {
    if (control.kind !== 'cost_center' || control.name === keepCostCenterName) return control;
    const members = control.members.filter((m) => !(m.type === 'User' && m.name === login));
    return members.length === control.members.length ? control : { ...control, members };
  });
}

/**
 * Move `login` to `targetCostCenterName`: ensure the target has the `{ User,
 * login }` resource, and strip it from wherever it currently lives. A no-op on
 * the target if already present (idempotent); a from-unassigned move is just
 * the add (nothing to strip).
 */
export function moveUserToCostCenter(
  controls: readonly ControlState[],
  login: string,
  targetCostCenterName: string,
): ControlState[] {
  const withTarget = controls.map((control) => {
    if (control.kind !== 'cost_center' || control.name !== targetCostCenterName) return control;
    if (control.members.some((m) => m.type === 'User' && m.name === login)) return control;
    return { ...control, members: [...control.members, { type: 'User' as const, name: login }] };
  });
  return removeUserFromOtherCostCenters(withTarget, login, targetCostCenterName);
}
