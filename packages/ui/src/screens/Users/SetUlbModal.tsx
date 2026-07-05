import type { HeavyUser } from '@copilot-budget/data';
import { UlbPlanModal } from './UlbPlanModal';

// Row "Set ULB" (design/README.md §6): a single staged BudgetControl --
// exactly what NewUlbModal.onCreate emits for scope 'individual' -- but
// carried all the way through simulate-before-apply here, since this modal
// applies rather than just stages (Task 4.10's handoff note). A thin
// parameterization of the shared UlbPlanModal (users: [user]); see that
// file's doc comment for why the staging/dry-run/apply logic lives there.
export interface SetUlbModalProps {
  user: HeavyUser;
  onClose: () => void;
  onApplied: (message: string) => void;
}

export function SetUlbModal({ user, onClose, onApplied }: SetUlbModalProps) {
  return (
    <UlbPlanModal
      users={[user]}
      title={
        <>
          Individual ULB override — <span className="mono">{user.userLogin}</span>
        </>
      }
      ariaLabel={`Individual ULB override — ${user.userLogin}`}
      amountLabel="New per-user limit (credits)"
      onClose={onClose}
      onApplied={onApplied}
    />
  );
}
