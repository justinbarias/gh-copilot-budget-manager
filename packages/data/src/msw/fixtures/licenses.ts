// DEWR's Copilot seat roster (README.md §Personas). 81 licensed seats, one per
// person, each attributed to exactly one cost center (see costCenters.ts's
// COST_CENTER_RESOURCES). Logins are realistic Australian-public-service GitHub
// handles (name-derived, a handful of external contractors prefixed `ext-`),
// never sequential ids -- numeric `id`s are equal-width so rankHeavyUsers'
// localeCompare tie-break on the id string stays lexicographically sane.
//
// Adoption curve (CLAUDE.md §7 "not happy-path shells"): the majority of seats
// carry ZERO cycle-to-date usage (no CREDITS_USED_ITEMS row -- they exercise
// the Users screen's "No usage" filter and empty sparkline). A cohort of heavy
// users drives consumption; see usage.ts. `last_activity_at` is a fixed instant
// inside the June cycle, deterministic across runs (never wall-clock).
export interface CopilotSeat {
  assignee: { login: string; id: number; type: 'User' };
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  last_activity_editor: string | null;
  plan_type: 'business' | 'enterprise';
}

export const SEATS: CopilotSeat[] = [
  { assignee: { login: 'liam-obrien', id: 5107, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'sarah-huang', id: 6218, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'rpatel2', id: 4471, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'd-okafor', id: 7043, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'jr-mitchell', id: 5389, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'amir-haddad', id: 8102, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'claire-donnelly', id: 4630, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'wei-lin', id: 6884, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ben-fraser', id: 5560, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'noah-tanaka', id: 7219, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'tania-osei', id: 9000, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'mark-vuong', id: 9013, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'hana-said', id: 9026, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'isaac-cole', id: 9039, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'georgia-pappas', id: 9052, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'dan-mercer', id: 9065, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ruth-abela', id: 9078, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'kofi-asante', id: 9091, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'yara-haddad', id: 9104, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'liam-park', id: 9117, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'nora-quinn', id: 9130, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ellis-tran', id: 9143, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'brayden-ivanov', id: 9156, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'sana-qureshi', id: 9169, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'hannah-webb', id: 5921, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'george-apostol', id: 4088, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'nadia-rahman', id: 7710, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'oscar-lindgren', id: 6355, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ext-pshah', id: 4902, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ivy-cheng', id: 8261, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'declan-ryan', id: 9182, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'mona-eldib', id: 9195, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ravi-krishnan', id: 9208, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'sam-porter', id: 9221, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'beatrix-cho', id: 9234, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'lachlan-reid', id: 9247, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'tegan-ellis', id: 9260, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'omar-said', id: 9273, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'freya-nilsson', id: 9286, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'hamish-doyle', id: 9299, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'faisal-noor', id: 5044, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'grace-omalley', id: 6627, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'hugo-almeida', id: 4319, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ling-zhou', id: 7856, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'yusuf-demir', id: 5271, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'peter-nkosi', id: 8408, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'sofia-marin', id: 4763, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'dev-raman', id: 9312, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'emily-zhao', id: 5182, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'aran-mehta', id: 6749, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'kirsty-boyd', id: 4205, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'diego-santos', id: 7532, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'wendy-oakes', id: 5896, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'raymond-li', id: 8017, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'nadia-osei', id: 9325, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'holly-nguyen', id: 9338, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'callum-frost', id: 9351, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'sam-kelly', id: 5613, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ruby-carter', id: 4488, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'omar-farah', id: 7126, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'lucas-meyer', id: 6042, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'nina-popov', id: 9364, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'seb-rowe', id: 9377, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'aria-fahey', id: 9390, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'jomo-mburu', id: 9403, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'kate-ellery', id: 9416, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ext-tlau', id: 9429, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'priyanka-nair', id: 9442, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'karen-fox', id: 5934, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ali-rezaei', id: 4177, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'josh-bright', id: 7605, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'mia-larsson', id: 6488, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ext-dmorrow', id: 8890, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'tom-becker', id: 9455, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'wei-sun', id: 9468, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'colin-hurst', id: 9481, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'devi-anand', id: 9494, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'blake-ferris', id: 9507, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'noor-jaber', id: 9520, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'gina-lombardi', id: 9533, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
  { assignee: { login: 'ext-rknott', id: 9546, type: 'User' }, created_at: '2026-05-18T00:00:00Z', updated_at: '2026-06-13T00:00:00Z', last_activity_at: '2026-06-12T23:14:00Z', last_activity_editor: 'vscode/1.104.2', plan_type: 'enterprise' },
];


