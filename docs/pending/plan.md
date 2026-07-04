# Implementation Plan: Copilot Budget Manager — Full Spec (Post-MVP)

**Source spec:** `docs/copilot-budget-manager-prd-spec.md` (v0.2) — all features.
**Prerequisite artifacts (assumed complete):** `SPEC.md` + `PLAN.md` — the MVP (simulation harness + read-only observability, PLAN.md Phases 0–3).
**Companion docs:** `CLAUDE.md` (architecture, invariants, verification gate), `design/README.md` (high-fidelity UI handoff — all 9 screens are specified there).

## Overview

This plan covers everything in the PRD that the MVP deliberately excluded, one feature per phase: **full control administration** (G1, FR1–FR4), **forecasting** (G2, FR5), **auto-balancing dry-run** (G3/G4, FR6–FR14), **guardrailed auto-apply + grant lifecycle + custom alerting** (FR15–FR17), **chargeback + audit export** (G5, FR18), and a final gated **live-tenant enablement** phase (FR19, PRD §2/§4.5). Phase numbering continues from `PLAN.md` (which ended at Phase 3), so this plan starts at **Phase 4**.

Mapping to the canonical build orders:

| This plan | CLAUDE.md §8 | PRD §4.8 | Feature |
|---|---|---|---|
| Phase 4 | 3 | 2 | Full control administration |
| Phase 5 | 4 | 3 | Forecasting |
| Phase 6 | 5 | 4 | Auto-balancing, dry-run |
| Phase 7 | 6 | 5 | Guardrailed auto-apply + grants + alerting |
| Phase 8 | 7 | 6 | Chargeback + audit export |
| Phase 9 | — | — | Live-tenant enablement + RBAC (gated on §9 answers + PAT) |

Everything through Phase 8 is developed and verified **entirely against MSW in simulation mode** (no PAT exists). Every task carries the CLAUDE.md §6.7 verification gate: a Playwright e2e spec (headless, `_electron.launch()`, MSW-backed) **and** a Chrome MCP interactive pass driven via raw CDP against the real Electron process (per CLAUDE.md §7 — not the `mcp__chrome-devtools__*` browser-tab tools). Tasks below only restate verification specifics beyond that standing gate.

## Dependency graph

```
MVP (done): snapshots, read ApiClient, Overview/CostCenters/Users/Settings, MSW reads
    │
    ├────────────────────────────┬─────────────────────────────┐
    │                            │                             │
Phase 4: Control administration  │  Phase 5: Forecasting       │
  MSW mutations ──► write-path   │    core math ──► forecast   │
  audit log (hash-chained)       │    persistence ──► screens  │
  diff/validate/simulate-v1      │                             │
  per-control vertical slices    │   (4 and 5 are parallel     │
    │                            │    workstreams — no edge)   │
    └──────────────┬─────────────┘                             │
                   ▼                                           │
Phase 6: Auto-balance dry-run                                  │
  binding-constraint resolver · envelopes · allocators         │
  simulation · Auto-balance screen (no apply)                  │
                   │                                           │
                   ▼                                           │
Phase 7: Auto-apply + grant lifecycle + alerting               │
  guardrails · grants · rollover · thresholds/anomalies/routing│
                   │                                           │
                   ▼                                           ▼
Phase 8: Chargeback + audit export (needs audit events from 4/7,
         usage facts from MVP, Actions-minutes ingestion — new)
                   │
                   ▼
Phase 9: Live-tenant enablement (gated: §9 answers + classic PAT)
```

Key edges: the **audit log** is built at the *start* of Phase 4, not in Phase 8 — CLAUDE.md §6.5 applies from the very first write; Phase 8 only adds the Audit *screen* and export. The **write-path engine** (re-read → diff → validate → simulate → apply → audit) is built once in Phase 4 and reused verbatim by the rebalancers in Phase 7. **Forecasting precedes auto-balancing** because both funding envelopes subtract *projected* consumption of non-at-risk entities (FR7/FR12).

## Architecture decisions

- **Audit log first.** `audit_event` (append-only, hash-chained) lands in Phase 4 before any apply path exists, so invariant §6.5 is never retro-fitted. Hash chain: each row stores `prev_hash` + `hash = H(prev_hash ‖ canonical_payload)`; verification is a pure `packages/core` function.
- **One write-path engine, two callers.** Manual Controls writes (Phase 4) and rebalancer applies (Phase 7) share the same pipeline: *re-read live state (§6.2) → diff desired vs live (Terraform-style) → validate (FR4) → simulate (§6.1) → confirm/approve → apply idempotent POST/PATCH/DELETE → audit event*. The diff/validate/simulate stages are pure functions in `packages/core`; only re-read/apply/audit-write live in `packages/data`.
- **GitHub billing/budget endpoints are hand-wrapped ⇒ §6.9 applies.** The 2026 budget/cost-center/usage endpoints (API version `2026-03-10`) are not in Octokit's typed surface, so all calls go through `octokit.request()` with our own types. Every new endpoint (and its MSW twin) gets an explicit §6.9 validation task against `github/rest-api-description` / official docs before it counts as verified.
- **MSW stays stateless & deterministic even with mutations.** Mutation handlers validate the payload and return the correct immediate response (matching GitHub's documented shapes); canonical fixture state still resets every run. In-session apply→result continuity uses the UI's optimistic/staged state, per PRD §4.7 — e2e asserts on *request issued + immediate response*, never cross-request persistence.
- **The included-usage cap is never modeled as an amount.** Everywhere (schema, core types, UI, MSW): `enabled: bool` + `overflow: 'block' | 'metered'` + a read-only `computed_limit` the mock derives from attributed licenses. The rebalancer's binding-constraint resolver branches **ULB-bound (grantable) vs cap-bound (relax-only)** as a type-level distinction, per CLAUDE.md §5 / FR8–FR9.
- **All money-affecting math is pure `packages/core`, unit-tested before I/O wiring** (CLAUDE.md §10): diffing, validation, simulation, forecasting, envelopes, allocators, guardrails, hash-chain verification, chargeback pivots. Any "now" is an explicit `asOfDate` parameter (established MVP convention).
- **Schema and preload-bridge changes are batched per phase and are ask-first decision points** (SPEC.md Boundaries). Each phase that needs them has exactly one migration task and one ApiClient/bridge-extension task, so the "permanent seam" is reviewed a handful of times, not per-widget.
- **The design handoff's demo-scenario switch (Healthy / At risk / Surplus) becomes a sim-mode-only fixture selector.** The rebalancers are untestable without trigger-satisfying data; the design brief itself says to keep the three states as a QA fixture set. It renders only in simulation mode and re-seeds MSW.
- **Settings' "AI credit paid usage" card is read-only ingested state until Phase 9.** It changes exhaustion semantics (block vs meter) so forecasting/rebalancing must *ingest* it (PRD §4.6); whether a write endpoint for the policy exists is an open question — do not build a write affordance on a guessed path (§6.9).

---

## Phase 4 — Full control administration (G1; FR1–FR4; invariants §6.1–§6.5, §6.9)

The write surface: API-first CRUD of every control — universal/individual ULBs, the API-only CCULB, enterprise/org/cost-center spending limits, included-usage caps, hard-stop flags, cost-center lifecycle/membership — plus ULB-display-bug repair. Foundation tasks 4.1–4.8 establish the shared write path; tasks 4.9–4.15 are vertical slices, one control family at a time, each shippable and e2e-verified on its own.

### Task 4.1: MSW mutation handlers — budgets (all scopes)

**Description:** Add `POST /enterprises/:enterprise/settings/billing/budgets`, `GET/PATCH/DELETE …/budgets/:budgetId` to `handlers.ts`, covering every `budget_scope` this tool writes: `enterprise`, `organization`, `cost_center`, user-level (universal/individual), and `multi_user_cost_center` (CCULB). Handlers validate payload shape (budget_type/sku/scope/amount/prevent_further_usage/alerting), return GitHub-shaped success/error responses, accept `$0` amounts (the real API does — that's the trap), and keep the display-bug fixture budget mutable via API (it's "hidden in UI", not absent).

**Acceptance criteria:**
- [ ] All five scopes create/update/delete through the handlers with correct status codes and response bodies; malformed payloads get GitHub-shaped 4xx errors.
- [ ] Canonical fixture state is untouched across runs (stateless invariant); the display-bug budget and `$0`-ULB edge fixtures respond to PATCH/DELETE.

**Verification:** `pnpm --filter data test` — new contract tests per method × scope, asserting shape + status; existing read-handler tests stay green.
**Dependencies:** None (MVP complete).
**Files:** `packages/data/src/msw/handlers.ts`, `packages/data/src/msw/fixtures/budgets.ts`, `packages/data/src/msw/handlers.test.ts`.
**Size:** M

### Task 4.2: MSW mutation handlers — cost centers + included-usage cap

**Description:** Add `POST /…/cost-centers`, `DELETE /…/cost-centers/:id`, `POST/DELETE /…/cost-centers/:id/resource` (users, orgs, repos, enterprise teams), and the included-usage-cap toggle on cost-center create/edit (`enabled` + `overflow`, per PRD §2.2). The handler **re-derives `computed_limit` from the licenses attributed to the cost center** on every membership mutation — the cap is never accepted as an input amount.

**Acceptance criteria:**
- [ ] Create/delete/membership mutations round-trip with GitHub-shaped responses; enterprise-team resources supported.
- [ ] Cap toggle accepts only `enabled`/`overflow`; any attempt to POST an amount is rejected; `computed_limit` visibly changes when members are added/removed in the same session's responses.

**Verification:** `pnpm --filter data test` contract tests including a membership-change → recomputed-limit assertion.
**Dependencies:** None.
**Files:** `packages/data/src/msw/handlers.ts`, `packages/data/src/msw/fixtures/costCenters.ts`, `packages/data/src/msw/handlers.test.ts`.
**Size:** M

### Task 4.3: §6.9 API-surface validation of all mutation shapes

**Description:** Validate every request/response shape from 4.1–4.2 (and the client types that will consume them) against `github/rest-api-description` (OpenAPI) and/or the official REST docs for API version `2026-03-10`. Record the result per endpoint in a checked-in validation note (`docs/api-surface-validation.md`): path, method, doc source, date checked, deviations. This is the standing gate for every hand-wrapped endpoint added later — Phases 5–9 reference this file.

**Acceptance criteria:**
- [ ] Every mutation endpoint in MSW has a row in the validation note with a doc citation; any mismatch found is fixed in handlers/fixtures/types in this task.

**Verification:** The note itself + corrected contract tests green. (No UI surface — Playwright/Chrome-MCP gate N/A for this task; §6.9 *is* the gate here.)
**Dependencies:** 4.1, 4.2.
**Files:** `docs/api-surface-validation.md`, possible corrections in `packages/data/src/msw/*`.
**Size:** S

### Task 4.4: `core` — control domain model + desired-vs-live diff

**Description:** Pure staged-change model: a `ControlState` union covering budgets (all scopes) and included-usage caps; `diffControls(live, desired)` producing a Terraform-style plan (`add` / `change {field, old, new}` / `delete`) that the Controls right rail renders and the write engine executes. Includes stable ordering and a no-op detector (empty plan ⇒ apply disabled).

**Acceptance criteria:**
- [ ] Diff covers create/update/delete for every control kind, including `included_cap["X"].enabled: false → true` and `overflow` changes; field-level old→new is exact.
- [ ] Zero I/O imports; every function deterministic.

**Verification:** `pnpm --filter core test` — table-driven diff cases incl. mixed multi-control plans.
**Dependencies:** None.
**Files:** `packages/core/src/controls.ts`, `packages/core/src/controls.test.ts`, `packages/core/src/index.ts`.
**Size:** M

### Task 4.5: `core` — write validation rules (FR4, §6.3, §6.4)

**Description:** `validatePlan(plan, context)` returning typed blockers/warnings: **blocker** — enterprise cap below the sum of cost-center budgets; **warnings** — `$0`/near-zero ULB, multi-org-licensed user (random-org billing), intended-hard-cap without `prevent_further_usage: true` (making a limit alert-only requires the explicit logged override flag per §6.3, which the validator marks for the audit event).

**Acceptance criteria:**
- [ ] Each rule has positive + negative cases; blockers vs warnings are distinct types; the alert-only override is representable and carries a justification requirement.

**Verification:** `pnpm --filter core test`.
**Dependencies:** 4.4.
**Files:** `packages/core/src/validation.ts` + test.
**Size:** S/M

### Task 4.6: `core` — simulate-before-apply v1 (deterministic)

**Description:** `simulatePlan(plan, usageState, controlsState, asOfDate)` — invariant §6.1's engine, v1 without forecasts: given current per-user/per-CC cycle-to-date burn and the proposed control state, compute **who newly blocks / newly unblocks** (ULB precedence: individual > CCULB > universal; lowest-remaining-headroom-wins across ULB/cap/spending-limit), plus pool-draw and metered-spend deltas at current consumption. Phase 6 upgrades this with forecasted end-of-cycle projections; the interface takes an optional forecast input from day one so the upgrade is additive.

**Acceptance criteria:**
- [ ] Precedence and lowest-headroom-wins verified against hand-computed scenarios, including a user bound by a cap (not their ULB) and a `$0` universal ULB blocking everyone without an individual override.
- [ ] Output includes blocked/unblocked user lists and per-scope $/credit deltas.

**Verification:** `pnpm --filter core test` — this is money-affecting math; exhaustive table-driven cases before any I/O wiring (CLAUDE.md §10).
**Dependencies:** 4.4.
**Files:** `packages/core/src/simulate.ts` + test.
**Size:** M

### Task 4.7: `data` — append-only hash-chained audit log

**Description:** Migration adding `audit_event` (id, ts, actor, action, entity_ref, trigger, envelope_snapshot JSON, before JSON, after JSON, justification, data_snapshot_id, prev_hash, hash). Writer appends only; no update/delete paths exist in code. `packages/core` gets `computeEventHash` + `verifyAuditChain(events)` (pure). Every apply in later tasks writes through this.

**Acceptance criteria:**
- [ ] Chain verifies over N events; tampering any field breaks verification at the right index; writer exposes no mutation API.
- [ ] Migration applies cleanly to an existing MVP database (additive only). *(Schema change — ask-first checkpoint before committing the migration.)*

**Verification:** `pnpm --filter core test` (hash math) + `pnpm --filter data test` (writer + migration smoke).
**Dependencies:** None.
**Files:** `packages/data/src/db/schema.ts`, `packages/data/migrations/0001_audit.sql`, `packages/data/src/audit/writer.ts` + tests, `packages/core/src/auditChain.ts` + test.
**Size:** M

### Task 4.8: `data` — write engine + ApiClient write surface + preload bridge extension

**Description:** The shared apply pipeline: `applyPlan(plan)` re-reads live state (`GET /budgets`, cost-center state — invariant §6.2), re-diffs (drift ⇒ surface "⤺ drift — reconcile", abort apply), executes idempotent `octokit.request()` mutations, writes one audit event per applied change. Extend `ApiClient` with the Phase-4 write surface (`getControls()`, `stagePlan`/`simulatePlan`/`applyPlan`-shaped methods — final naming at review) and mirror through preload/IPC. *(Bridge extension — ask-first checkpoint; propose the full Phase 4–7 write-method set in one review so the seam is designed once.)*

**Acceptance criteria:**
- [ ] Apply with no drift: mutations issued with correct paths/payloads/API-version header, audit events chained.
- [ ] Injected drift between stage and apply: apply aborts, drift reported, nothing mutated, nothing audited as applied.
- [ ] PAT never crosses the bridge; renderer still has zero Electron/Node imports.

**Verification:** `pnpm --filter data test` integration (MSW) + a Playwright spec proving a renderer-initiated apply round-trips and the request payload was correct.
**Dependencies:** 4.1–4.7.
**Files:** `packages/data/src/write/engine.ts` + test, `packages/data/src/api-client/types.ts`, `packages/data/src/api-client/github-impl.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/preload/index.ts`, `packages/ui/src/lib/window-api.ts`.
**Size:** M/L

### Checkpoint 4a — write foundation
- [ ] `pnpm test` green across core/data; audit chain verifies; drift-abort proven.
- [ ] §6.9 validation note exists and covers all mutation endpoints.
- [ ] Human review of: migration, ApiClient write-surface naming, bridge shape (the two ask-first items).

### Task 4.9: Slice — Controls screen shell + Spending-limits family end-to-end

**Description:** Per `design/README.md` §3: Controls screen with family tabs + explainer; the **Spending limits** table (enterprise/org/cost-center rows: control · phase badge `metered only` · cap · enforcement toggle green/amber with the loud "⚠ Alert-only" pill · utilization meter + alert-threshold field); staged edits; and the **right rail v1** — plan diff (from 4.4), "Run dry-run simulation" (4.6), validation warnings (4.5), justification textarea, Apply (via 4.8) → audit + success toast. This slice carries the rail that all later slices reuse.

**Acceptance criteria:**
- [ ] Editing a cap/toggle stages (nothing writes); rail shows exact old→new diff; simulate shows blocked/unblocked + Δ metered; apply issues correct PATCH payloads and writes audit events; enforcement semantics match §6.3 (disabling hard-stop demands the explicit override + justification).
- [ ] Enterprise-cap-below-sum blocker actually prevents apply.

**Verification:** Playwright: stage → simulate → apply flow asserting the issued request payloads; Chrome MCP: visual fidelity of badges/pills/meters against design tokens.
**Dependencies:** 4.8.
**Files:** `packages/ui/src/screens/Controls/Controls.tsx`, `ControlsTable.tsx`, `PlanRail.tsx`, `packages/ui/src/App.tsx` (unstub route).
**Size:** L *(the rail is the bulk; subsequent slices are S/M because they reuse it)*

### Task 4.10: Slice — User-level budgets family (universal + individual + CCULB)

**Description:** ULB family tab: universal/individual/CCULB rows with `both phases` badge, locked "Hard stop · always" pill, **API-ONLY violet badge on CCULB rows**, `$0` warning styling, staged edits through the same rail. CCULB create targets `budget_scope: "multi_user_cost_center"` with the exact PRD §2.1 payload.

**Acceptance criteria:**
- [ ] All three scopes CRUD end-to-end; CCULB request payload matches the PRD example shape; `$0`-ULB warning surfaces in validation; precedence explainer text present.

**Verification:** Playwright asserts CCULB POST payload verbatim; Chrome MCP confirms API-only badge treatment.
**Dependencies:** 4.9.
**Files:** `packages/ui/src/screens/Controls/` (family content), fixture touch-ups.
**Size:** M

### Task 4.11: Slice — Users screen write affordances (Set ULB + bulk)

**Description:** Per design §6: row "Set ULB" → individual-ULB modal (value, dry-run text from 4.6, justification); multi-select → bulk-ULB modal. Same staged→simulate→apply path — a modal is just a scoped plan.

**Acceptance criteria:**
- [ ] Individual and bulk modals produce correct plans; dry-run text reflects real simulation output; apply audits per user; MVP's read-only tables gain no other write affordances.

**Verification:** Playwright drives both modals; asserts N budget mutations for an N-user bulk apply.
**Dependencies:** 4.9 (rail), 4.10.
**Files:** `packages/ui/src/screens/Users/SetUlbModal.tsx`, `BulkUlbModal.tsx`, `UsersTable.tsx`.
**Size:** M

### Task 4.12: Slice — Included-usage caps family (per-CC cards)

**Description:** Per design §3: responsive grid of per-cost-center cards — name + API-ONLY badge, enable toggle, auto-computed limit line ("≈79,800 funded by 42 licenses", read-only), drawn progress bar, Block / Overflow→metered segmented choice. Staged like the table; **no amount input exists anywhere**.

**Acceptance criteria:**
- [ ] Toggle + overflow changes stage/diff/apply correctly (`included_cap["…"].enabled: false → true` in the plan rail); computed limit rendered read-only from API data; cap-bound edge fixture displays correctly.

**Verification:** Playwright asserts the cap-edit request carries only `enabled`/`overflow`; Chrome MCP confirms no dial-able number is presented.
**Dependencies:** 4.9.
**Files:** `packages/ui/src/screens/Controls/IncludedCapsGrid.tsx`.
**Size:** M

### Task 4.13: Slice — Cost-center lifecycle writes

**Description:** Per design §5: "+ New cost center" modal (name, DEWR division/branch/project, exclude-from-enterprise-budget toggle), membership add/remove incl. enterprise-team resources, archive/delete. Cost-center reassignment `<select>` on Users rows (1:1 move = remove+add resource).

**Acceptance criteria:**
- [ ] Create/membership/exclude flows issue correct cost-center API mutations and audit; DEWR fields persist to the existing columns; Users-row reassignment round-trips.

**Verification:** Playwright covers create + member add/remove + reassign; asserts request sequence.
**Dependencies:** 4.9, 4.2.
**Files:** `packages/ui/src/screens/CostCenters/NewCostCenterModal.tsx`, `DrillModal.tsx` (membership edit), `packages/ui/src/screens/Users/UsersTable.tsx`.
**Size:** M

### Task 4.14: Slice — ULB display-bug detection + repair (FR3)

**Description:** Detection in `core`: budgets present in the API list but flagged UI-hidden (fixture models this), or orphaned (`$0` universal ULB with no owner intent). Violet repair banner on the ULB family tab: "N orphaned user-level budgets detected — in the API, invisible in GitHub's UI" with **View & edit via API** / **Delete the $0 ULB** / dismiss — actions run through the standard rail.

**Acceptance criteria:**
- [ ] Display-bug fixture triggers the banner; repair-delete issues `DELETE /budgets/{id}` and audits; dismissal persists for the session; healthy fixtures show no banner.

**Verification:** Playwright on both fixture states; Chrome MCP confirms the banner reads as a repair affordance, not an error.
**Dependencies:** 4.10.
**Files:** `packages/core/src/ulbRepair.ts` + test, `packages/ui/src/screens/Controls/UlbRepairBanner.tsx`.
**Size:** S/M

### Task 4.15: Controls read-model sync + drift markers

**Description:** Ingest budgets + cap state into snapshots on `syncNow` (extending MVP ingestion), and render "● staged change" / "⤺ drift — reconcile" markers in the tables by comparing staged vs last-synced vs live-at-apply states.

**Acceptance criteria:**
- [ ] Post-sync tables reflect fixture control state; a staged row is marked; an out-of-band change (fixture variant) yields the drift marker and reconcile path.

**Verification:** Playwright drift scenario; `pnpm --filter data test` for ingestion.
**Dependencies:** 4.8, 4.9.
**Files:** `packages/data/src/sync/sync-now.ts`, `packages/ui/src/screens/Controls/*`.
**Size:** S/M

### Checkpoint 4 — control administration complete
- [ ] Every control in PRD §1.3/§1.4 is CRUD-able from the Controls/Users/Cost-centers screens, API-first, with staged→simulate→apply enforced (no write bypasses the rail).
- [ ] Invariants §6.1–§6.5 demonstrably hold (drift-abort test, hash-chain verify, hard-stop override logging).
- [ ] `pnpm test` + `pnpm e2e` green; Chrome MCP pass on all four slices; §6.9 note current.
- [ ] Human review before Phase 6 consumes the write path.

---

## Phase 5 — Forecasting (G2; FR5)

Pure math first, persistence second, screens last. **This phase has no dependency on Phase 4 and can run as a parallel workstream** (both build on the MVP only); Phase 6 needs both.

### Task 5.1: Multi-cycle historical fixtures with seasonality

**Description:** Extend MSW usage fixtures with ≥3 full historical cycles (the usage endpoint supports 24-month history) exhibiting weekday seasonality, a promo→standard boundary crossing 1 Sep 2026, and a provisional latest day — the fuel for run-rate, backtest, and cliff rendering. Anchored to `SIM_CURRENT_DATE`, deterministic (no wall-clock).

**Acceptance criteria:**
- [ ] Fixtures include ≥3 closed cycles + the open one; weekday effect is statistically visible; date-filtered queries return correct slices; existing MVP e2e assertions still pass (additive only).

**Verification:** `pnpm --filter data test` fixture-shape tests + full existing suite green.
**Dependencies:** None.
**Files:** `packages/data/src/msw/fixtures/usage.ts`, `constants.ts`.
**Size:** M

### Task 5.2: `core` — run-rate, seasonality, P50/P90, exhaustion date, the cliff

**Description:** Per PRD §4.3: blended trailing burn (trailing-7 weighted + cycle-to-date) with weekday seasonality → daily projection; pool-exhaustion date + projected metered $; P50/P90 from daily-burn variance; runway-days; any projection crossing 1 Sep 2026 switches to standard allowance mid-horizon (a step-change, reusing `poolAllowanceCredits`); latest day flagged provisional (settling window). All functions take `asOfDate` + inputs explicitly.

**Acceptance criteria:**
- [ ] Hand-computed scenario tests: flat burn, strongly weekday-seasonal burn, cliff-crossing horizon (projection visibly steps), zero-usage entity (no exhaustion), already-exhausted entity.
- [ ] P50 ≤ P90 always; outputs are per-scope generic (enterprise / cost-center-vs-cap / user-vs-ULB take the same shape).

**Verification:** `pnpm --filter core test` — near-100% coverage; this is the math the envelopes trust.
**Dependencies:** None.
**Files:** `packages/core/src/forecast.ts` + test.
**Size:** L → split at review if it exceeds one session: (a) run-rate+seasonality, (b) percentiles+cliff+runway.

### Task 5.3: `core` — backtest (MAPE)

**Description:** Replay: forecast each historical day from only-prior data, compare to actuals, compute MAPE per scope; output the Actual-vs-Forecast series the backtest chart renders.

**Acceptance criteria:**
- [ ] Known-good synthetic series yields expected MAPE; no look-ahead leakage (asserted by construction in tests).

**Verification:** `pnpm --filter core test`.
**Dependencies:** 5.2.
**Files:** `packages/core/src/backtest.ts` + test.
**Size:** S/M

### Task 5.4: `data` — forecast persistence + ApiClient read surface

**Description:** Migration adding `forecast` (scope, entity_ref, computed_at, horizon JSON, p50/p90 series, exhaustion_date, mape, basis snapshot_id). Forecasts recomputed at the end of every `syncNow` (local-first: sync is the scheduler). `ApiClient.getForecast(scope, entityId?)` + bridge extension. *(Migration + bridge — ask-first, batched with this phase's review.)*

**Acceptance criteria:**
- [ ] Sync produces forecast rows for enterprise, every active cost center (cap-on ones against their computed cap), and heavy users; rows reference the snapshot they derive from (FR18's "forecast basis").

**Verification:** `pnpm --filter data test` integration: sync → forecast rows match `core` outputs for fixture data.
**Dependencies:** 5.1, 5.2, 5.3.
**Files:** `packages/data/src/db/schema.ts`, `migrations/0002_forecast.sql`, `packages/data/src/forecast/compute.ts`, `api-client/*`, preload/IPC files.
**Size:** M

### Task 5.5: Forecast screen — enterprise + heavy-user scopes

**Description:** Per design §2: scope tabs, entity `<select>`, allowance-basis toggle (Promo/Standard — these two scopes only), pool burn-down card (headline runway, exhaustion/block date, chart with P50 dashed + P10–P90 band + allowance line + red exhaustion marker + hatched provisional day), metered-phase spend bar (P50 fill, band, budget/hard-stop line), bottom grid: backtest chart + MAPE pill + percentile rows.

**Acceptance criteria:**
- [ ] Renders real persisted forecasts; chart values match `core` outputs for fixtures; basis toggle re-derives the allowance line; exhaustion marker lands on the computed date.

**Verification:** Playwright asserts marker date + tile values against fixture-derived expectations; Chrome MCP for chart fidelity (band, hatching, markers).
**Dependencies:** 5.4; extends MVP `BurndownChart`.
**Files:** `packages/ui/src/screens/Forecast/Forecast.tsx`, `components/BurndownChart.tsx` (forecast layers), `components/MeteredBudgetBar.tsx`, `components/BacktestChart.tsx`, `App.tsx` (unstub).
**Size:** L → the signature-chart forecast layers may split out as their own S task at review.

### Task 5.6: Forecast screen — cost-center scope (cap-on vs cap-off)

**Description:** Design §2's v2 behavior: cap-ON cost center gets its own burn-down against the computed cap, labeled "Cap block date" or "Overflow-to-metered date" per the cap's overflow choice; cap-OFF cost center gets the explainer card ("No included-usage cap on …") with "Enable included-usage cap in Controls →" CTA (cross-link; lands on the caps family — Phase 4). Both show the metered forecast below.

**Acceptance criteria:**
- [ ] Cap-bound fixture CC shows cap-scoped burn-down with correct label variant; cap-off CC shows the explainer + working CTA; metered card present in both.

**Verification:** Playwright on both CC types + CTA navigation.
**Dependencies:** 5.5; CTA target needs 4.12 (link may point at the stub until Phase 4 lands — note in PR if so).
**Files:** `packages/ui/src/screens/Forecast/CostCenterScope.tsx`.
**Size:** M

### Task 5.7: Overview forecast overlay + cliff banner

**Description:** Wire MVP's present-but-disabled pieces: forecast-lens toggle (Pool/Metered) goes live; burn-down gains P50/P90 band + exhaustion marker; runway tiles upgrade from cycle-to-date facts to projections ("Pool runway 11 days", "Projected metered spend $…"); persistent cliff banner ("Included allowance drops on 1 Sep 2026 — pool falls ~37%") with "Visualise the cliff →" → Forecast.

**Acceptance criteria:**
- [ ] Toggle switches lenses; tiles/colors match design semantics; banner shows while the cliff is ahead of `asOfDate` and links correctly; MVP actual-only assertions updated, not broken.

**Verification:** Playwright tile/marker assertions per lens; Chrome MCP banner treatment.
**Dependencies:** 5.4, 5.5 (chart layers).
**Files:** `packages/ui/src/screens/Overview/Overview.tsx`, `components/RunwayTile.tsx`, `CliffBanner.tsx`.
**Size:** M

### Task 5.8: Users — projected block date

**Description:** Per-user forecast vs binding ULB → "✕ block ~date" sublabel on Users rows (and "no usage yet this cycle" where applicable). The developer persona's self-service headroom answer (PRD §3.3).

**Acceptance criteria:**
- [ ] Sublabels match per-user forecast outputs; users without a projected block show none.

**Verification:** Playwright spot-checks fixture users on both sides.
**Dependencies:** 5.4.
**Files:** `packages/ui/src/screens/Users/UsersTable.tsx`.
**Size:** S

### Checkpoint 5 — forecasting complete
- [ ] Forecast screen fully functional at all four scopes; Overview overlay live; backtest MAPE rendering.
- [ ] `simulatePlan`'s optional forecast input (4.6) now receivable — spot-check the integration compiles end to end.
- [ ] Gate green (Playwright + Chrome MCP); human review. **Phases 4 and 5 must both be complete before Phase 6.**

---

## Phase 6 — Auto-balancing, dry-run (G3/G4; FR6–FR14)

The centerpiece, simulate-only. All engine math is pure `core`; the screen renders recommendations and live simulation but **cannot apply** (apply arrives with guardrails in Phase 7 — the button renders in its pre-apply "dry-run" state).

### Task 6.1: `core` — binding-constraint resolver

**Description:** For each entity (user / cost center), resolve the **binding constraint** — the applicable control with lowest remaining headroom across: most-specific ULB (individual > CCULB > universal), included-usage cap (cost centers, pool phase), cost-center/org/enterprise spending limits (metered phase) — and classify **ULB-bound (grantable)** vs **cap-bound (relax-only)** vs **budget-bound** as a discriminated union. At-risk = blocked or ≥95% of binding constraint (FR6/FR11 thresholds parameterized).

**Acceptance criteria:**
- [ ] Scenario table covers: individual-override winner, CCULB-bound member, universal-bound user, cap-bound team with pool slack (must classify relax-only, never grantable), metered-phase budget-bound CC, excluded-CC funding source.
- [ ] Resolver never emits a grantable delta for a cap (the type makes it unrepresentable).

**Verification:** `pnpm --filter core test`.
**Dependencies:** 4.4 (control model), 5.2 (headroom projections).
**Files:** `packages/core/src/bindingConstraint.ts` + test.
**Size:** M

### Task 6.2: `core` — pool-phase trigger + funding envelope

**Description:** FR6 trigger: near cycle end AND projected pool underutilisation AND ≥1 at-risk entity — emitted as the condition-chip structure the UI renders (each condition: met?, label, detail). FR7 envelope: `remaining_pool − reserve − Σ projected_consumption(non-at-risk to cycle end)`, with the envelope-bar segment breakdown (reserve / held / grants / slack) as a typed output.

**Acceptance criteria:**
- [ ] PRD §4.4.A concrete scenario reproduces: day 26/30, 68% consumed, projected 82% → ~18% forfeit, 6 blocked + 11 ≥95% ⇒ trigger fires, envelope = slack − reserve.
- [ ] Healthy fixture ⇒ trigger not fired with per-condition explanations.

**Verification:** `pnpm --filter core test` against the PRD scenario numbers.
**Dependencies:** 6.1, 5.2.
**Files:** `packages/core/src/poolRebalancer.ts` + test.
**Size:** M

### Task 6.3: `core` — pool-phase allocator (grants + relax branch)

**Description:** FR8/FR9: rank ULB-bound at-risk entities (blocked first, then proximity-to-limit / priority / demonstrated throughput); grant each the delta covering projected remaining demand via the **most-specific lever** — individual ULB override by default (precedence-winning, surgical; "converts from Universal/CCULB" metadata for the UI sub-label), CCULB only for uniform team lifts; greedy until the envelope is spent; reserve untouched. **Cap-bound entities route to the relax branch**: emit `lift-cap` (disable) / `overflow→metered` / `re-attribute licenses` options with **no delta**, plus the fixed pool contribution lifting the cap would unlock. Safety: Σ raised ceilings never exceeds remaining pool + allowed metered.

**Acceptance criteria:**
- [ ] Envelope-exhaustion ordering correct; partially-funded tail reported ("N of M funded"); cap-bound rows carry options-not-deltas; the Σ-ceilings safety property holds under a property-style test.

**Verification:** `pnpm --filter core test` incl. the PRD 17-user scenario end-to-end.
**Dependencies:** 6.2.
**Files:** `packages/core/src/poolRebalancer.ts` (allocate) + test.
**Size:** M

### Task 6.4: `core` — pool-phase simulation (FR10)

**Description:** Given a (possibly user-edited) grant set: projected end-of-cycle pool utilisation before→after, probability of tipping into metered (from P50/P90 variance), users unblocked count, and the assurance/over-allocation verdict. Upgrades 4.6's `simulatePlan` to consume forecasts — one simulation engine, both callers (manual Controls plans and rebalancer grant sets).

**Acceptance criteria:**
- [ ] PRD scenario simulates to ~96% utilisation with <3% tip risk; over-allocating past the envelope flips the verdict; editing one grant changes outputs deterministically.

**Verification:** `pnpm --filter core test`; Controls-rail simulate (4.9) re-run to confirm the upgrade is backward-compatible.
**Dependencies:** 6.3, 4.6, 5.2.
**Files:** `packages/core/src/simulate.ts`, `poolRebalancer.ts` + tests.
**Size:** M

### Task 6.5: `core` — metered-phase rebalancer (trigger, envelope, allocator)

**Description:** FR11–FR13: trigger (metered phase active AND entity ≥95% of binding metered cap AND higher-scope headroom exists); envelope `remaining_enterprise(or org)_budget − reserve − Σ projected_metered(non-at-risk)`; resolve each entity's binding budget via 6.1 and raise *that one*; excluded cost centers fund from their own cap, never the enterprise envelope; never exceed the envelope (raising the enterprise budget itself is policy+approval-only — flagged, not allocated).

**Acceptance criteria:**
- [ ] PRD §4.4.B scenario reproduces: $8,000 budget, $6,300 unused, *Platform* at 98% of $600 + 3 near-ULB users ⇒ +$250 CC-budget grant + 3 individual-ULB bumps, each on the entity's actual binding constraint.
- [ ] Excluded-CC case allocates from the right source.

**Verification:** `pnpm --filter core test` against PRD numbers.
**Dependencies:** 6.1, 5.2.
**Files:** `packages/core/src/meteredRebalancer.ts` + test.
**Size:** M

### Task 6.6: `core` — metered-phase simulation (FR14)

**Description:** Who stays unblocked, projected total metered $, remaining enterprise headroom, and the hero **bill delta**, before any apply.

**Acceptance criteria:**
- [ ] Bill delta equals Σ granted metered deltas priced at $0.01/credit under fixture consumption; headroom math consistent with the envelope.

**Verification:** `pnpm --filter core test`.
**Dependencies:** 6.5.
**Files:** `packages/core/src/meteredRebalancer.ts` + test.
**Size:** S

### Task 6.7: Scenario fixtures + sim-mode scenario selector

**Description:** Fixture seeds matching the design's three demo states — **Healthy** (no triggers), **At risk** (the PRD pool scenario + a cap-bound team), **Surplus** (drastic underconsumption; surplus banner case) — plus the metered scenario. A **simulation-mode-only** scenario selector (top-bar segmented switch per design; hidden outside sim mode) re-seeds MSW. Nav badges (at-risk counts) derive from the active scenario.

**Acceptance criteria:**
- [ ] Switching scenarios re-seeds deterministically and updates Overview banners, nav badges, and rebalancer triggers; selector absent when a PAT is configured for live mode; e2e can force a scenario per test.

**Verification:** Playwright parameterized across scenarios; Chrome MCP confirms the selector reads as a sim-mode affordance (§6.8 unmistakability).
**Dependencies:** 6.2, 6.5 (trigger semantics define the seeds).
**Files:** `packages/data/src/msw/fixtures/scenarios.ts`, `handlers.ts`, `apps/desktop/src/main/*` (scenario IPC), top-bar component.
**Size:** M

### Task 6.8: Auto-balance screen — pool mode (dry-run)

**Description:** Per design §4: mode switch defaulting to the current phase; **① trigger status** card (amber dot, trigger sentence, day X/Y, condition chips); **② funding-envelope bar** (signature component: reserve hatched / held / grants blue / slack green, brace + captions, live-resizing); **③ at-risk table** (Entity | Grant lever with converts-from sub-label and `×N` batching | % limit | remaining demand | editable proposed Δ; lift-cap rows render a **toggle**, never a number); **④ simulate rail** (pool utilisation before→after, metered-tip probability, users unblocked; assurance note flips red on over-allocation); footer "N of M funded · allocated X · unallocated Y". Edits recompute envelope + simulation live. Apply button renders in its gated pre-apply state ("dry-run only — auto-apply arrives with guardrails").

**Acceptance criteria:**
- [ ] At-risk scenario renders the full ①→④ flow from real engine outputs; editing a Δ live-updates bar + rail; over-allocation disables the (already gated) apply and shows the red warning; cap-bound row is a toggle contributing its fixed amount.

**Verification:** Playwright: scenario → assert trigger sentence, envelope numbers, row count, live-edit recomputation; Chrome MCP: envelope-bar fidelity.
**Dependencies:** 6.2–6.4, 6.7.
**Files:** `packages/ui/src/screens/AutoBalance/AutoBalance.tsx`, `TriggerCard.tsx`, `components/EnvelopeBar.tsx`, `GrantsTable.tsx`, `SimulateRail.tsx`, `App.tsx` (unstub).
**Size:** L *(the envelope bar + live recomputation is the crux; split `EnvelopeBar` into its own S task at review if needed)*

### Task 6.9: Auto-balance screen — metered mode (dry-run)

**Description:** Same skeleton, metered semantics: trigger card, $-denominated envelope, binding-budget grant rows, simulate rail with **Bill delta** hero + projected total metered + remaining headroom.

**Acceptance criteria:**
- [ ] Metered scenario renders engine outputs; mode switch preserves per-mode edited allocations (`abAlloc` keyed `mode:entityId` per design state notes).

**Verification:** Playwright metered scenario + mode-switch state retention.
**Dependencies:** 6.5, 6.6, 6.8.
**Files:** `packages/ui/src/screens/AutoBalance/*` (mode variants).
**Size:** M

### Checkpoint 6 — dry-run centerpiece complete
- [ ] Both rebalancers produce explainable recommendations on scenario fixtures; every number on screen traces to a unit-tested `core` function.
- [ ] No apply path exists yet (verified: no mutation request is issuable from this screen).
- [ ] Gate green; human review — **explicitly confirm auto-apply appetite + reserve % + rollover policy defaults (CLAUDE.md §9 Q5) before starting Phase 7.**

---

## Phase 7 — Guardrailed auto-apply + grant lifecycle + custom alerting (FR15–FR17)

### Task 7.1: `core` — guardrail policy engine (FR16)

**Description:** Pure evaluation of a grant set against policy: max grant per entity (% and absolute), floors (per cost center), mandatory reserve buffer, approval threshold (grants above it require approval), full-reversibility check (every grant records its revert target). Output: allowed / needs-approval / rejected per grant, with reasons.

**Acceptance criteria:**
- [ ] Each guardrail has boundary tests (at/below/above); combined-policy interactions covered; rejection reasons are human-readable strings the UI shows verbatim.

**Verification:** `pnpm --filter core test`.
**Dependencies:** 6.3, 6.5.
**Files:** `packages/core/src/guardrails.ts` + test.
**Size:** M

### Task 7.2: Settings — guardrails + policy persistence

**Description:** Migration for a local `policy` store (guardrail values, rollover policy, auto-balance on/off, alert routing — 7.6 consumes). Settings screen per design §9: guardrails card (on/off, four stat tiles: reserve 5% · max grant 15%/20k · floor 5,000 · approval 50,000) and the **Grant rollover policy** segmented control (Revert at reset / Re-baseline) with explanation. The "AI credit paid usage" card renders **ingested GitHub policy state read-only** (amber border when ON), per the architecture decision. *(Migration — ask-first.)*

**Acceptance criteria:**
- [ ] Edited guardrails persist and immediately drive 7.1 outcomes in Auto-balance; rollover choice persists; paid-usage card reflects fixture policy state and is not writable.

**Verification:** Playwright edits a guardrail and asserts the changed approval outcome downstream.
**Dependencies:** 7.1.
**Files:** `packages/data/src/db/schema.ts` + migration, `packages/data/src/policy/*`, `packages/ui/src/screens/Settings/GuardrailsCard.tsx`, `PolicyCard.tsx`.
**Size:** M

### Task 7.3: `data` — grant store

**Description:** Migration for `grant` per PRD §4.2: entity_ref, phase, lever ∈ {individual_ulb, cculb, cap_disable, cap_overflow, license_reattribute, cc_budget, org_budget, enterprise_budget}, delta (**null for cap-relax levers**), granted_at, expires_at/rollover_policy, trigger_id, envelope_snapshot, status (active/reverted/rebaselined/expired). Read surface for the active-grants panel. *(Migration — batch with 7.2's ask-first review.)*

**Acceptance criteria:**
- [ ] Cap-relax grants storable with null delta; status transitions constrained (no resurrect-after-revert); envelope snapshot round-trips.

**Verification:** `pnpm --filter data test`.
**Dependencies:** 6.3, 6.5.
**Files:** schema + migration, `packages/data/src/grants/store.ts` + test.
**Size:** S/M

### Task 7.4: Auto-balance apply path (⑤)

**Description:** Design §4's ⑤: justification textarea; apply button relabeling through its states ("Add justification to apply" → "Approve & apply N grants" / "Reduce grants to within envelope"); guardrail evaluation (7.1) gates the flow — above-threshold grants require the approval step; apply routes through **the Phase-4 write engine** (re-read → drift-abort → apply most-specific lever) creating grant rows (7.3) and audit events carrying **trigger + envelope + binding constraint + forecast basis + before/after** (FR18's full record). Every simulated-mode apply renders visibly simulated (§6.8).

**Acceptance criteria:**
- [ ] Apply issues the correct mutation per lever (individual-ULB POST, CCULB PATCH, cap toggle, CC-budget PATCH…); one grant row + one chained audit event per applied grant; over-threshold set demands approval; envelope-exceeding set cannot apply.
- [ ] Drift between simulate and apply aborts cleanly (reuses 4.8's behavior).

**Verification:** Playwright: full ①→⑤ on the at-risk scenario, asserting request payloads, grant rows (data-layer check), and audit content; Chrome MCP: button-state ladder + simulated-apply visibility.
**Dependencies:** 7.1, 7.2, 7.3, 4.8, 6.8, 6.9.
**Files:** `packages/ui/src/screens/AutoBalance/ApplyPanel.tsx`, `packages/data/src/write/engine.ts` (grant-aware apply), audit writer touch.
**Size:** M/L

### Task 7.5: Grant lifecycle — rollover, revert, creep guard (FR15)

**Description:** Cycle-rollover detection on sync (local-first — sync is the scheduler): grants past their cycle get their policy applied — **revert** (issue the inverse mutation through the write engine) or **re-baseline** (mark the raised value as the new baseline; audited). **Active grants panel** below both Auto-balance modes: Entity + phase pill | Lever | Δ | Granted by | Expiry | Revert button (manual revert, audited). **Grant-creep guard** badge on any grant that persisted past a reset without a lifecycle action.

**Acceptance criteria:**
- [ ] Fixture time-travel test (sync with post-rollover `asOfDate`): revert-policy grant issues the inverse mutation + audit; re-baseline-policy grant re-marks without mutation; missed grant shows the creep badge.
- [ ] Manual revert works mid-cycle and audits.

**Verification:** `pnpm --filter data test` rollover integration + Playwright on the panel.
**Dependencies:** 7.3, 7.4.
**Files:** `packages/data/src/grants/lifecycle.ts` + test, `packages/ui/src/screens/AutoBalance/ActiveGrantsPanel.tsx`.
**Size:** M

### Task 7.6: Custom alerting — thresholds + anomaly detection (FR17)

**Description:** `core`: threshold evaluation (per-entity utilization vs configurable alert levels) + anomaly detection v1 (deviation vs forecast band — a day outside P10–P90, spend spikes, forfeit-risk) — deliberately simple and explainable. `data`: alert generation on sync, replacing the MVP's pre-baked `listAlerts` fixtures with computed alerts (fixture alerts remain as seed/edge data). Overview alerts list and nav badges consume computed alerts; "View in audit →" cross-link where an alert corresponds to an audited event.

**Acceptance criteria:**
- [ ] Threshold + anomaly rules unit-tested; at-risk scenario yields the expected alert set; alerts carry the design's severity/tag/meta shape (existing `Alert` type).

**Verification:** `pnpm --filter core test` + Playwright asserting computed alerts render post-sync.
**Dependencies:** 5.4 (forecast bands), 7.2 (thresholds config).
**Files:** `packages/core/src/alerts.ts` + test, `packages/data/src/alerts/compute.ts`, `packages/ui/src/screens/Overview/AlertsList.tsx`.
**Size:** M

### Task 7.7: Alert routing per cost center (Slack/Teams/email)

**Description:** Settings routing card (per-CC channel config, persisted via 7.2's policy store); a dispatcher in the main process delivering to webhooks/SMTP. **In simulation mode no outbound network call is made** — deliveries render in a "simulated deliveries" log (§6.8 extended to egress). Live delivery activates only in Phase 9's live mode.

**Acceptance criteria:**
- [ ] Routing config persists per CC; in sim mode, a triggering alert produces a visible simulated delivery and zero real network egress (asserted); dispatcher is behind an interface so live transport is a Phase-9 drop-in.

**Verification:** Playwright + a network-egress assertion in the e2e run (no non-MSW hosts contacted).
**Dependencies:** 7.6, 7.2.
**Files:** `packages/data/src/alerts/dispatch.ts`, `packages/ui/src/screens/Settings/AlertRoutingCard.tsx`.
**Size:** M

### Checkpoint 7 — the centerpiece is live (in sim)
- [ ] End-to-end on the at-risk scenario: trigger → envelope → grants → guardrails → approval → apply → grant rows → rollover revert — all audited, all simulated-mode-safe.
- [ ] Success-metric spot-checks (PRD §3.5): grants 100% traceable to trigger + envelope + actor; no ceiling creep in the rollover test.
- [ ] Gate green; human review.

---

## Phase 8 — Chargeback + audit export (G5; FR18)

### Task 8.1: Actions-minutes second meter — fixtures + ingestion

**Description:** Copilot code review burns **Actions minutes** alongside credits (PRD §1.1/§4.6). Extend usage fixtures + sync ingestion with the Actions-minutes SKU per cost center/user, exposed for chargeback (and available to Overview later). §6.9-validate the usage-endpoint SKU shape used.

**Acceptance criteria:**
- [ ] Fixtures carry Actions-minutes rows attributable to cost centers; sync ingests them into `usage_fact` (distinct SKU); §6.9 note updated.

**Verification:** `pnpm --filter data test`.
**Dependencies:** None (MVP ingestion).
**Files:** `packages/data/src/msw/fixtures/usage.ts`, `sync/sync-now.ts`, `docs/api-surface-validation.md`.
**Size:** S/M

### Task 8.2: `core` — chargeback pivot

**Description:** Pure aggregation: Division → Branch → Project (from cost-center DEWR columns) × {credits, metered $, Actions minutes}, with subtotals per level and an unattributed bucket for usage without a cost center.

**Acceptance criteria:**
- [ ] Pivot totals reconcile exactly with flat usage sums; unattributed usage surfaces rather than disappearing; empty divisions handled.

**Verification:** `pnpm --filter core test`.
**Dependencies:** 8.1.
**Files:** `packages/core/src/chargeback.ts` + test.
**Size:** S/M

### Task 8.3: Chargeback screen + CSV export

**Description:** Per design §7: indented pivot table, snapshot-timestamp header, **Export CSV**. (PDF export = new dependency ⇒ ask-first; ship CSV, park PDF as a listed open question.)

**Acceptance criteria:**
- [ ] Table matches 8.2 outputs; CSV round-trips the pivot faithfully; timestamp = the rendered snapshot's capture time.

**Verification:** Playwright downloads + parses the CSV and diffs against expected pivot.
**Dependencies:** 8.2.
**Files:** `packages/ui/src/screens/Chargeback/Chargeback.tsx`, `App.tsx` (unstub).
**Size:** M

### Task 8.4: Audit screen

**Description:** Per design §8: immutable, filterable stream (All / Budget / ULB / Auto-balance); each event expandable to Before → After (red→green mono); auto-balance grants additionally show Trigger & binding constraint + Funding envelope blocks, justification, and a link to the forecast/data snapshot. Read-only. Alert and Controls "View in audit →" cross-links resolve here.

**Acceptance criteria:**
- [ ] Every event class written since Phase 4 renders with the right expansion blocks; filters work; nothing on this screen can mutate anything.

**Verification:** Playwright: seed applies via earlier flows, then filter/expand/assert.
**Dependencies:** 4.7, 7.4 (event richness).
**Files:** `packages/ui/src/screens/Audit/Audit.tsx`, `AuditEvent.tsx`, `App.tsx` (unstub).
**Size:** M

### Task 8.5: Audit export + chain verification surface

**Description:** Export the audit log (JSON/CSV) including hash-chain fields, and a "Verify chain" action running `verifyAuditChain` with a pass/fail-at-index result — the government/compliance deliverable (§6.5).

**Acceptance criteria:**
- [ ] Export is complete + re-verifiable offline; UI verification passes on real data and pinpoints a (test-injected) tampered row.

**Verification:** Playwright export + `pnpm --filter data test` tamper case.
**Dependencies:** 8.4.
**Files:** `packages/data/src/audit/export.ts`, Audit screen action.
**Size:** S

### Task 8.6: Help screen

**Description:** Per design "Help (reference screen)": how one request is evaluated (ULB → routing → spending caps), the precedence ladder, the two phases, "rules that surprise people". Static content, design tokens. The last stub falls.

**Acceptance criteria:**
- [ ] Content matches the design's reference material; **zero `_stubs` routes remain in `App.tsx`**.

**Verification:** Playwright nav sweep: all 10 nav items land on functional screens.
**Dependencies:** None.
**Files:** `packages/ui/src/screens/Help/Help.tsx`, `App.tsx`.
**Size:** S

### Checkpoint 8 — feature-complete in simulation mode
- [ ] All 9 IA screens + Help fully functional; no stubs.
- [ ] Full-suite `pnpm test` + `pnpm e2e` green; full Chrome MCP sweep (3.2-style) re-run across all screens.
- [ ] PRD §3.5 success metrics demonstrable on scenario fixtures. Human review.

---

## Phase 9 — Live-tenant enablement + RBAC hardening (FR19; PRD §2, §4.5) — **GATED**

**Entry gate (hard):** CLAUDE.md §9's five questions answered and recorded at the top of `README`; a classic PAT with `manage_billing:enterprise` available; explicit maintainer go-ahead. Until then this phase does not start — everything above ships and demos without it.

### Task 9.1: Tenant config + host + PAT scope validation

**Description:** Tenant settings (enterprise slug; github.com vs `api.SUBDOMAIN.ghe.com`); the `X-GitHub-Api-Version: 2026-03-10` header asserted on every request path; token-health card goes real: validate classic-PAT type + `manage_billing:enterprise` scope, surface "read+write · valid · last sync" per design.

**Acceptance criteria:**
- [ ] Wrong-token-type/scope produces actionable errors before any billing call; GHE host swap covered by unit tests; header present on all requests (asserted in MSW).

**Verification:** MSW-simulated auth failures + live read against the real tenant.
**Dependencies:** Entry gate.
**Files:** `packages/data/src/api-client/github-impl.ts`, `packages/ui/src/screens/Settings/TokenHealth.tsx`.
**Size:** M

### Task 9.2: Live read-path smoke + shape reconciliation

**Description:** First real sync: run read-only ingestion against the live tenant; reconcile any response-shape/pagination drift between MSW and reality (fix fixtures/types, update `docs/api-surface-validation.md` with observed-live confirmation per endpoint). Lazy universal-ULB records reconciled against full licensing (PRD §4.6).

**Acceptance criteria:**
- [ ] Live sync completes; dashboards render real data; every read endpoint's §6.9 row upgraded to "confirmed against live"; discrepancies fixed in MSW so sim mode stays truthful.

**Verification:** Live run + full regression of the MSW-backed suite after fixture corrections.
**Dependencies:** 9.1.
**Files:** as discovered; `docs/api-surface-validation.md`.
**Size:** M

### Task 9.3: Read/write token separation + live-write arming (FR19, §4.5)

**Description:** Two PAT slots (read / write) in `safeStorage`; the write token reachable **only** by the write engine's code path; live-write mode requires explicit arming (settings toggle + typed confirmation), defaulting off. RBAC-lite: per-admin role (viewer / operator / approver) gating apply/approve affordances locally.

**Acceptance criteria:**
- [ ] With only a read token, every write affordance is inert with a clear reason; arming flow is deliberate (two steps); roles gate approve vs apply; no token in logs/renderer (re-verified).

**Verification:** Playwright role/arming matrix vs MSW; Chrome MCP confirms armed-state visibility.
**Dependencies:** 9.1.
**Files:** `packages/data/src/pat/storage.ts`, `mode.ts`, `apps/desktop/src/main/*`, Settings screens.
**Size:** M

### Task 9.4: First guarded live write + drift reconcile in production

**Description:** Lowest-stakes control first (e.g. an alert-recipient edit or a deliberately-created test budget): stage → simulate → apply against the real tenant; verify §6.2 drift-handling against a concurrent out-of-band UI edit; confirm the applied object round-trips on re-read; delete the test budget (also a live write). Document the runbook.

**Acceptance criteria:**
- [ ] One full live write-and-revert cycle audited end-to-end; drift scenario handled live; no unintended mutations (verified by before/after live listing).

**Verification:** The live run itself + audit-log review with the maintainer.
**Dependencies:** 9.2, 9.3.
**Files:** `docs/live-write-runbook.md`.
**Size:** S/M

### Task 9.5: Tenant-shape feature gating

**Description:** Per §9 answers: on Business-without-enterprise, cost centers/CCULBs/included-caps **don't exist** — gate those surfaces with explanatory empty-states rather than errors; paid-usage-policy state drives metered-rebalancer availability (disabled with explanation when exhaustion blocks); default `prevent_further_usage` per the pool-posture answer.

**Acceptance criteria:**
- [ ] Each tenant-shape permutation renders a coherent app (fixture-driven matrix in sim mode); no dead-end or crashing surface on the reduced shapes.

**Verification:** Playwright matrix across tenant-shape fixtures.
**Dependencies:** 9.2 (real answers), but implementable against fixtures earlier if answers arrive late.
**Files:** feature-gate module + touched screens.
**Size:** M

### Checkpoint 9 — done
- [ ] Live mode operational under separation-of-duties; sim mode still first-class (§6.8 banner semantics correct in both).
- [ ] All §6 invariants re-verified against the live path; final maintainer sign-off.

---

## Parallelization

- **Phases 4 and 5 are independent workstreams** (both depend only on the MVP) — the natural two-agent split. Phase 6 is the join point.
- Within Phase 4: after 4.8, slices 4.10–4.14 are parallelizable (they share only the rail from 4.9).
- Within Phase 5: 5.5/5.6/5.7/5.8 parallelize after 5.4.
- 8.1/8.2 and 8.6 can start any time after Phase 4; the Audit screen (8.4) benefits from Phase 7's event richness but renders Phase-4 events fine.
- **Sequential, never parallel:** Drizzle migrations (4.7 → 5.4 → 7.2/7.3 — linear migration chain), preload-bridge extensions (batched per phase), anything touching `simulate.ts` (4.6 → 6.4).

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Guessed shapes for 2026 billing endpoints diverge from GitHub's real surface | High | §6.9 discipline: validation note per endpoint (4.3), re-validated against live in 9.2; MSW corrected whenever reality disagrees so sim never drifts |
| Simulation math trusted for money decisions is subtly wrong | High | All of it is pure `core` with PRD's concrete scenarios as fixtures (6.2–6.6 reproduce the spec's own numbers); backtest (5.3) keeps forecasts honest |
| Grant creep / irreversible applies | High | Grants + rollover built in the same phase as apply (7.3–7.5, never apply without lifecycle); revert = first-class inverse mutation through the same audited engine |
| Preload bridge / ApiClient churn across four phases | Med | One batched ask-first extension per phase; Phase-4 review proposes the whole write-surface shape up front |
| Migration chain breaks existing user DBs | Med | Additive-only migrations, each with an apply-to-MVP-database smoke test; ask-first per schema change |
| Stateless MSW can't express multi-step flows (apply → re-read shows change) | Med | Per PRD §4.7: optimistic/staged UI carries in-session continuity; e2e asserts issued requests + immediate responses; scenario selector (6.7) covers state *variants* without persistence |
| Envelope/live-recompute UI (6.8) becomes a perf/complexity sink | Med | All recomputation is pure-function calls (no async); memoized selectors; split EnvelopeBar if the task overruns |
| Alert egress leaks in sim mode | Med | Dispatcher behind an interface; sim transport is a no-op logger; e2e asserts zero non-MSW hosts (7.7, extends SPEC.md SC#9) |
| Phase 9 blocked indefinitely on PAT/§9 answers | Low | Everything through Phase 8 is demoable and shippable in sim mode by design; 9.5's gating matrix is fixture-implementable early |

## Open questions (carry-forward + new)

1. **CLAUDE.md §9's five gating questions** — still unanswered; Phase 9's hard entry gate, and Q2 (paid usage) + Q4 (pool posture) shape Phase 6/7 defaults. Assumed superset (Enterprise, GHE.com concepts, paid usage ON) until answered.
2. **Q5 specifically** (auto-apply appetite, reserve %, rollover default) — must be answered at **Checkpoint 6**, before Phase 7 builds apply.
3. **Approval semantics** — design shows a single approval threshold; is a second approver (four-eyes) required for the government posture, or is justification + threshold enough for 2–3 admins?
4. **Anomaly-detection depth** (7.6) — v1 is deviation-vs-forecast-band; is that sufficient, or is something richer expected under FR17?
5. **PDF export** (8.3) — needs a new dependency (ask-first); CSV ships regardless.
6. **"AI credit paid usage" write path** — does a documented API exist to toggle it? Read-only until §6.9-validated.
7. **License re-attribution lever** (FR9's third cap-bound move) — surfaced as a recommendation only, or wired to the cost-center resource API as an executable move in Phase 7?
8. **Scenario selector in production builds** — sim-mode-only per this plan; confirm it should ship (as part of the offline/demo mode) rather than be dev-only.
