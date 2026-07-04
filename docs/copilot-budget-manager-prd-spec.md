# Copilot Budget Manager — Research, PRD & Technical Spec

**Status:** Draft v0.2
**Owner:** Justin (Lead AI Engineer)
**Context:** GitHub Copilot moved to usage-based (token) billing on 1 June 2026. Native budget/licensing controls are coarse, split awkwardly across UI and API, and two of the most useful levers are API-only. This document captures the research on the billing model and the full control surface, then specifies a custom management layer whose centrepiece is **two-phase auto-balancing** — redistributing access to the shared pool during the pool phase, and redistributing metered spending headroom during the metered phase.

> **Citation note:** GitHub behaviour is drawn from GitHub Docs and changelogs current as of 4 Jul 2026. Endpoints use API version `2026-03-10`. Figures change frequently — treat the plans page and changelog as source of truth at build time.

---

## Part 1 — How GitHub Copilot billing actually works now

### 1.1 The unit: AI Credits

- Usage is metered in **GitHub AI Credits**; **1 credit = $0.01 USD**.
- A credit is consumed from **tokens** (input + output + cached) at each model's published rate. Cost = f(model, tokens).
- **Code completions and Next Edit Suggestions are free** (no credits).
- **Copilot code review** also consumes **GitHub Actions minutes** — a second meter.
- **No lower-cost fallback.** When credits/budget are exhausted, credit-consuming features are **blocked**, not downgraded.

### 1.2 The two phases and the pools

Every billing cycle runs in two phases:

- **Pool phase** — consumption draws from a **shared pool of included AI credits**, pooled at the billing-entity level (100 Business seats = one pool of ~190,000 credits, not 100 buckets). Standard allowances ≈ 1,900 (Business) / 3,900 (Enterprise) per seat; **promo** ≈ 3,000 / 7,000 for existing customers 1 Jun–1 Sep 2026. **The pool shrinks ~37% on 1 Sep 2026.** Resets monthly at `00:00:00 UTC`, no carryover. Adding seats grows the pool immediately; removing seats doesn't shrink it until next cycle.
- **Metered phase** — after the pool is exhausted, further usage bills at **$0.01/credit**, but only if the **"AI credit paid usage" policy is enabled**. If disabled, pool exhaustion simply **blocks** (a hard, free ceiling).

Individual Pro/Pro+/Max plans use a separate `base + flex` allowance model; irrelevant to org control except that assigning an org seat auto-cancels a user's personal plan with proration.

### 1.3 The control surface — two families plus one lever

There are **three kinds of control**, and conflating them is the most common failure mode.

**Family A — User-level budgets (ULBs).** Cap each *person's total* credit consumption across **both** phases. **Always a hard stop** (no continue-past option); `$0` blocks immediately. Three scopes, most-specific wins:

| ULB scope | Applies to | Precedence |
|---|---|---|
| Individual ULB | one named user | highest |
| Cost center ULB (CCULB) | every current/future member of a cost center (one per-user amount) | middle |
| Universal ULB | every licensed user by default | lowest |

Because ULBs count included usage, they can **block a user before the pool is exhausted**. The *sum of ULBs is an implicit overage ceiling*: if everyone spent to their cap you would tip into metered.

**Family B — Spending limits.** Cap *metered charges only*, and **only after the pool is exhausted**. Pool-agnostic. **Hard stop is OFF by default** ("Stop usage when budget limit is reached" must be enabled, or charges accrue uncapped).

| Spending limit | Caps | Scope |
|---|---|---|
| Cost center budget | a team's metered charges | per cost center |
| Organization budget | an org's metered charges | per organization |
| Enterprise budget | total enterprise metered charges | enterprise-wide |

Cost centers can be **excluded** from the enterprise budget to spend only against their own cap.

**Lever C — Cost-center included-usage cap (AI credit pool).** A *separate* control that caps how much of the **shared pool** a cost center can draw **before** it tips into metered. Prevents one team draining credits another team's licenses funded — the mechanism that makes chargeback boundaries hold in the pool phase. **Not amount-settable:** GitHub auto-computes the limit from the licenses attributed to the cost center (~3,000 Business / 7,000 Enterprise credits per license, promo) and re-derives it as membership changes — you never enter or maintain a number. The only knobs are **on/off** and, at the cap, **block-or-overflow**. Enabling it does not retroactively redistribute the enterprise pool; from then on the team shares only its own licenses' credits. This makes it categorically different from budgets/ULBs (which take a dollar amount): model it as `enabled: bool` + `overflow: block|metered`, with a read-only computed limit.

**Evaluation order per request:** ULB check first (most-specific applicable) → then pool/metered routing → then the relevant spending limit. **Lowest remaining headroom wins**: whichever applicable control has least capacity blocks first, regardless of what others have left — so ULBs and spending limits must be sized *together*.

### 1.4 What's settable in the UI vs API-only

| Control | UI today | API |
|---|---|---|
| Enterprise / Organization / Cost center budget (metered) | ✅ | ✅ |
| Repository budget | ✅ | ✅ |
| Universal ULB · Individual ULB | ✅ ⚠️ | ✅ |
| "Stop usage when limit reached" (hard stop) | ✅ | ✅ (`prevent_further_usage`) |
| Cost center create + membership + enterprise-team assignment | ✅ | ✅ |
| **Cost center ULB (CCULB)** | ❌ **API-only** (UI "coming soon") | ✅ |
| **Cost center included-usage cap** | ❌ **API-only** (UI "coming soon") | ✅ |

Two consequences that shape the whole design:

1. **The two most useful balancing levers (CCULB, included-usage cap) are API-only right now.** A native admin cannot carve the pool per team or set per-team per-user caps without the API.
2. **⚠️ Known UI display bug:** user-level budgets created in the UI frequently don't appear in the "Budgets and alerts" list, blocking edit/delete and causing "a budget already exists" errors; the community workaround is the REST API (`gh api --method DELETE .../budgets/{id}`). Several orgs blocked everyone with an accidental `$0` universal ULB fixable only via API.

**→ Design stance: the tool is API-first for all writes.** GitHub's UI is treated as read-only/backup, not a parallel control surface — which also removes the out-of-band-drift problem.

### 1.5 The gaps that justify a custom tool

1. **No per-user × per-model × per-surface attribution** in one API (entity-model *or* user-total, not both).
2. **No native forecasting** (run-rate, cycle burn-down, the 1 Sep cliff).
3. **No budget balancing** — native budgets are static values; nothing redistributes headroom dynamically as the cycle progresses. **This is the tool's centrepiece (Part 3/4).**
4. **Fragmented, partly API-only, buggy administration** — no single reliable surface to run all controls.
5. **Reporting latency & no real-time push**; coarse fixed-threshold alerting.

---

## Part 2 — API surface inventory

Header `X-GitHub-Api-Version: 2026-03-10`. **GHE.com:** replace `api.github.com` with `api.SUBDOMAIN.ghe.com`. Enterprise billing/budget endpoints require a **classic PAT with `manage_billing:enterprise`** (no App/fine-grained tokens); org-level endpoints accept several fine-grained token types.

### 2.1 Budget management (CRUD) — GA 4 Jun 2026

`GET/POST /{enterprises|organizations}/{id}/settings/billing/budgets`, plus `GET/PATCH/DELETE /budgets/{id}` and per-user state for a universal-ULB budget.

Budget object: `budget_type` (`ProductPricing` | `SkuPricing` | `BundlePricing`), `budget_product_sku` (e.g. `ai_credits`, `actions`), `budget_scope`, `budget_entity_name`, `budget_amount` (USD), `prevent_further_usage` (hard-stop flag), `budget_alerting {will_alert, alert_recipients[]}`.

`budget_scope` values used by this tool:
- `enterprise` / `organization` / `cost_center` / `repository` — spending limits (Family B).
- **user-level** (universal / individual) — Family A ULBs.
- **`multi_user_cost_center`** — the **CCULB** (API-only). Example: `{budget_amount, prevent_further_usage:true, budget_scope:"multi_user_cost_center", budget_entity_name:"<cost center>", budget_type:"BundlePricing", budget_product_sku:"ai_credits", budget_alerting:{…}}`.

### 2.2 Cost centers & included-usage caps

`/{enterprises}/{id}/settings/billing/cost-centers` — `GET` (list, `?state=active`), `POST` (create), `GET/DELETE /{ccid}`, `POST/DELETE /{ccid}/resource` (add/remove users, orgs, repos, **enterprise teams**). Enterprise-team assignment keeps membership in sync via IdP/SCIM.

**Included-usage cap (Lever C):** toggled on the cost center via the cost-center create/edit API (e.g. `ai_credit_pool_enabled`) with an overflow choice. **No amount field** — the limit is auto-computed from attributed licenses and moves as membership changes, so the shape is `enabled: bool` + `overflow: block|metered`, not a settable value. **API-only today.**

### 2.3 Usage & cost reporting

- `…/settings/billing/ai_credit/usage` — pool + additional spend **by model**; 24-month history.
- `…/settings/billing/usage/summary` — aggregated usage/cost; filter by date, `cost_center_id`, product, SKU.
- `POST /enterprises/{id}/settings/billing/reports` — async CSV (`summarized|detailed|premium_request`; poll for download).
- **Copilot usage metrics API** — `users-1-day`/`users-28-day` include `ai_credits_used` (per-user daily **total** only, not by model/feature/surface).

---

## Part 3 — Product Requirements (PRD)

### 3.1 Problem & goals

Token billing removed the flat-rate ceiling; native controls are static, fragmented, partly API-only, and default to no hard stop. We need one API-first governance plane that **administers every control**, **forecasts**, and — the centrepiece — **auto-balances budgets in both phases** so the pool is fully used without early blocks and metered spend stays capped.

- **G1 — Administer every control** from one surface: all ULBs (universal/CCULB/individual), all spending limits, included-usage caps, hard-stop flags, and cost-center lifecycle/membership. API-first writes.
- **G2 — Forecast** cycle burn-down and metered spend at every scope, including the 1 Sep cliff.
- **G3 — Auto-balance (pool phase):** redistribute access to unconsumed shared pool to blocked / near-blocked (≥95%) users and cost centers before month-end, without tipping into metered.
- **G4 — Auto-balance (metered phase):** redistribute unused enterprise/org spending headroom to near-capped cost centers or individuals.
- **G5 — Attribution & chargeback** by DEWR division/branch/project via cost centers.
- **G6 — Alerting, audit, RBAC** — custom routing, immutable audit, least-privilege tokens.

### 3.2 Non-goals

Not a traffic proxy (GitHub meters server-side). Not the billing system of record. Not per-request model routing. Does not expand the pool (only license changes do) — it redistributes *access*.

### 3.3 Personas

FinOps/budget owner; engineering lead (cost-center owner); enterprise admin (Justin); developer (read-only self-service headroom + projected block date).

### 3.4 Functional requirements

**Administration (G1)**
- FR1. CRUD every control via API: universal/CCULB/individual ULBs; enterprise/org/cost-center budgets; included-usage caps (with block/overflow); hard-stop flags; cost-center lifecycle + membership + enterprise-team resources.
- FR2. Surface the two API-only controls (CCULB, included-usage cap) as first-class UI even though GitHub has no native UI yet; badge them "API-only".
- FR3. Reconcile the ULB display bug: always work from the API's authoritative budget list, detect orphaned/hidden budgets, and offer repair (edit/delete) the UI can't.
- FR4. Validate on write: block the enterprise-cap-too-low trap; flag multi-org-licensed users (random-org billing); warn on `$0`/near-zero ULBs; enforce `prevent_further_usage=true` for any intended hard cap.

**Forecasting (G2)**
- FR5. Per-entity run-rate → pool-exhaustion date and metered $, weekday seasonality, P50/P90, runway-days, backtest (MAPE). Model the 1 Sep allowance step-change.

**Auto-balancing — pool phase (G3)**
- FR6. Detect the trigger: near cycle end AND projected pool underutilisation AND ≥1 entity blocked or ≥95% of its binding ULB / included-usage cap.
- FR7. Compute a **funding envelope** = remaining shared pool − reserve buffer − projected consumption of non-at-risk users to cycle end (the slack light users demonstrably won't use).
- FR8. Resolve each at-risk entity's **binding constraint** and branch on its *type*: if **ULB-bound** (individual > CCULB > universal), propose a grant that raises the *most-specific* lever, allocating greedily from the envelope by priority until exhausted. If **cap-bound** (the team hit its included-usage cap), there is *no grantable delta* — see FR9.
- FR9. Prefer **individual ULB overrides** for surgical unblocks (they take precedence and don't raise quiet members' caps); use **CCULB** only to lift a whole team's per-user ceiling uniformly. For a **cap-bound** team the included-usage cap has no settable amount, so the only moves are **disable the cap**, **switch to overflow (→ metered)**, or **re-attribute licenses** to the cost center — none of which redistribute pool slack. Genuine pool-phase redistribution happens *only* through ULBs.
- FR10. **Simulate** (who unblocks, projected end-of-cycle pool utilisation, probability of tipping into metered) before any apply.

**Auto-balancing — metered phase (G4)**
- FR11. Detect the trigger: metered phase active AND entity ≥95% of its binding metered cap AND a higher-scope budget (org/enterprise) has headroom.
- FR12. Funding envelope = remaining enterprise (or org) budget − reserve − projected metered spend of non-at-risk entities.
- FR13. Resolve the binding budget (ULB vs cost-center vs org vs enterprise — lowest-headroom-wins) and raise *that* one; never grant beyond the envelope unless policy+approval explicitly raise the enterprise budget itself.
- FR14. Simulate (who stays unblocked, projected total metered $, remaining enterprise headroom, bill delta) before apply.

**Grant lifecycle (both phases)**
- FR15. Budgets **persist across cycles** (only the pool resets). Every auto-grant is tracked as a **time-boxed grant** with a policy to **revert or re-baseline at cycle rollover**, preventing ceiling creep that inflates next month's implicit overage exposure.
- FR16. Guardrails: max grant % / absolute per entity, floors, mandatory reserve buffer, approval gates above a threshold, full reversibility.

**Alerting, audit, RBAC (G6)**
- FR17. Custom thresholds + anomaly detection + per-cost-center routing (Slack/Teams/email); don't rely on GitHub's inconsistent ULB alerts.
- FR18. Immutable audit: every recommendation and applied grant records actor, trigger, envelope, binding constraint, before/after, forecast basis, data snapshot. Exportable.
- FR19. RBAC aligned to GitHub roles; least-privilege token handling.

**Simulation & verification (no live credentials yet)**
- FR20. **Simulation mode** — a full runtime mode requiring no PAT, backed by a mock of the GitHub billing/budget API (MSW). It models pooled draw, two-phase routing, ULB precedence, lowest-remaining-headroom-wins, the non-settable included-usage cap, the API-only CCULB, pagination, and the **mutations** (`POST/PATCH/DELETE`) so simulate-before-apply and both rebalancers run end to end. Shipped as an **offline/demo mode admins can toggle** — not stripped from production.
- FR21. **Mock = single source of truth.** The same MSW handlers + fixtures back simulation mode, e2e, and unit tests, so simulation and tests can't drift. Fixtures include edge cases: the ULB display-bug, `$0`-ULB block, cap-bound team, promo→standard cliff. **Stateless/deterministic:** reset to fixtures each run; e2e asserts on the request issued + immediate response, not cross-request persistence.
- FR22. **Simulation-mode safety:** no simulated action reaches real GitHub or mutates a real control; the mode is unmistakable in the UI (persistent banner); apply/grant render as visibly simulated.
- FR23. **Verification gate (every change):** Playwright e2e (headless, MSW-backed, deterministic) is the automated gate; Chrome MCP interactive verification of the running app confirms rendering + behaviour. A change is done only when both pass.

### 3.5 Success metrics

Zero unplanned mid-cycle blocks from pool exhaustion; pool utilisation 85–100%/cycle; metered spend within ±10% of P50; no ceiling creep (grants reverted/re-baselined); 100% of grants traceable to trigger + envelope + actor.

---

## Part 4 — Technical Specification

### 4.1 Architecture

An API-first control/forecast plane: ingest GitHub data on a schedule → forecast → run the two rebalancers under guardrails → push all controls back through the API → audit everything. `.NET` workers on **Azure Container Apps**; forecasting and the rebalancers isolated as their own services so their logic evolves independently.

Read side (observe & forecast): Ingestion → append-only Snapshot store → Forecasting → API/BFF → UI.
Write side (decide & act): Policy/guardrail engine + **Pool rebalancer** + **Metered rebalancer** → Sync engine (desired→live diff/apply) → GitHub; every change → immutable Audit log. Alerting fans out to Slack/Teams/email.

### 4.2 Data model (additions in **bold**)

`snapshot` (append-only); `usage_fact` (date, entity, user?, cost_center?, model, net_qty/amount); `credits_used_fact` (per-user daily total); `license`; `cost_center`, `cost_center_member`; **`included_usage_cap`** (cost_center_id, enabled, computed_limit [read-only, GitHub-derived], overflow_behavior); `budget` (scope incl. `multi_user_cost_center`, amount, prevent_further_usage, live/desired hash); `dewr_mapping`; `forecast`; **`grant`** (entity_ref, phase, lever ∈ {individual_ulb, cculb, cap_disable, cap_overflow, license_reattribute}, delta [null for cap-relax actions], granted_at, expires_at/rollover_policy, trigger_id, envelope_snapshot, status); `audit_event`.

### 4.3 Forecasting

Blended trailing burn (trailing-7 weighted + cycle-to-date) with weekday seasonality → pool-exhaustion date and metered $; allowance is a function of cycle month + existing-customer status, so any forecast crossing 1 Sep uses standard allowances (surfaced as a step-change). P50/P90 from daily-burn variance; nightly backtest (MAPE); latest day treated as provisional (settling window).

### 4.4 Auto-balancing engine

Both rebalancers share one pattern: **detect trigger → size a funding envelope → resolve each at-risk entity's binding constraint → allocate greedily by priority → simulate → apply the most-specific lever via API → track as a grant → revert/re-baseline at rollover.** Greedy allocation against a hard envelope is sufficient (and explainable); the envelope guarantees we never over-commit.

**A. Pool-phase rebalancer — "use-it-or-lose-it" pool optimiser**
- *Why:* unused pool credits are forfeited at reset while some users/cost centers are already blocked or ≥95% of their ULB. Raising a ULB doesn't grow the pool — it raises a ceiling so that user can draw the *unconsumed shared slack*.
- *Envelope:* `remaining_pool − reserve − Σ projected_consumption(non-at-risk to cycle end)`.
- *Redistribution levers (the only ones that hand out pool slack):* **individual ULB override** (surgical — precedence over CCULB; unblocks one user without raising the team) → **CCULB** (blunt — lifts every member's per-user ceiling uniformly). Cost-center *budgets* are metered-only and the included-usage cap doesn't grant, so **ULBs are the entire redistribution toolkit in this phase.**
- *Cap-bound teams are a separate branch — relax, don't redistribute:* if a team is blocked by its **included-usage cap** while the enterprise pool still has slack, no ULB raise helps (lowest-headroom-wins; the cap binds). The only moves are **disable the cap**, **overflow → metered**, or **attribute more licenses** — a boundary decision, not a grant. The binding-constraint resolver must distinguish *cap-bound (relax-only)* from *ULB-bound (redistributable)*, because their remediation sets don't overlap.
- *Allocate:* rank ULB-bound at-risk entities (blocked first, then proximity-to-limit / business priority / demonstrated throughput); grant each the delta that covers projected remaining demand; stop when the envelope is spent; keep the reserve.
- *Safety:* never let the sum of raised ceilings exceed remaining pool + allowed metered; simulate probability of tipping into metered; approval per guardrails.
- *Concrete scenario (your example):* day 26 of 30, pool 68% consumed (projected 82% at reset → ~18% forfeit), 6 users blocked and 11 at ≥95%. Envelope = the ~18% slack minus reserve. Tool raises individual ULBs for the 17 at-risk users (funded by the slack), simulates end-state 96% utilisation with <3% metered-tip risk, applies on approval, and tags each as a grant to revert at reset.

**B. Metered-phase rebalancer — spending-headroom redistributor**
- *Why:* after the pool is gone, some cost centers/individuals hit their metered cap while the enterprise/org budget still has large unused headroom.
- *Envelope:* `remaining_enterprise(or org)_budget − reserve − Σ projected_metered(non-at-risk)`.
- *Levers:* raise the **binding** budget only — resolve ULB vs cost-center vs org vs enterprise via lowest-remaining-headroom; raise that one. Excluded cost centers are funded from their own cap, not the enterprise envelope.
- *Allocate:* rank near-cap entities; grant deltas from the envelope; never exceed it unless policy+approval raise the enterprise budget itself.
- *Simulate:* who stays unblocked, projected total metered $, remaining enterprise headroom, and the resulting **bill delta**, before apply.
- *Concrete scenario (your example):* enterprise metered budget $8,000, $6,300 unused with 4 days left; cost center *Platform* at 98% of its $600 cap and 3 individuals near their ULB. Tool redistributes from the $6,300 envelope: +$250 to *Platform*'s cost-center budget and individual-ULB bumps for the 3 users (whichever is binding for each), simulates the bill delta, applies on approval, grants tracked.

**Guardrails (shared):** max grant per entity (% and absolute), floors, mandatory reserve buffer, approval threshold, dry-run default, full rollback, and the **grant lifecycle** (revert/re-baseline at rollover) so temporary end-of-cycle generosity never becomes a permanent higher ceiling.

### 4.5 Sync engine, auth, security

Declarative desired-state (Terraform-style): recommender/rebalancers emit desired budgets/caps; engine diffs vs live (`GET /budgets`, cost-center state) and applies idempotent `POST/PATCH/DELETE`. Reconciles out-of-band UI edits. **API-first for all writes** (mandated by the API-only levers + the ULB display bug). Classic PAT with `manage_billing:enterprise` in Azure Key Vault; separate read/write tokens for separation of duties; write token reachable only by the sync engine's service identity. **Government posture:** append-only, hash-chained audit; every automated grant explainable from its recorded trigger + envelope + forecast basis.

### 4.6 Edge cases

Lazy universal-ULB records → reconcile against full licensing. Mid-cycle seat add (pool grows now) vs removal (next cycle) → forecast on *effective* pool. "AI credit paid usage" policy state changes exhaustion semantics (block vs meter) → ingest it. Reporting lag → settling window. Code-review Actions-minutes second meter → surface alongside credits. Budgets persist across cycles → grant lifecycle mandatory. Cost centers are **GHE Cloud only** → both API-only levers unavailable on Business-without-enterprise.

### 4.7 Simulation mode & test architecture (MSW)

No live credentials exist yet, so **simulation mode is the primary development and verification surface** (and ships as an offline/demo mode admins can toggle). A single **MSW (Mock Service Worker)** layer fakes the GitHub billing/budget API and is the shared source of truth for three consumers — simulation mode, Playwright e2e, and unit/component tests — so behaviour and tests can't drift.

- **Models:** pooled draw, two-phase routing, ULB precedence, lowest-remaining-headroom-wins, the non-settable included-usage cap, the API-only CCULB, pagination, and the **mutations** (`POST/PATCH/DELETE`) so simulate-before-apply and both rebalancers run end to end. Edge fixtures: ULB display-bug, `$0` block, cap-bound team, promo→standard cliff.
- **Stateless/deterministic:** reset to fixtures each run; e2e asserts on the request issued + immediate response, not cross-request persistence; apply→result within a session uses optimistic UI.
- **Safety:** simulated actions never reach real GitHub or mutate a real control; the mode is unmistakable in the UI (persistent banner).
- **Verification gate (every change):** Playwright e2e (headless, MSW-backed, deterministic) is the automated gate; Chrome MCP verification of the running app is the interactive confirmation. Both green = done.

*(This subsection assumes the local-first Electron/TypeScript desktop delivery; MSW/Playwright/Chrome MCP are TS-stack tooling. §4.1/§4.5's original server architecture predates that pivot — reconcile separately.)*

### 4.8 Build phases

0. **Simulation harness + scaffold (first).** Monorepo + packages + Electron shell + `ApiClient` interface + Drizzle schema, **and** the MSW layer + fixtures, simulation-mode toggle, and the Playwright + Chrome-MCP gate. Smoke test: "Sync now" pulls a usage report *from MSW* into SQLite, verified through the gate.
1. **Read-only observability** (ingest, snapshots, dashboards).
2. **Full control administration** (API-first CRUD of all controls incl. the two API-only levers; ULB-bug repair).
3. **Forecasting** (run-rate, cliff, runway, P50/P90, backtest).
4. **Auto-balancing, dry-run** (both rebalancers, simulate only).
5. **Guardrailed auto-apply + grant lifecycle + custom alerting.**
6. **Chargeback + audit export.**

Every phase passes the verification gate (Playwright + Chrome MCP against MSW) before it's done.

---

## Part 5 — Open questions before build

1. **Enterprise or Business**, and **github.com or GHE.com**? Gates cost centers, CCULBs, included-usage caps, allowances, and API host.
2. **"AI credit paid usage" enabled?** Determines whether the metered rebalancer is even in scope.
3. **Cost centers** in use, driven by **enterprise teams** aligned to DEWR division/branch?
4. **Pool posture:** hard-stop at pool (no metered) or controlled metered budget? Sets default `prevent_further_usage`.
5. **Auto-apply appetite:** recommend-only, or guardrailed auto-balancing — and the **reserve buffer %** and **grant rollover policy** (revert vs re-baseline)?
