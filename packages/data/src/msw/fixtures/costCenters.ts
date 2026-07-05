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
  // GitHub-reported cycle-to-date credit total (billing view) for the cost
  // center. The billing report and the per-user metrics report (CREDITS_USED_
  // ITEMS) are two different GitHub APIs (PRD §2.3: no single API gives both),
  // so mtd_burn_credits (this team total) is >= the sum of its members'
  // attributed CREDITS_USED burns -- the gap is shared/automated pool draw
  // (code-review Actions, CI Copilot, service accounts) the per-user metrics
  // report doesn't attribute. For the two crisis CCs (Payments Integrity,
  // Data & Evaluation) that gap is large by design; see README.md §Coherence.
  mtd_burn_credits: number;
  included_usage_cap: IncludedUsageCapState;
  excluded_from_enterprise_budget: boolean;
}

export interface CostCenterResource {
  // 'EnterpriseTeam' (Task 4.2): the resource-mutation endpoint additionally
  // accepts assigning a whole enterprise team as a resource (PRD §2.2 --
  // "enterprise teams keep membership in sync via IdP/SCIM"). Existing read
  // fixtures below only ever use 'User'/'Org'/'Repo'; this is a superset
  // widening for the new mutation handlers, not a change to committed data.
  type: 'User' | 'Org' | 'Repo' | 'EnterpriseTeam';
  name: string;
  // Simulation-model enrichment (not a documented GitHub field): membership
  // provenance when the user was attributed via an enterprise-team resource
  // (PRD §2: cost-center resources include enterprise teams). Drives the
  // "ent-team: ..." badges in the Cost Centers drill modal.
  via_ent_team?: string;
}

// Task 4.2: a stateless mock can't call out to an IdP/SCIM to expand an
// EnterpriseTeam resource into its real member roster, so membership-mutation
// responses that add/remove an EnterpriseTeam resource approximate its seat
// count from this static lookup (falling back to DEFAULT_ENTERPRISE_TEAM_SEATS
// for any team not listed). This is a pure simulation convenience -- flagged
// in the §6.9-pending list for Task 4.3 since the real API's expansion
// mechanics aren't something MSW can faithfully reproduce.
export const ENTERPRISE_TEAM_SEAT_COUNTS: Record<string, number> = {
  'payments-eng': 6,
  assurance: 4,
  'eval-guild': 5,
  'idam-core': 3,
};
export const DEFAULT_ENTERPRISE_TEAM_SEATS = 1;

// The six DEWR cost centers (README.md §Org chart). Every member holds a seat
// in licenses.ts, so computed_limit_credits == members × 7,000 and the six
// caps sum to the enterprise pool allowance (567,000) exactly.
export const COST_CENTERS: CostCenter[] = [
  {
    id: COST_CENTER_IDS.workforce,
    name: 'Workforce Australia Platform',
    state: 'active',
    dewr_division: 'Employment Systems Group',
    dewr_branch: 'Digital Delivery Branch',
    dewr_project: 'WFA-DIGITAL',
    mtd_burn_credits: 30_200, // 24 seats, well within cap -- the flagship delivery team
    included_usage_cap: { enabled: true, computed_limit_credits: 168_000, overflow: 'block' }, // 24 × 7,000
    excluded_from_enterprise_budget: false,
  },
  {
    id: COST_CENTER_IDS.employer,
    name: 'Employer & Provider Portals',
    state: 'active',
    dewr_division: 'Employment Systems Group',
    dewr_branch: 'Employer Engagement Branch',
    dewr_project: 'PROVIDER-PORTAL',
    mtd_burn_credits: 18_900,
    included_usage_cap: { enabled: true, computed_limit_credits: 112_000, overflow: 'block' }, // 16 × 7,000
    excluded_from_enterprise_budget: false,
  },
  // Crisis fixture: this team has fully consumed its GitHub-computed
  // included-usage cap for the pool phase (56,000 pool draw) and overflowed
  // 2,300 credits into metered. Both are itemised in USAGE_ITEMS (the 56,000 as
  // discount-covered CC-aggregate pool rows, the 2,300 as a metered row), so
  // the enterprise pool burn-down reflects this CC's pool draw -- a cost
  // center's pool draw IS enterprise pool consumption (CLAUDE.md §5). The
  // breach is driven by shared/automated usage, not by individual ULB overruns
  // (its members all sit within their 4,600 universal ULB) -- so the remedy is
  // the cap/overflow lever, never a ULB grant (CLAUDE.md §5). mtd_burn_credits
  // (58,300) is the GitHub-reported billing total.
  {
    id: COST_CENTER_IDS.capBound,
    name: 'Payments Integrity Engineering',
    state: 'active',
    dewr_division: 'Corporate & Enabling Services',
    dewr_branch: 'Payments Technology Branch',
    dewr_project: 'PAYMENTS-ASSURANCE',
    mtd_burn_credits: 58_300, // 56,000 pool (== cap) + 2,300 metered overflow
    included_usage_cap: { enabled: true, computed_limit_credits: 56_000, overflow: 'metered' }, // 8 × 7,000
    excluded_from_enterprise_budget: false,
  },
  // Amber fixture: within cap but low headroom (63,000 − 57,400 = 5,600 <
  // LOW_HEADROOM_THRESHOLD_CREDITS 8,000). On track to breach around mid-cycle
  // -- the "watch this one" cost center. Carries a CCULB (Family A) and the one
  // hard-stop-ON cost-center spending limit (Family B); see budgets.ts.
  {
    id: COST_CENTER_IDS.dataEval,
    name: 'Data & Evaluation Platform',
    state: 'active',
    dewr_division: 'Data, Analytics & Evaluation Group',
    dewr_branch: 'Data Platforms Branch',
    dewr_project: 'EVAL-WAREHOUSE',
    mtd_burn_credits: 57_400,
    included_usage_cap: { enabled: true, computed_limit_credits: 63_000, overflow: 'block' }, // 9 × 7,000
    excluded_from_enterprise_budget: false,
  },
  {
    id: COST_CENTER_IDS.cyber,
    name: 'Cyber & Identity Services',
    state: 'active',
    dewr_division: 'Digital & Technology Group',
    dewr_branch: 'Cyber Security Branch',
    dewr_project: 'IDAM-UPLIFT',
    mtd_burn_credits: 15_000,
    included_usage_cap: { enabled: true, computed_limit_credits: 77_000, overflow: 'block' }, // 11 × 7,000
    excluded_from_enterprise_budget: false,
  },
  {
    id: COST_CENTER_IDS.corporate,
    name: 'Corporate Systems',
    state: 'active',
    dewr_division: 'Corporate & Enabling Services',
    dewr_branch: 'Enterprise Applications Branch',
    dewr_project: 'HR-FIN-SYSTEMS',
    mtd_burn_credits: 12_300,
    included_usage_cap: { enabled: true, computed_limit_credits: 91_000, overflow: 'block' }, // 13 × 7,000
    excluded_from_enterprise_budget: false,
  },
];

// Membership: every licensed seat (licenses.ts) attributed to exactly one CC.
// A few members carry via_ent_team provenance (drill-modal badges). Generated
// from the hand-authored roster; see README.md §Personas.
export const COST_CENTER_RESOURCES: Record<string, CostCenterResource[]> = {
  [COST_CENTER_IDS.workforce]: [
    { type: 'User', name: 'liam-obrien', via_ent_team: 'payments-eng' },
    { type: 'User', name: 'sarah-huang', via_ent_team: 'payments-eng' },
    { type: 'User', name: 'rpatel2' },
    { type: 'User', name: 'd-okafor' },
    { type: 'User', name: 'jr-mitchell' },
    { type: 'User', name: 'amir-haddad' },
    { type: 'User', name: 'claire-donnelly' },
    { type: 'User', name: 'wei-lin' },
    { type: 'User', name: 'ben-fraser' },
    { type: 'User', name: 'noah-tanaka' },
    { type: 'User', name: 'tania-osei' },
    { type: 'User', name: 'mark-vuong' },
    { type: 'User', name: 'hana-said' },
    { type: 'User', name: 'isaac-cole' },
    { type: 'User', name: 'georgia-pappas' },
    { type: 'User', name: 'dan-mercer' },
    { type: 'User', name: 'ruth-abela' },
    { type: 'User', name: 'kofi-asante' },
    { type: 'User', name: 'yara-haddad' },
    { type: 'User', name: 'liam-park' },
    { type: 'User', name: 'nora-quinn' },
    { type: 'User', name: 'ellis-tran' },
    { type: 'User', name: 'brayden-ivanov' },
    { type: 'User', name: 'sana-qureshi' },
  ],
  [COST_CENTER_IDS.employer]: [
    { type: 'User', name: 'hannah-webb' },
    { type: 'User', name: 'george-apostol' },
    { type: 'User', name: 'nadia-rahman' },
    { type: 'User', name: 'oscar-lindgren' },
    { type: 'User', name: 'ext-pshah' },
    { type: 'User', name: 'ivy-cheng' },
    { type: 'User', name: 'declan-ryan' },
    { type: 'User', name: 'mona-eldib' },
    { type: 'User', name: 'ravi-krishnan' },
    { type: 'User', name: 'sam-porter' },
    { type: 'User', name: 'beatrix-cho' },
    { type: 'User', name: 'lachlan-reid' },
    { type: 'User', name: 'tegan-ellis' },
    { type: 'User', name: 'omar-said' },
    { type: 'User', name: 'freya-nilsson' },
    { type: 'User', name: 'hamish-doyle' },
  ],
  [COST_CENTER_IDS.capBound]: [
    { type: 'User', name: 'faisal-noor', via_ent_team: 'assurance' },
    { type: 'User', name: 'grace-omalley', via_ent_team: 'assurance' },
    { type: 'User', name: 'hugo-almeida' },
    { type: 'User', name: 'ling-zhou' },
    { type: 'User', name: 'yusuf-demir' },
    { type: 'User', name: 'peter-nkosi' },
    { type: 'User', name: 'sofia-marin' },
    { type: 'User', name: 'dev-raman' },
  ],
  [COST_CENTER_IDS.dataEval]: [
    { type: 'User', name: 'emily-zhao', via_ent_team: 'eval-guild' },
    { type: 'User', name: 'aran-mehta' },
    { type: 'User', name: 'kirsty-boyd' },
    { type: 'User', name: 'diego-santos' },
    { type: 'User', name: 'wendy-oakes' },
    { type: 'User', name: 'raymond-li' },
    { type: 'User', name: 'nadia-osei' },
    { type: 'User', name: 'holly-nguyen' },
    { type: 'User', name: 'callum-frost' },
  ],
  [COST_CENTER_IDS.cyber]: [
    { type: 'User', name: 'sam-kelly' },
    { type: 'User', name: 'ruby-carter' },
    { type: 'User', name: 'omar-farah' },
    { type: 'User', name: 'lucas-meyer' },
    { type: 'User', name: 'nina-popov' },
    { type: 'User', name: 'seb-rowe' },
    { type: 'User', name: 'aria-fahey' },
    { type: 'User', name: 'jomo-mburu' },
    { type: 'User', name: 'kate-ellery' },
    { type: 'User', name: 'ext-tlau' },
    { type: 'User', name: 'priyanka-nair' },
  ],
  [COST_CENTER_IDS.corporate]: [
    { type: 'User', name: 'karen-fox' },
    { type: 'User', name: 'ali-rezaei' },
    { type: 'User', name: 'josh-bright' },
    { type: 'User', name: 'mia-larsson' },
    { type: 'User', name: 'ext-dmorrow' },
    { type: 'User', name: 'tom-becker' },
    { type: 'User', name: 'wei-sun' },
    { type: 'User', name: 'colin-hurst' },
    { type: 'User', name: 'devi-anand' },
    { type: 'User', name: 'blake-ferris' },
    { type: 'User', name: 'noor-jaber' },
    { type: 'User', name: 'gina-lombardi' },
    { type: 'User', name: 'ext-rknott' },
  ],
};


