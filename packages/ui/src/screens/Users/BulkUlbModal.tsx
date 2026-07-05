import type { HeavyUser } from '@copilot-budget/data';
import { UlbPlanModal } from './UlbPlanModal';

// Multi-select -> "Set ULB for N users" (design/README.md §6): one credits
// value staged as N BudgetControls (an add per user without an existing
// individual override, a change per user who already has one) -> N plan
// entries -> the write engine issues N mutations, per Task 4.11's acceptance
// criteria. A thin parameterization of the shared UlbPlanModal (users: the
// full selection); see that file's doc comment for the staging/dry-run/apply
// logic this reuses unchanged from the individual modal.
export interface BulkUlbModalProps {
  users: readonly HeavyUser[];
  onClose: () => void;
  onApplied: (message: string) => void;
}

export function BulkUlbModal({ users, onClose, onApplied }: BulkUlbModalProps) {
  return (
    <UlbPlanModal
      users={users}
      title={`Bulk ULB — ${users.length} users`}
      ariaLabel={`Bulk ULB override for ${users.length} users`}
      amountLabel="New per-user limit for all selected (credits)"
      onClose={onClose}
      onApplied={onApplied}
    />
  );
}
