import type { AlertingState, Plan, PlanEntry } from '@copilot-budget/core';
import type { ApplyPlanResult, DryRunResult } from '@copilot-budget/data';
import './PlanRail.css';

// The sticky plan -> simulate -> apply right rail (design/README.md §3) --
// Task 4.9's reusable deliverable. Tasks 4.10-4.14 stage *different* desired
// controls (ULB rows, included-cap cards, modals) but reuse this component
// unchanged: the parent owns staging (a `desired` overlay keyed by control
// identity) and hands the rail a derived core Plan plus the dry-run/apply
// callbacks; the rail owns rendering the Terraform-style diff, the simulation
// numbers, validation blockers/warnings, the §6.3 override acknowledgment,
// the justification gate, and every ApplyPlanResult arm.
//
// Deliberately out of scope here (Phase 7 guardrails, per PLAN.md): the
// 50,000-credit approval threshold / "Request approval & queue" flow from the
// design brief. No approval state exists yet to gate on.

export interface PlanRailProps {
  /** Locally derived diff (core's diffControls(live, desired)). Empty plan => apply disabled. */
  plan: Plan;
  /** Last dry-run result, or null if none has been run for any plan yet. */
  dryRun: DryRunResult | null;
  /**
   * True when the staged plan changed after `dryRun` was produced (CLAUDE.md
   * §6.1: the preview must match what apply will do) -- a stale dry-run keeps
   * rendering, visibly flagged, but disables Apply until re-run.
   */
  dryRunStale: boolean;
  runningDryRun: boolean;
  applying: boolean;
  /** Last apply outcome; all four arms (applied/drift/blocked/partial_failure) render distinctly. */
  applyResult: ApplyPlanResult | null;
  justification: string;
  onJustificationChange: (value: string) => void;
  /** §6.3: true when the plan turns a previously-on hard stop off -- demands the explicit acknowledgment below. */
  requiresHardStopOverride: boolean;
  overrideAcknowledged: boolean;
  onOverrideAcknowledgedChange: (value: boolean) => void;
  /** §6.8: when true (simulation mode), the apply affordance + results are visibly simulated. */
  simulated: boolean;
  onRunDryRun: () => void;
  onApply: () => void;
  onDiscard: () => void;
  /** Drift arm's recovery: re-fetch live state, keep staged edits, invalidate the dry-run. */
  onReconcileDrift: () => void;
}

function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatUsd(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}

function alertingLabel(alerting: AlertingState): string {
  return alerting.willAlert ? `on(${alerting.alertRecipients.join(', ')})` : 'off';
}

type DiffMarker = '+' | '~' | '-';

interface DiffLine {
  key: string;
  marker: DiffMarker;
  text: string;
}

function budgetLabel(entry: Extract<PlanEntry, { controlKind: 'budget' }>): string {
  return `${entry.scope}["${entry.entityName}"]`;
}

// Terraform-style lines per design §3: add-green `+`, change-amber `~`,
// delete-red `-`, `old → new` per field. Pure over the core Plan shape, so
// later slices' plans (ULBs, included caps) render here with zero changes.
export function planDiffLines(plan: Plan): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const entry of plan.entries) {
    if (entry.controlKind === 'budget') {
      const label = budgetLabel(entry);
      if (entry.action === 'add') {
        lines.push({
          key: `${entry.id}:add`,
          marker: '+',
          text: `+ ${label}: cap ${formatCredits(entry.desired.amountCredits)} · ${entry.desired.preventFurtherUsage ? 'hard-stop' : 'alert-only'}`,
        });
      } else if (entry.action === 'delete') {
        lines.push({ key: `${entry.id}:delete`, marker: '-', text: `- ${label}: cap ${formatCredits(entry.live.amountCredits)}` });
      } else {
        for (const change of entry.changes) {
          if (change.field === 'amountCredits') {
            lines.push({
              key: `${entry.id}:cap`,
              marker: '~',
              text: `~ ${label}.cap: ${formatCredits(change.old)} → ${formatCredits(change.new)}`,
            });
          } else if (change.field === 'preventFurtherUsage') {
            const marker: DiffMarker = change.new ? '+' : '-';
            lines.push({
              key: `${entry.id}:hard_stop`,
              marker,
              text: `${marker} ${label}.hard_stop: ${String(change.old)} → ${String(change.new)}`,
            });
          } else {
            lines.push({
              key: `${entry.id}:alerts`,
              marker: '~',
              text: `~ ${label}.alerts: ${alertingLabel(change.old)} → ${alertingLabel(change.new)}`,
            });
          }
        }
      }
      continue;
    }

    // included_cap entries -- rendered now so Task 4.12's cards reuse this
    // rail verbatim (design's own example: included_cap["ML Research"].enabled).
    // Task 4.13 widened core's PlanEntry union with cost_center variants; those
    // never reach THIS rail (the Controls screen passes cost_center controls
    // through unchanged, so its plan has none -- they're staged + rendered by
    // CostCenterPlanRail instead). This guard makes that explicit so the
    // remainder narrows to included_cap; it changes no budget/cap rendering.
    if (entry.controlKind !== 'included_cap') continue;
    const capLabel = `included_cap["${entry.costCenterName}"]`;
    if (entry.action === 'add') {
      lines.push({ key: `${entry.id}:add`, marker: '+', text: `+ ${capLabel}` });
    } else if (entry.action === 'delete') {
      lines.push({ key: `${entry.id}:delete`, marker: '-', text: `- ${capLabel}` });
    } else {
      for (const change of entry.changes) {
        if (change.field === 'enabled') {
          const marker: DiffMarker = change.new ? '+' : '-';
          lines.push({
            key: `${entry.id}:enabled`,
            marker,
            text: `${marker} ${capLabel}.enabled: ${String(change.old)} → ${String(change.new)}`,
          });
        } else {
          lines.push({
            key: `${entry.id}:overflow`,
            marker: '~',
            text: `~ ${capLabel}.overflow: ${change.old} → ${change.new}`,
          });
        }
      }
    }
  }
  return lines;
}

type Validation = DryRunResult['validation'];
type Blocker = Validation['blockers'][number];
type Warning = Validation['warnings'][number];

function blockerText(blocker: Blocker): string {
  if (blocker.kind === 'enterprise_cap_below_cost_center_sum') {
    return `Enterprise cap (${formatCredits(blocker.enterpriseCapCredits)}) is below the sum of cost-center spending limits (${formatCredits(blocker.costCenterSumCredits)}) — cost centers could pre-empt the enterprise cap.`;
  }
  return `${blocker.controlId}: a negative amount (${formatCredits(blocker.amountCredits)}) is never valid.`;
}

function warningText(warning: Warning): string {
  switch (warning.kind) {
    case 'zero_or_near_zero_ulb':
      return `${warning.controlId} is ${formatCredits(warning.amountCredits)} credits (≤ ${formatCredits(warning.thresholdCredits)}) — a $0/near-zero ULB hard-blocks immediately once applied.`;
    case 'multi_org_licensed_user':
      return `${warning.userLogin} is licensed via multiple orgs (${warning.orgLogins.join(', ')}) — org-budget enforcement is unpredictable for them.`;
    case 'alert_only_without_hard_stop':
      return `Turning off the hard stop on ${warning.controlId} means spend continues past the cap (alert-only). Explicit override required${warning.override.status === 'acknowledged' ? ' — justification recorded' : ''}.`;
  }
}

type AppliedArm = Extract<ApplyPlanResult, { status: 'applied' }>;
type PartialFailureArm = Extract<ApplyPlanResult, { status: 'partial_failure' }>;

function MutationLogList({ mutations }: { mutations: AppliedArm['mutationLog'] }) {
  return (
    <div className="plan-rail__mutations">
      {mutations.map((mutation) => (
        <div key={`${mutation.planEntryId}:${mutation.method}`} className="plan-rail__mutation mono">
          <div>
            {mutation.method} {mutation.path}
          </div>
          {mutation.requestBody !== undefined && <div className="plan-rail__mutation-body">{JSON.stringify(mutation.requestBody)}</div>}
        </div>
      ))}
    </div>
  );
}

function AuditEventList({ events }: { events: AppliedArm['auditEvents'] }) {
  return (
    <div className="plan-rail__audits">
      {events.map((event) => (
        <div key={event.id} className="plan-rail__audit mono">
          audit #{event.id} · {event.action} · {event.entityRef} · {event.actor}
        </div>
      ))}
    </div>
  );
}

function ApplyResultPanel({
  result,
  simulated,
  onReconcileDrift,
}: {
  result: ApplyPlanResult;
  simulated: boolean;
  onReconcileDrift: () => void;
}) {
  if (result.status === 'applied') {
    return (
      <div className="plan-rail__result plan-rail__result--applied" role="status">
        <div className="plan-rail__result-title">
          <span aria-hidden="true">✓ </span>
          {simulated
            ? 'Simulated apply — no real GitHub budget or cap was changed.'
            : 'Applied to GitHub.'}
        </div>
        <div className="plan-rail__result-sub">
          {result.appliedCount} change{result.appliedCount === 1 ? '' : 's'} issued
          {simulated ? ' against the simulation API' : ''} and recorded to the audit log.
        </div>
        <MutationLogList mutations={result.mutationLog} />
        <AuditEventList events={result.auditEvents} />
      </div>
    );
  }

  if (result.status === 'drift') {
    return (
      <div className="plan-rail__result plan-rail__result--drift" role="status">
        <div className="plan-rail__result-title">
          <span aria-hidden="true">⤺ </span>Drift — live state moved since this plan was staged.
        </div>
        <div className="plan-rail__result-sub">
          Nothing was applied and nothing was audited. Refresh live state, review your staged edits
          against it, then dry-run again.
        </div>
        <button type="button" className="plan-rail__secondary-btn" onClick={onReconcileDrift}>
          ⤺ Refresh live state &amp; re-stage
        </button>
      </div>
    );
  }

  if (result.status === 'blocked') {
    return (
      <div className="plan-rail__result plan-rail__result--blocked" role="status">
        <div className="plan-rail__result-title">
          <span aria-hidden="true">✕ </span>Apply blocked by validation — nothing was applied.
        </div>
        {result.validation.blockers.map((blocker, index) => (
          <div key={index} className="plan-rail__blocker">
            <span aria-hidden="true">✕ </span>
            {blockerText(blocker)}
          </div>
        ))}
      </div>
    );
  }

  if (result.status === 'not_armed') {
    // Task 9.3-lite §6.8: live writes are disarmed -- nothing was read,
    // mutated, or audited. Non-destructive rail message, same slot as
    // drift/blocked.
    return (
      <div className="plan-rail__result plan-rail__result--blocked" role="status">
        <div className="plan-rail__result-title">
          <span aria-hidden="true">🔒 </span>Live writes are disarmed — arm live writes in Settings before applying.
        </div>
      </div>
    );
  }

  const partial: PartialFailureArm = result;
  return (
    <div className="plan-rail__result plan-rail__result--partial" role="status">
      <div className="plan-rail__result-title">
        <span aria-hidden="true">▲ </span>Partial failure — {partial.appliedCount} change
        {partial.appliedCount === 1 ? '' : 's'} applied before "{partial.failedPlanEntryId}" failed.
      </div>
      <div className="plan-rail__result-sub">
        {partial.errorMessage} — the changes below DID apply (and are audited); re-running the plan will re-read live
        state and only replay what is left.
      </div>
      <MutationLogList mutations={partial.mutationLog} />
      <AuditEventList events={partial.auditEvents} />
    </div>
  );
}

export function PlanRail({
  plan,
  dryRun,
  dryRunStale,
  runningDryRun,
  applying,
  applyResult,
  justification,
  onJustificationChange,
  requiresHardStopOverride,
  overrideAcknowledged,
  onOverrideAcknowledgedChange,
  simulated,
  onRunDryRun,
  onApply,
  onDiscard,
  onReconcileDrift,
}: PlanRailProps) {
  const diffLines = planDiffLines(plan);
  const hasChanges = !plan.isNoOp;
  const validation = dryRun?.validation ?? null;
  const simulation = dryRun?.simulation ?? null;
  const isBlocked = validation?.isBlocked ?? false;

  // Apply gating (CLAUDE.md §6.1/§6.3/§6.4): plan non-empty AND a current
  // (non-stale) dry-run AND no blockers AND justification AND -- when the plan
  // turns a hard stop off -- the explicit override acknowledgment.
  const applyDisabled =
    !hasChanges ||
    dryRun === null ||
    dryRunStale ||
    isBlocked ||
    justification.trim() === '' ||
    (requiresHardStopOverride && !overrideAcknowledged) ||
    applying;

  const meteredDelta = simulation?.summary.totalMeteredCapacityDeltaCredits ?? 0;
  const meteredDeltaUsd = simulation?.summary.totalMeteredCapacityDeltaUsd ?? 0;
  const poolDelta = simulation?.summary.totalPoolCapacityDeltaCredits ?? 0;
  const poolDeltaUsd = simulation?.summary.totalPoolCapacityDeltaUsd ?? 0;
  const deltaText = (credits: number, usd: number): string =>
    `${credits < 0 ? '−' : '+'}${formatCredits(Math.abs(credits))} credits · ${formatUsd(usd)}`;

  return (
    <aside className="plan-rail" aria-label="Plan, simulate and apply">
      {hasChanges && (
        <div className="plan-rail__card">
          <div className="plan-rail__card-header">
            <span className="plan-rail__card-title">Plan — desired vs. live</span>
            <button type="button" className="plan-rail__discard" onClick={onDiscard}>
              Discard
            </button>
          </div>
          <div className="plan-rail__diff mono">
            {diffLines.map((line) => (
              <div key={line.key} className={`plan-rail__diff-line plan-rail__diff-line--${line.marker === '+' ? 'add' : line.marker === '~' ? 'change' : 'delete'}`}>
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {hasChanges && (
        <div className="plan-rail__card">
          <div className="plan-rail__card-header">
            <span className="plan-rail__card-title">Simulate before apply</span>
          </div>
          <div className="plan-rail__card-body">
            {simulation && (
              <>
                <div className="plan-rail__sim-tiles">
                  <div className="plan-rail__sim-tile plan-rail__sim-tile--blocked">
                    <div className="plan-rail__sim-label">Newly blocked</div>
                    <div className="plan-rail__sim-count">{simulation.summary.newlyBlockedCount}</div>
                    {simulation.newlyBlockedUserLogins.length > 0 && (
                      <div className="plan-rail__sim-users mono">{simulation.newlyBlockedUserLogins.join(', ')}</div>
                    )}
                  </div>
                  <div className="plan-rail__sim-tile plan-rail__sim-tile--unblocked">
                    <div className="plan-rail__sim-label">Newly unblocked</div>
                    <div className="plan-rail__sim-count">{simulation.summary.newlyUnblockedCount}</div>
                    {simulation.newlyUnblockedUserLogins.length > 0 && (
                      <div className="plan-rail__sim-users mono">{simulation.newlyUnblockedUserLogins.join(', ')}</div>
                    )}
                  </div>
                </div>
                <div className="plan-rail__sim-delta">
                  <span className="plan-rail__sim-delta-label">Δ metered capacity (spend ceiling)</span>
                  <span
                    className={`plan-rail__sim-delta-value ${meteredDelta > 0 ? 'plan-rail__sim-delta-value--up' : 'plan-rail__sim-delta-value--down'}`}
                  >
                    {deltaText(meteredDelta, meteredDeltaUsd)}
                  </span>
                </div>
                {poolDelta !== 0 && (
                  <div className="plan-rail__sim-delta">
                    <span className="plan-rail__sim-delta-label">Δ pool-phase capacity (ULBs)</span>
                    <span className="plan-rail__sim-delta-value">{deltaText(poolDelta, poolDeltaUsd)}</span>
                  </div>
                )}
                {validation && validation.blockers.length > 0 && (
                  <div className="plan-rail__validation">
                    {validation.blockers.map((blocker, index) => (
                      <div key={index} className="plan-rail__blocker">
                        <span aria-hidden="true">✕ </span>
                        {blockerText(blocker)}
                      </div>
                    ))}
                  </div>
                )}
                {validation && validation.warnings.length > 0 && (
                  <div className="plan-rail__validation">
                    {validation.warnings.map((warning, index) => (
                      <div key={index} className="plan-rail__warning">
                        <span aria-hidden="true">▲ </span>
                        {warningText(warning)}
                      </div>
                    ))}
                  </div>
                )}
                {dryRunStale && (
                  <div className="plan-rail__stale" role="status">
                    <span aria-hidden="true">▲ </span>Plan changed since the last dry-run — re-run the simulation to
                    continue.
                  </div>
                )}
              </>
            )}
            {!simulation && (
              <p className="plan-rail__sim-intro">
                Run a dry-run to preview who gets blocked / unblocked and the spend delta. Nothing writes until you
                apply.
              </p>
            )}
            <button type="button" className="plan-rail__dry-run-btn" onClick={onRunDryRun} disabled={runningDryRun}>
              {runningDryRun ? 'Running dry-run…' : 'Run dry-run simulation'}
            </button>

            {dryRun && (
              <div className="plan-rail__apply">
                {requiresHardStopOverride && (
                  <label className="plan-rail__override">
                    <input
                      type="checkbox"
                      checked={overrideAcknowledged}
                      onChange={(event) => onOverrideAcknowledgedChange(event.target.checked)}
                    />
                    <span>
                      <span aria-hidden="true">⚠ </span>I acknowledge: this removes the hard stop — spend can continue
                      past this limit. The override and justification are logged.
                    </span>
                  </label>
                )}
                <label className="plan-rail__just-label" htmlFor="plan-rail-justification">
                  Justification (required)
                </label>
                <textarea
                  id="plan-rail-justification"
                  className="plan-rail__just"
                  placeholder="Why this change? Ties to the audit trail."
                  value={justification}
                  onChange={(event) => onJustificationChange(event.target.value)}
                />
                {isBlocked && (
                  <div className="plan-rail__blocked-note">
                    <span aria-hidden="true">✕ </span>Apply blocked — resolve the blocker above and re-run the dry-run.
                  </div>
                )}
                <button type="button" className="plan-rail__apply-btn" onClick={onApply} disabled={applyDisabled}>
                  {applying ? 'Applying…' : simulated ? 'Apply changes (simulated)' : 'Apply changes'}
                </button>
                {simulated && (
                  <div className="plan-rail__sim-note">
                    <span aria-hidden="true">◆ </span>Simulation mode: this apply is simulated — no real GitHub budget
                    or cap will change.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rendered whenever nothing is staged -- including right after a
          successful apply, where it sits alongside the applied-result panel
          (the result is history; this card invites the next edit). */}
      {!hasChanges && (
        <div className="plan-rail__card plan-rail__empty">
          <div className="plan-rail__empty-title">No staged changes</div>
          <p className="plan-rail__empty-body">
            Edit a cap or toggle enforcement to stage a change. A Terraform-style plan and dry-run simulation appear
            here before anything writes.
          </p>
        </div>
      )}

      {applyResult && <ApplyResultPanel result={applyResult} simulated={simulated} onReconcileDrift={onReconcileDrift} />}
    </aside>
  );
}
