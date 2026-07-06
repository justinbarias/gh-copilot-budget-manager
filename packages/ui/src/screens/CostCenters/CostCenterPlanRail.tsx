import { INCLUDED_CAP_CREDITS_PER_SEAT, type Plan } from '@copilot-budget/core';
import type { ApplyPlanResult, DryRunResult } from '@copilot-budget/data';
import '../Controls/PlanRail.css';
import './CostCenterPlanRail.css';

// Task 4.13: the plan -> simulate -> apply rail for cost-center lifecycle
// writes. It is a sibling of Controls/PlanRail (same staged->dry-run->apply
// contract, the universal write pattern from design/README.md "Interactions"),
// deliberately NOT a reuse of it: PlanRail's diff renderer (planDiffLines) only
// knows the budget/included_cap plan shapes, and CLAUDE.md's slice keeps
// PlanRail's internals untouched. This rail renders the cost_center plan shape
// (create / archive / DEWR + exclude / membership add-remove) and reuses the
// same core Plan + the same dryRunPlan/applyPlan bridge methods, so the
// diff/simulation/audit/§6.8-simulated evidence are all honest, not faked.

export interface CostCenterPlanRailProps {
  plan: Plan;
  dryRun: DryRunResult | null;
  dryRunStale: boolean;
  runningDryRun: boolean;
  applying: boolean;
  applyResult: ApplyPlanResult | null;
  justification: string;
  onJustificationChange: (value: string) => void;
  /** §6.8: simulation mode -- the apply affordance + result read as visibly simulated. */
  simulated: boolean;
  onRunDryRun: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onReconcileDrift: () => void;
}

type DiffMarker = '+' | '~' | '-';

interface DiffLine {
  key: string;
  marker: DiffMarker;
  text: string;
}

function capSummary(cap: { enabled: boolean; overflow: 'block' | 'metered' }): string {
  return cap.enabled ? `cap on · ${cap.overflow}` : 'cap off';
}

// Terraform-style lines for the cost_center plan shape only (the cost-center
// modals never stage budgets/caps, so non-cost_center entries are skipped
// rather than mis-rendered).
export function costCenterDiffLines(plan: Plan): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const entry of plan.entries) {
    if (entry.controlKind !== 'cost_center') continue;
    const label = `cost_center["${entry.name}"]`;
    if (entry.action === 'add') {
      const d = entry.desired;
      lines.push({
        key: `${entry.id}:add`,
        marker: '+',
        text: `+ ${label}: create · ${d.dewrDivision} → ${d.dewrBranch} → ${d.dewrProject} · ${d.excludedFromEnterpriseBudget ? 'excluded from ent. budget' : 'in ent. budget'} · ${capSummary(d.includedUsageCap)}`,
      });
      for (const r of d.members) {
        lines.push({ key: `${entry.id}:member:${r.type}:${r.name}`, marker: '+', text: `+ ${label}.member: ${r.name}` });
      }
    } else if (entry.action === 'delete') {
      lines.push({ key: `${entry.id}:delete`, marker: '-', text: `- ${label}: archive / delete` });
    } else {
      for (const change of entry.changes) {
        if (change.field === 'membership') {
          for (const r of change.removed) {
            lines.push({ key: `${entry.id}:rm:${r.type}:${r.name}`, marker: '-', text: `- ${label}.member: ${r.name}` });
          }
          for (const r of change.added) {
            lines.push({ key: `${entry.id}:add:${r.type}:${r.name}`, marker: '+', text: `+ ${label}.member: ${r.name}` });
          }
          // Preview the license-derived included-usage-cap shift this membership
          // delta causes (core recomputes it as seatDelta x 7,000). On a move,
          // the source CC shows -7,000 and the target +7,000 -- both sides of
          // the move are visible before any write (maintainer ruling §2).
          const seatDelta =
            change.added.filter((r) => r.type === 'User').length - change.removed.filter((r) => r.type === 'User').length;
          if (seatDelta !== 0) {
            const credits = seatDelta * INCLUDED_CAP_CREDITS_PER_SEAT;
            const magnitude = Math.abs(seatDelta);
            lines.push({
              key: `${entry.id}:cap-shift`,
              marker: '~',
              text: `~ included_cap["${entry.name}"]: ${credits > 0 ? '+' : '−'}${Math.abs(credits).toLocaleString('en-US')} credits (${magnitude} seat${magnitude === 1 ? '' : 's'} ${seatDelta > 0 ? 'added' : 'removed'})`,
            });
          }
        } else if (change.field === 'excludedFromEnterpriseBudget') {
          lines.push({
            key: `${entry.id}:excluded`,
            marker: '~',
            text: `~ ${label}.excluded_from_enterprise_budget: ${String(change.old)} → ${String(change.new)}`,
          });
        } else {
          lines.push({ key: `${entry.id}:${change.field}`, marker: '~', text: `~ ${label}.${change.field}: ${change.old} → ${change.new}` });
        }
      }
    }
  }
  return lines;
}

type Validation = DryRunResult['validation'];

function blockerText(blocker: Validation['blockers'][number]): string {
  if (blocker.kind === 'enterprise_cap_below_cost_center_sum') {
    return `Enterprise cap (${blocker.enterpriseCapCredits.toLocaleString('en-US')}) is below the sum of non-excluded cost-center spending limits (${blocker.costCenterSumCredits.toLocaleString('en-US')}).`;
  }
  return `${blocker.controlId}: a negative amount (${blocker.amountCredits.toLocaleString('en-US')}) is never valid.`;
}

type AppliedArm = Extract<ApplyPlanResult, { status: 'applied' }>;
type PartialFailureArm = Extract<ApplyPlanResult, { status: 'partial_failure' }>;

function MutationLogList({ mutations }: { mutations: AppliedArm['mutationLog'] }) {
  return (
    <div className="plan-rail__mutations">
      {mutations.map((mutation, index) => (
        <div key={`${mutation.planEntryId}:${mutation.method}:${index}`} className="plan-rail__mutation mono">
          <div>
            {mutation.method} {mutation.path}
          </div>
          {mutation.requestBody !== undefined && (
            <div className="plan-rail__mutation-body">{JSON.stringify(mutation.requestBody)}</div>
          )}
          {/* The mutation response carries the recomputed included-usage-cap
              limit on a membership change (Task 4.2 enrichment) -- surfaced as
              evidence so the admin sees the license-derived limit shift. */}
          {mutation.responseBody !== undefined && mutation.responseBody !== null && (
            <div className="cc-plan-rail__mutation-response">{JSON.stringify(mutation.responseBody)}</div>
          )}
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
          {simulated ? 'Simulated apply — no real GitHub cost center was changed.' : 'Applied to GitHub.'}
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
          Nothing was applied and nothing was audited. Refresh live state and re-stage.
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

  const partial: PartialFailureArm = result;
  return (
    <div className="plan-rail__result plan-rail__result--partial" role="status">
      <div className="plan-rail__result-title">
        <span aria-hidden="true">▲ </span>Partial failure — {partial.appliedCount} change
        {partial.appliedCount === 1 ? '' : 's'} applied before "{partial.failedPlanEntryId}" failed.
      </div>
      <div className="plan-rail__result-sub">{partial.errorMessage}</div>
      <MutationLogList mutations={partial.mutationLog} />
      <AuditEventList events={partial.auditEvents} />
    </div>
  );
}

export function CostCenterPlanRail({
  plan,
  dryRun,
  dryRunStale,
  runningDryRun,
  applying,
  applyResult,
  justification,
  onJustificationChange,
  simulated,
  onRunDryRun,
  onApply,
  onDiscard,
  onReconcileDrift,
}: CostCenterPlanRailProps) {
  const diffLines = costCenterDiffLines(plan);
  const hasChanges = !plan.isNoOp;
  const validation = dryRun?.validation ?? null;
  const simulation = dryRun?.simulation ?? null;
  const isBlocked = validation?.isBlocked ?? false;

  const applyDisabled =
    !hasChanges || dryRun === null || dryRunStale || isBlocked || justification.trim() === '' || applying;

  return (
    <aside className="plan-rail cc-plan-rail" aria-label="Plan, simulate and apply">
      {hasChanges ? (
        <>
          <div className="plan-rail__card">
            <div className="plan-rail__card-header">
              <span className="plan-rail__card-title">Plan — desired vs. live</span>
              <button type="button" className="plan-rail__discard" onClick={onDiscard}>
                Discard
              </button>
            </div>
            <div className="plan-rail__diff mono">
              {diffLines.map((line) => (
                <div
                  key={line.key}
                  className={`plan-rail__diff-line plan-rail__diff-line--${line.marker === '+' ? 'add' : line.marker === '~' ? 'change' : 'delete'}`}
                >
                  {line.text}
                </div>
              ))}
            </div>
          </div>

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
                  Run a dry-run to preview who gets blocked / unblocked. Nothing writes until you apply.
                </p>
              )}
              <button type="button" className="plan-rail__dry-run-btn" onClick={onRunDryRun} disabled={runningDryRun}>
                {runningDryRun ? 'Running dry-run…' : 'Run dry-run simulation'}
              </button>

              {dryRun && (
                <div className="plan-rail__apply">
                  <label className="plan-rail__just-label" htmlFor="cc-plan-rail-justification">
                    Justification (required)
                  </label>
                  <textarea
                    id="cc-plan-rail-justification"
                    className="plan-rail__just"
                    placeholder="Why this change? Ties to the audit trail."
                    value={justification}
                    onChange={(event) => onJustificationChange(event.target.value)}
                  />
                  <button type="button" className="plan-rail__apply-btn" onClick={onApply} disabled={applyDisabled}>
                    {applying ? 'Applying…' : simulated ? 'Apply changes (simulated)' : 'Apply changes'}
                  </button>
                  {simulated && (
                    <div className="plan-rail__sim-note">
                      <span aria-hidden="true">◆ </span>Simulation mode: this apply is simulated — no real GitHub cost
                      center will change.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="plan-rail__card plan-rail__empty">
          <div className="plan-rail__empty-title">No staged changes</div>
          <p className="plan-rail__empty-body">Edit membership, the exclude flag, or create a cost center to stage a change.</p>
        </div>
      )}

      {applyResult && <ApplyResultPanel result={applyResult} simulated={simulated} onReconcileDrift={onReconcileDrift} />}
    </aside>
  );
}
