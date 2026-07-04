# Claude Design Handoff — Copilot Budget Manager UI

**Status:** Draft v0.2
**Purpose:** Design brief for the front end of the Copilot Budget Manager (see companion PRD/spec v0.2). This is an **API-first FinOps control plane for GitHub Copilot AI-credit spend**: administer every budget control, forecast the pool, and — the centrepiece — **auto-balance in both phases** (redistribute unused pool access before month-end; redistribute unused metered headroom after the pool is gone).

**Audience:** enterprise admins, FinOps/budget owners, engineering leads (cost-center owners), read-only developers.

---

## Design principles

1. **Forecast-forward.** Every screen leads with "where are we heading this cycle" — runway, projected block/overrun — not last month's spend.
2. **We are the admin surface, not a mirror of GitHub's.** Two controls (cost-center ULB, included-usage cap) have **no native UI**, and GitHub's user-level budget UI has a known display bug. This tool is where controls are actually run. Badge API-only controls so their power is obvious, not hidden.
3. **Redistribution over restriction.** The signature capability isn't blocking people — it's moving unused headroom to whoever's blocked. Make "unblock within budget" the hero action.
4. **Simulate before you commit.** No write — especially no auto-grant — without a preview of who blocks/unblocks and the pool/spend/bill delta.
5. **Grants are temporary by default.** End-of-cycle generosity must visibly expire, so ceilings don't creep. Show every grant's lifecycle.
6. **Audit is a feature.** Every change shows actor + trigger + the envelope and forecast it was based on, inline.
7. **Calm, dense, government-grade.** Extend the DEWR `apex` system (dark, violet ladder, Gabarito), with mint/amber/red carrying the FinOps semantics from the controls-compare visual.
8. **Simulation must be unmistakable.** With no PAT yet, the app runs mostly in simulation mode (MSW-backed), and it also ships as a toggleable offline/demo mode. A **persistent, unambiguous banner** must mark simulation at all times, and every apply/grant action must read as *simulated* — never let a simulated action look live. This is a money-safety requirement, not decoration.

---

## Information architecture (primary nav)

1. **Overview** — enterprise health: pool burn-down, projected exhaustion, metered forecast, at-risk count, active grants, alerts.
2. **Forecast** — per-entity projections, runway, P50/P90, the 1 Sep cliff, backtest accuracy.
3. **Controls** — administer everything: the two families + the included-usage cap, across all scopes; desired-vs-live diff; simulate & apply. *(Replaces the old "Budgets" screen.)*
4. **Auto-balance** — the two rebalancers (pool phase, metered phase): triggers, envelope, proposed grants, simulate, approve, grant lifecycle.
5. **Cost centers** — lifecycle, membership (incl. enterprise teams), DEWR mapping, per-center pool + metered position, exclusion status.
6. **Users** — heavy-user table, per-user credits, best-effort model mix, ULB overrides, projected block date.
7. **Chargeback** — showback/chargeback by division/branch/project; export.
8. **Audit** — immutable event stream (grants, edits, reconciliations).
9. **Settings** — token/permission health, policy state, alert routing, and **auto-balance guardrails** (reserve buffer, max grant, approval threshold, grant rollover policy).

---

## Key screens

### 3. Controls (administer everything)

The write surface. Organised by the **two-families + one-lever** model, not a flat list, so the phase/hard-stop semantics are legible.

- **Family tabs:** *User-level budgets* (universal · cost-center ULB · individual) · *Spending limits* (enterprise · org · cost-center) · *Included-usage caps* (per cost center).
- **Control row:** name, scope, what it caps, current value, **phase badge** (both / metered / pool), **hard-stop state**, live-vs-desired status.
  - **API-only badge** on cost-center ULB and included-usage cap (violet pill, matching the controls-compare visual) — with a tooltip: "No native GitHub UI yet; managed here via API."
  - **Hard-stop indicator is loud.** A spending limit with hard-stop off shows a bold amber pill: "⚠ Alert-only — spend continues past this limit." Creating one requires explicit confirm.
- **ULB-bug repair affordance:** a banner when the tool detects orphaned/hidden user-level budgets (present in API, invisible in GitHub's UI) with one-click view/edit/delete — the thing GitHub's UI can't do.
- **Included-usage cap control:** per cost center, a toggle (auto-computed limit shown, "≈ funded by 42 licenses") plus a block-or-overflow choice; explains it carves the shared pool so one team can't drain another's.
- **Desired-vs-live diff:** Terraform-plan aesthetic (add green / change amber / delete red, old→new).
- **Simulate panel (mandatory before apply):** projected blocked/unblocked users and spend delta, plus inline validation: enterprise-cap-below-sum-of-cost-centers; multi-org-licensed users; `$0` ULBs; missing hard-stop.
- **Apply:** requires justification; approval above threshold; confirmation lists exactly what will be pushed via API.

### 4. Auto-balance (the centrepiece)

Two modes on one screen, switched by the current phase (or shown side-by-side). Each mode follows the same five-panel flow.

**Shared flow:** ① *Trigger status* → ② *Funding envelope* → ③ *At-risk entities + proposed grants* → ④ *Simulate* → ⑤ *Approve & apply → grant lifecycle.*

**Mode A — Pool rebalancer ("use it or lose it")**
- **Trigger status:** "Day 26/30 · pool 68% consumed · projected 82% at reset → ~18% forfeit · 6 blocked, 11 at ≥95%." Green/amber/red on whether conditions are met.
- **Envelope tile:** the redistributable slack = remaining pool − reserve − projected consumption of non-at-risk users. Show the reserve carved out explicitly.
- **At-risk table:** entity, current binding lever, % of limit, projected remaining demand, and a **proposed action** that depends on the binding *type* — the table must show two distinct action shapes:
  - **ULB-bound** (Individual / CCULB / Universal) → a **proposed grant** (Δ on the *most-specific* lever). Editable per row; prefer individual overrides (surgical) over CCULB (raises the whole team).
  - **Cap-bound** (team hit its included-usage cap) → **no Δ** — instead a **relax action** chooser: *disable cap*, *overflow → metered*, or *re-attribute licenses*. Make it visually clear this isn't a grant (it doesn't draw from the envelope); the included-usage cap has no settable amount.
- **Simulate:** projected end-of-cycle pool utilisation (before/after), **probability of tipping into metered**, list of who unblocks. A clear "won't exceed remaining pool" assurance.
- **Apply → grants:** each grant tagged with expiry = cycle reset and a rollover policy (revert / re-baseline).

**Mode B — Metered redistributor**
- **Trigger status:** "Metered phase · enterprise budget $8,000, $6,300 unused, 4 days left · Platform CC at 98%, 3 users near ULB."
- **Envelope tile:** remaining enterprise (or org) budget − reserve − projected metered of non-at-risk.
- **At-risk table:** entity, **binding budget** (resolved via lowest-remaining-headroom: ULB vs cost-center vs org vs enterprise), % of cap, proposed Δ on that budget. Excluded cost centers shown as self-funded.
- **Simulate:** who stays unblocked, projected total metered $, remaining enterprise headroom, and the **bill delta ($)** — the number FinOps signs off on.
- **Apply → grants:** same lifecycle treatment.

**Active grants panel (both modes):** every live grant with entity, lever, Δ, granted-by, expiry, and a one-click revert. A "grant creep" guard surfaces any grant that persisted past a reset.

### 5. Cost centers
List: name, DEWR division/branch/project, members (with "driven by enterprise team X" badges), pool position (drawn vs included-usage cap), metered spend vs budget, exclusion status. Drill-in edits membership, the included-usage cap, and the CCULB (both API-only, badged). Mapping editor to DEWR financial structure.

### 6. Users
Heavy-user table: login, cost center, `ai_credits_used` MTD, trend sparkline, best-effort model mix (with explicit "unattributable %"), current binding ULB (universal / CCULB / individual), projected block date. Row action: set/adjust individual ULB → same simulate-before-apply flow; also the fastest path for the pool rebalancer to target a single power user.

### 7. Chargeback
Pivot division → branch → project; credits and $; include the **code-review Actions-minutes** second meter as its own column. Export stamped with the snapshot timestamp.

### 8. Audit
Immutable, filterable stream. Each event expands to actor, **trigger + envelope + binding constraint** (for grants), before/after, and a link to the forecast + data snapshot. Read-only. Export.

### 9. Settings
Token/permission health (is the `manage_billing:enterprise` token valid; read vs write separation; last sync). **Mode:** a **Live / Simulation toggle** — Live requires a valid PAT; Simulation (MSW-backed) needs none and is the default with no PAT. Switching to Live requires an explicit, confirmed step. **Policy state:** "AI credit paid usage" enabled/disabled (changes whether pool exhaustion means block or meter — display prominently). **Auto-balance guardrails:** reserve buffer %, max grant (% + absolute), approval threshold, **grant rollover policy** (revert vs re-baseline). Alert routing per cost center.

---

## Cross-cutting states

- **Data lag:** latest day marked "provisional" (hatched) so nobody acts on incomplete data.
- **Lazy/empty:** universal-ULB records appear only after usage — reconcile against full licensing; label users "no usage yet this cycle," not absent.
- **Drift:** budgets edited outside the tool are flagged with reconcile.
- **API-only everywhere it matters:** the two API-only controls look and behave like any other control here — the badge is informational, not a limitation.
- **Dry-run default for all writes.** No apply — and no auto-grant — without preview + confirm.
- **Simulation banner (persistent).** Whenever the app is in simulation/offline mode, a fixed banner marks it and apply/grant actions render as "simulated" — visually distinct from live actions, so a demo action can never be mistaken for a real budget change.

---

## Visual direction

- Extend DEWR `apex`: dark violet surface, purple token ladder, Gabarito display over IBM Plex Sans/Mono.
- **Semantics carried in colour, consistent with the controls-compare visual:** mint = healthy / always-hard-stop / within budget; amber = approaching / alert-only / hard-stop-off; red = block / overrun; violet = API-only + structural accent.
- **Signature components:** the pool **burn-down** (allowance line + P50/P90 band + exhaustion marker + 1 Sep step-down) and the **auto-balance envelope→grants** view (a redistributable-slack bar being parcelled out to at-risk entities).
- WCAG 2.1 AA; never encode block/alert/API-only state in colour alone (icon + label).

---

## What to prototype first

1. **Controls screen** with the two-families layout, the API-only badges, and the hard-stop warning pill.
2. **Auto-balance → Pool rebalancer**: trigger status → envelope tile → at-risk table with proposed grants → simulate (pool utilisation before/after + metered-tip risk).
3. **Auto-balance → Metered redistributor**: envelope → binding-budget resolution → simulate with the **bill delta**.
4. **Cliff banner** for the 1 Sep allowance drop (persistent, on Overview + Forecast).

These carry the product's core value: run every control from one place, and redistribute unused headroom safely in both phases.
