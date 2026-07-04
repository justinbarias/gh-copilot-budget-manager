import { COST_CENTER_IDS } from './constants.js';

// Included-usage cap (CLAUDE.md §5 "Lever C"): GitHub auto-computes the limit
// from the licenses attributed to the cost center (promo enterprise:
// 7,000 credits/seat) -- it is never a settable amount. The mock mirrors that:
// computed_limit_credits is a read-only, license-derived value (members x
// 7,000 here, since every fixture member holds a seat in licenses.ts), and
// the only knobs GitHub exposes are enabled + overflow.
export interface IncludedUsageCapState {
  enabled: boolean;
  computed_limit_credits: number;
  overflow: 'block' | 'metered';
}

// Wire shape the mock returns for the 2026-dated, hand-rolled enterprise
// cost-centers billing endpoint (not in Octokit's typed catalog -- see
// github-impl.ts's paginateAll note + CLAUDE.md §6.9). GitHub attributes
// resources to a cost center; the DEWR mapping and the pre-aggregated
// mtd_burn_credits are simulation conveniences layered on top (mtd reconciles
// with USAGE_ITEMS, below), kept distinct from GitHub's documented resource
// surface the same way CostCenterResource.via_ent_team is flagged.
export interface CostCenter {
  id: string;
  name: string;
  state: 'active' | 'archived';
  // DEWR mapping lives as columns on the cost-center row (PLAN.md
  // Architecture Decisions), so the wire shape carries them flat too.
  dewr_division: string;
  dewr_branch: string;
  dewr_project: string;
  // GitHub-reported cycle-to-date credit total for the cost center. Reconciles
  // with the sum of the cost center's itemised USAGE_ITEMS rows in the current
  // (June 2026) cycle -- including the cap-bound CC, whose 70,000 pool draw and
  // 500 metered overflow are both itemised (see the cap-bound note below).
  mtd_burn_credits: number;
  included_usage_cap: IncludedUsageCapState;
  excluded_from_enterprise_budget: boolean;
}

export interface CostCenterResource {
  type: 'User' | 'Org' | 'Repo';
  name: string;
  // Simulation-model enrichment (not a documented GitHub field): membership
  // provenance when the user was attributed via an enterprise-team resource
  // (PRD §2: cost-center resources include enterprise teams). Drives the
  // "ent-team: ..." badges in the Cost Centers drill modal.
  via_ent_team?: string;
}

export const COST_CENTERS: CostCenter[] = [
  {
    id: COST_CENTER_IDS.platform,
    name: 'Platform',
    state: 'active',
    dewr_division: 'Digital Services',
    dewr_branch: 'Platform Engineering',
    dewr_project: 'PLAT-CORE',
    mtd_burn_credits: 420, // = its 2026-06-14 USAGE_ITEMS row
    included_usage_cap: { enabled: true, computed_limit_credits: 105_000, overflow: 'block' }, // 15 seats x 7,000
    excluded_from_enterprise_budget: false,
  },
  {
    id: COST_CENTER_IDS.dataAnalytics,
    name: 'Data & Analytics',
    state: 'active',
    dewr_division: 'Data Group',
    dewr_branch: 'Insights',
    dewr_project: 'DATA-INS',
    mtd_burn_credits: 310, // = its 2026-06-14 USAGE_ITEMS row
    included_usage_cap: { enabled: true, computed_limit_credits: 70_000, overflow: 'block' }, // 10 seats x 7,000
    excluded_from_enterprise_budget: false,
  },
  // Edge fixture: this team has fully consumed its GitHub-computed included-usage
  // cap for the pool phase (70,000 pool draw) and overflowed 500 credits into
  // metered. Both are itemised in USAGE_ITEMS (the 70,000 as a discount-covered
  // CC-aggregate pool row, the 500 as a metered row), so the enterprise pool
  // burn-down correctly reflects this CC's pool draw -- a cost center's pool draw
  // IS enterprise pool consumption (CLAUDE.md §5). mtd_burn_credits (70,500) is
  // the GitHub-reported total and reconciles with those two rows.
  {
    id: COST_CENTER_IDS.capBound,
    name: 'Marketing (Cap-Bound)',
    state: 'active',
    dewr_division: 'Corporate Services',
    dewr_branch: 'Marketing & Communications',
    dewr_project: 'MKT-GROWTH',
    mtd_burn_credits: 70_500,
    included_usage_cap: { enabled: true, computed_limit_credits: 70_000, overflow: 'metered' }, // 10 seats x 7,000
    excluded_from_enterprise_budget: false,
  },
];

function userResources(logins: string[], entTeamByLogin: Record<string, string> = {}): CostCenterResource[] {
  return logins.map((name) => {
    const via = entTeamByLogin[name];
    return via ? { type: 'User' as const, name, via_ent_team: via } : { type: 'User' as const, name };
  });
}

function seatLogin(n: number): string {
  return `user-${String(n).padStart(2, '0')}`;
}

export const COST_CENTER_RESOURCES: Record<string, CostCenterResource[]> = {
  [COST_CENTER_IDS.platform]: userResources(
    Array.from({ length: 15 }, (_, i) => seatLogin(i + 1)),
    { 'user-01': 'payments', 'user-02': 'payments' },
  ),
  [COST_CENTER_IDS.dataAnalytics]: userResources(
    Array.from({ length: 10 }, (_, i) => seatLogin(i + 16)),
    { 'user-16': 'ai-eval' },
  ),
  [COST_CENTER_IDS.capBound]: userResources(
    Array.from({ length: 10 }, (_, i) => seatLogin(i + 26)),
    { 'user-26': 'mkt-growth', 'user-27': 'mkt-growth' },
  ),
};
