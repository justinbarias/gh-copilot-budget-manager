# Todo: Copilot Budget Manager — Full Spec (Post-MVP)

Checklist mirror of `docs/pending/plan.md`. One line per task; sizes in brackets. Every task additionally carries the standing CLAUDE.md §6.7 gate (Playwright e2e vs MSW **and** Chrome MCP/CDP pass) before it's checked off. Prerequisite: `SPEC.md`/`PLAN.md` MVP complete.

## Phase 4 — Full control administration (G1; FR1–FR4)

### Write foundation
- [x] 4.1 MSW mutation handlers — budgets, all scopes incl. `multi_user_cost_center` [M]
- [x] 4.2 MSW mutation handlers — cost centers + included-usage cap (`enabled`/`overflow` only, `computed_limit` re-derived) [M]
- [x] 4.3 §6.9 API-surface validation note (`docs/api-surface-validation.md`) covering every mutation endpoint [S]
- [x] 4.4 `core`: control domain model + desired-vs-live Terraform-style diff [M]
- [x] 4.5 `core`: write validations — enterprise-cap-below-sum blocker, `$0` ULB, multi-org user, hard-stop override (FR4/§6.3) [S/M]
- [x] 4.6 `core`: simulate-before-apply v1 — blocks/unblocks, precedence, lowest-headroom-wins (§6.1) [M]
- [x] 4.7 `data`: append-only hash-chained `audit_event` + chain verifier ⚠ migration — ask first [M]
- [x] 4.8 `data`: write engine (re-read → drift-abort → apply → audit) + ApiClient write surface ⚠ bridge extension — ask first [M/L]

### Checkpoint 4a — write foundation
- [x] core/data tests green; drift-abort proven; §6.9 note complete; human review of migration + bridge shape

### Control-family slices
- [x] 4.9 Controls screen shell + Spending-limits family + plan/simulate/apply right rail [L]
- [x] 4.10 ULB family — universal/individual/CCULB rows, API-ONLY badge, exact CCULB payload [M]
- [x] 4.11 Users screen — Set ULB modal + bulk-ULB modal through the rail [M]
- [x] 4.12 Included-usage caps family — per-CC cards, toggle + block/overflow, no amount input anywhere [M]
- [x] 4.13 Cost-center lifecycle writes — new-CC modal, membership, exclude toggle, Users reassignment [M]
- [ ] 4.14 ULB display-bug detection + repair banner (FR3) [S/M]
- [ ] 4.15 Controls ingestion on sync + staged/drift markers [S/M]

### Checkpoint 4 — control administration complete
- [ ] Every PRD §1.3/§1.4 control CRUD-able, API-first, no write bypasses the rail; invariants §6.1–§6.5 hold; gate green; human review
- [x] **REQUIRED (pre-Checkpoint-4, gates "§6.1–§6.5 demonstrably hold"): simulate-before-apply preview fidelity.** (Task 4.11b, fixed: `assembleUsageState` now folds the per-user metrics/CREDITS_USED report over the full 81-seat roster, cycle-filtered, reconciled against the billing report per-user without double-counting — see `packages/data/src/write/live-state.ts` and `packages/data/src/write/live-state.test.ts`.) `write/live-state.ts` `assembleUsageState` builds `usageState.users` **only** from the enterprise billing-usage report (`/settings/billing/usage`), which in the DEWR world itemises per-user rows for exactly two logins (faisal-noor, noah-tanaka); all other per-user burn lives in the metrics/CREDITS_USED report. Consequence: `simulatePlan` iterates a 2-user roster, so staging e.g. a $0 ULB for emily-zhao (5,480 MTD) previews **0 newly-blocked** — a structurally misleading §6.1 preview in a money-affecting tool. Surfaced during Task 4.11 (documented in `controls-ulb.spec.ts` / `users-ulb.spec.ts` headers as honest-given-the-data 0/0). Deferred from 4.11 because the fix is **not contained**: (a) two-report reconciliation — faisal-noor appears in **both** reports (2,300 metered billing + 4,180 metrics), so folding must not double-count; (b) `assembleUsageState` currently sums **all** billing rows (no cycle-filter — noah-tanaka's Aug/Sep cliff rows leak in), unlike `listHeavyUsers`/`listCostCenters` which cycle-filter — the fold must adopt the same `cycleBounds` window; (c) pool-vs-metered split decision (metered>0 is the spending-limit block signal — folding into pool keeps that correct); (d) seat-roster seeding. Blast radius: roster-wide before/after re-derivation flips several currently-0/0 dry-run assertions across `controls-ulb.spec.ts` (≥5 pairs; liam-obrien $0 → newly-blocked, CCULB-create/universal-raise may newly-*unblock* gap-MTD members) and `users-ulb.spec.ts` (hannah 3,000 / emily+aran 5,000 → newly-blocked). Fix = `assembleUsageState` + a new pinning data-test + recomputed CORRECT nonzero expectations in both spec files.

## Phase 5 — Forecasting (G2; FR5) *(parallel with Phase 4)*

- [ ] 5.1 Multi-cycle historical fixtures with weekday seasonality + cliff crossing [M]
- [ ] 5.2 `core`: blended run-rate + seasonality + P50/P90 + exhaustion date + 1 Sep step-change + settling window [L — split at review if needed]
- [ ] 5.3 `core`: backtest (MAPE), no look-ahead [S/M]
- [ ] 5.4 `data`: `forecast` table + compute-on-sync + `getForecast` ⚠ migration + bridge — ask first [M]
- [ ] 5.5 Forecast screen — enterprise + heavy-user scopes (burn-down w/ bands, exhaustion marker, metered bar, backtest grid) [L]
- [ ] 5.6 Forecast screen — cost-center scope: cap-on burn-down vs cap / cap-off explainer + Controls CTA [M]
- [ ] 5.7 Overview — forecast lens live, P50/P90 overlay, projected runway tiles, cliff banner [M]
- [ ] 5.8 Users — projected block date sublabels [S]

### Checkpoint 5 — forecasting complete
- [ ] All four scopes functional; Overview overlay live; gate green; human review. **4 + 5 both done before Phase 6.**

## Phase 6 — Auto-balancing, dry-run (G3/G4; FR6–FR14)

- [ ] 6.1 `core`: binding-constraint resolver — ULB-bound vs cap-bound vs budget-bound (cap never grantable, by type) [M]
- [ ] 6.2 `core`: pool trigger + funding envelope (reproduces PRD day-26 scenario) [M]
- [ ] 6.3 `core`: pool allocator — greedy, most-specific lever, cap-relax branch, Σ-ceilings safety [M]
- [ ] 6.4 `core`: pool simulation — utilisation before→after, metered-tip probability; upgrades 4.6 with forecasts [M]
- [ ] 6.5 `core`: metered rebalancer — trigger, $-envelope, binding-budget allocation, excluded-CC funding (reproduces PRD $8k scenario) [M]
- [ ] 6.6 `core`: metered simulation — bill delta, projected total, remaining headroom [S]
- [ ] 6.7 Scenario fixtures (Healthy / At risk / Surplus / metered) + sim-mode-only scenario selector + nav badges [M]
- [ ] 6.8 Auto-balance screen, pool mode — trigger card, envelope bar, editable grants table, live recompute, simulate rail (apply gated) [L]
- [ ] 6.9 Auto-balance screen, metered mode — bill-delta hero rail, per-mode allocation state [M]

### Checkpoint 6 — dry-run complete
- [ ] Both rebalancers explainable on scenario fixtures; every on-screen number traces to unit-tested core; no apply path exists; gate green
- [ ] **Decision required before Phase 7:** auto-apply appetite, reserve buffer %, rollover default (CLAUDE.md §9 Q5)

## Phase 7 — Guardrailed auto-apply + grant lifecycle + alerting (FR15–FR17)

- [ ] 7.1 `core`: guardrail engine — max grant %/abs, floors, reserve, approval threshold, reversibility [M]
- [ ] 7.2 Settings: guardrails card + rollover policy + read-only paid-usage card; policy persistence ⚠ migration — ask first [M]
- [ ] 7.3 `data`: `grant` store — lever enum incl. null-delta cap-relax, envelope snapshot, status transitions [S/M]
- [ ] 7.4 Auto-balance apply (⑤) — justification, approval gate, write engine, grant rows, full-record audit events [M/L]
- [ ] 7.5 Grant lifecycle — rollover revert/re-baseline on sync, active-grants panel, manual revert, creep-guard badge [M]
- [ ] 7.6 Custom alerting — thresholds + forecast-band anomaly detection replacing pre-baked alerts [M]
- [ ] 7.7 Alert routing per CC (Slack/Teams/email) — simulated-delivery log in sim mode, zero real egress [M]

### Checkpoint 7 — centerpiece live (in sim)
- [ ] Trigger → envelope → grants → guardrails → apply → rollover revert, all audited; grants 100% traceable; no ceiling creep in rollover test; gate green

## Phase 8 — Chargeback + audit export (G5; FR18)

- [ ] 8.1 Actions-minutes second meter — fixtures + ingestion (+ §6.9 note) [S/M]
- [ ] 8.2 `core`: chargeback pivot — Division→Branch→Project × credits/metered $/Actions minutes, totals reconcile [S/M]
- [ ] 8.3 Chargeback screen + CSV export (PDF = open question) [M]
- [ ] 8.4 Audit screen — filters, before→after expansion, trigger/envelope blocks for grants [M]
- [ ] 8.5 Audit export + hash-chain verify surface (tamper pinpointing) [S]
- [ ] 8.6 Help screen — last stub removed [S]

### Checkpoint 8 — feature-complete in simulation mode
- [ ] All 9 IA screens + Help functional, zero stubs; full-suite + full Chrome MCP sweep green; PRD §3.5 metrics demonstrable

## Phase 9 — Live-tenant enablement + RBAC (FR19) — GATED

**Entry gate:** CLAUDE.md §9's five answers recorded in README + classic PAT (`manage_billing:enterprise`) + maintainer go-ahead.

- [ ] 9.1 Tenant config, GHE host swap, API-version header everywhere, real PAT scope validation [M]
- [ ] 9.2 Live read smoke — shape reconciliation, §6.9 rows upgraded to "confirmed against live", MSW corrected [M]
- [ ] 9.3 Read/write token separation, live-write arming flow, RBAC-lite roles [M]
- [ ] 9.4 First guarded live write + drift reconcile + revert; runbook (`docs/live-write-runbook.md`) [S/M]
- [ ] 9.5 Tenant-shape feature gating (Business vs Enterprise, paid-usage off, pool posture defaults) [M]

### Checkpoint 9 — done
- [ ] Live mode operational under separation of duties; sim mode still first-class; all §6 invariants re-verified live; final sign-off

---

## Standing rules (every task)
- Playwright e2e (headless, `_electron.launch()`, MSW) **and** Chrome MCP via raw CDP — both green or not done (§6.7).
- New/changed hand-wrapped GitHub calls → row in `docs/api-surface-validation.md` (§6.9).
- Money-affecting math: pure `packages/core`, unit-tested before I/O wiring; `asOfDate` explicit, never wall-clock.
- Migrations and preload-bridge/ApiClient extensions are ask-first, batched per phase.
- Simulation mode: banner unmistakable, applies visibly simulated, zero non-MSW egress.
