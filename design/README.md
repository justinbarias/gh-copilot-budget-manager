# Handoff: Copilot Budget Manager — v2

An API-first **FinOps control plane for GitHub Copilot AI‑credit spend**. Admins forecast the credit pool, administer every budget control from one place, and — the centerpiece — **auto‑balance unused headroom in both billing phases** (redistribute unused shared‑pool access before month‑end; redistribute unused metered budget after the pool is gone).

---

## About the design files

The files in this bundle are **design references created in HTML**, not production code to copy directly. They are a working prototype that demonstrates the intended **look, layout, data, and interaction behavior**.

The entry file, `Copilot Budget Manager v2.dc.html`, is a **"Design Component" (DC)**: an HTML template plus a JavaScript logic class (a React‑style component) rendered by the bundled `support.js` runtime. Open the two files together in a browser to explore the prototype. **Do not ship these files.** The task is to **recreate the designs in the target codebase's existing environment** (React, Vue, Svelte, SwiftUI, etc.) using its established components, state patterns, and charting library. If no front‑end environment exists yet, pick the most appropriate stack for the project (a React + TypeScript SPA with a charting lib such as visx/Recharts and a table primitive is a natural fit) and implement there.

All numbers in the prototype are **illustrative seed data** driven by a demo‑scenario switch; wire the real screens to the billing/forecast API described under **Domain model**.

## Fidelity

**High‑fidelity.** Colors, typography, spacing, iconography (glyph‑based), semantics, and interactions are final. Recreate the UI faithfully using the codebase's existing primitives, matching the exact tokens in **Design tokens**. The aesthetic is a **dark, dense, "government‑grade" analytics console** in a GitHub‑adjacent palette (see note under Design tokens).

---

## Domain model (read this first — the UI encodes it)

Every cycle runs in **two phases**, and the controls behave differently in each. This distinction drives almost every screen.

- **Unit:** GitHub **AI Credits**; 1 credit = $0.01. Consumption is metered server‑side per model/token.
- **Pool phase** — consumption draws from a **shared included‑credit pool** pooled at the billing‑entity level. Resets monthly, no carryover. A promo allowance (~500k in the demo) steps **down ~37% on 1 Sep 2026** to a standard allowance (~315k) — model it as a step‑change, not a trend ("the cliff").
- **Metered phase** — after the pool is exhausted, usage bills at $0.01/credit **only if** the "AI credit paid usage" policy is enabled; if disabled, pool exhaustion simply **blocks**.

**Three kinds of control (the "two families + one lever" model):**

1. **User‑level budgets (ULBs)** — cap a person's **total** consumption across **both** phases. **Always a hard stop**; `$0` blocks immediately. Three scopes, most‑specific wins: **Individual** → **Cost‑center ULB (CCULB)** → **Universal**.
2. **Spending limits** — cap **metered charges only**, after the pool is exhausted. Scopes: enterprise, org, cost‑center. **Hard‑stop is OFF by default** (alert‑only unless "stop usage" is enabled).
3. **Included‑usage cap (Lever C)** — per cost center, caps how much of the **shared pool** a cost center can draw before it tips into metered. **Auto‑computed from the licenses attributed to the cost center — it is NOT a dial‑able number**; you toggle it on/off and choose block‑or‑overflow.

**Two controls have no native GitHub UI** and are marked **API‑ONLY** (violet badge): the **CCULB** and the **included‑usage cap**. GitHub's user‑level‑budget UI also has a known display bug (budgets present in the API but hidden in the UI) — the tool surfaces a repair affordance for this.

**Auto‑balance levers (important — corrected in v2):**
- A **user** about to bust their Universal ULB or CCULB is granted a **new individual ULB override** — never by raising the shared Universal/CCULB (which would lift the ceiling for everyone in that scope).
- A **cost center** over its **included‑usage cap** is fixed by **lifting the cap** (a toggle; the cap value itself can't be dialed because it's license‑derived), letting the team draw from the shared pool.
- In the **metered** phase, raise the **binding budget** (cost‑center / org / enterprise metered limit), resolved by lowest‑remaining‑headroom; users still get individual ULB overrides.
- **Grants are temporary:** every auto‑grant is time‑boxed and expires at cycle reset with a **revert** or **re‑baseline** policy, preventing ceiling creep.

---

## Global shell & navigation

- **Two‑column app shell:** fixed **236px sidebar** (`#000000`) + fluid main column (`#0d1117`).
- **Sidebar:** brand lockup (pulsing green status dot + "Copilot Budget / FinOps control plane"); vertical nav; footer token‑health block ("manage_billing:enterprise · valid · last sync 4m ago · read+write").
- **Nav items** (in order): Overview, Forecast, **Controls**, **Auto‑balance**, Cost centers, Users, Chargeback, Audit, Settings, Help. Active item: `#151a22` fill, white text, 3px green (`#5fed83`) left bar. Hover: `#151a22`. Some items carry a small red count **badge** (e.g. at‑risk count) in the "At risk" / "Surplus" demo scenarios.
- **Top bar (60px, sticky):** screen title (19px/500 white) + cycle label ("Cycle Jul 2026 · Day 12 of 30 · GitHub Enterprise · dewr"); right side has a **demo‑scenario segmented switch: Healthy / At risk / Surplus** (a pill toggle) that re‑seeds all screens.
- Content area scrolls; each screen is a `<section>` padded `24px 28px 64px` with a per‑screen `max-width` (1080–1360px).

---

## Screens / views

> Each screen's exact markup and seed values live in `Copilot Budget Manager v2.dc.html`. Descriptions below give layout, components, and intent.

### 1. Overview
Enterprise health at a glance. **Persistent cliff banner** at top (red‑left‑bordered gradient card): "Included allowance drops on 1 Sep 2026 — pool falls ~37%" with a "Visualise the cliff →" link to Forecast. In the Surplus scenario, a blue banner replaces it: "Drastic underconsumption … redistribute them now →" linking to Auto‑balance.
- **Forecast‑lens toggle** (Pool phase / Metered phase).
- **Signature pool burn‑down chart** (see Signature components) in a `#151a22` card, with a legend (Actual burn / Forecast P50 / P10–P90 band / Allowance) and a "most recent day is provisional (hatched)" caption.
- **Runway tiles:** 4‑up grid of metric cards (label 12px muted, value 26px/500 tabular, sub 12px). Values/colors change per scenario (e.g. "Pool runway 11 days" red; "Projected metered spend $2,340" amber).
- **Alerts & anomalies** list: severity dot + mono tag + title + meta + timestamp; "View in audit →".

### 2. Forecast
Per‑scope projections with a P50/P90 burn‑down and a backtest.
- **Scope tabs:** Enterprise · Organization · Cost center · Heavy user. When a scope has multiple entities, an entity `<select>` appears.
- **Allowance‑basis toggle** (Promo 500k / Standard 315k) — shown for Enterprise & Heavy‑user scopes only.
- **Pool burn‑down card** — headline runway, projected exhaustion/block date (right), a one‑line caption, and the burn‑down chart.
- **Cost‑center behavior (v2, important):** a cost center **with its included‑usage cap ON** gets its **own pool burn‑down against that cap** ("CC: Payments Platform · included‑usage cap · runway", "Cap block date · Jul 17", allowance line = the computed cap). A cost center **with the cap OFF** shows a **"No included‑usage cap on …" explainer card** (no per‑team pool ceiling → nothing to forecast) with an **"Enable included‑usage cap in Controls →"** CTA. Both still show the metered‑phase forecast below. The cap's overflow choice drives the label ("Cap block date" vs "Overflow‑to‑metered date").
- **Metered‑phase spend card** — a horizontal budget bar (P50 fill, P10–P90 band, budget/hard‑stop line).
- **Bottom grid:** Backtest chart (Actual vs Forecast line, MAPE pill) + Percentile detail (P10/P50/P90 rows).

### 3. Controls  *(replaces the old "Budgets" screen)*
The write surface, organized by the **two families + one lever**, not a flat list.
- **Family tabs:** User‑level budgets · Spending limits · Included‑usage caps. A one‑line explainer describes the selected family's semantics. A "⇄ Auto‑balance headroom" button links to Auto‑balance.
- **ULB‑bug repair banner** (violet, User‑level family only): "2 orphaned user‑level budgets detected — in the API, invisible in GitHub's UI" with "View & edit via API" / "Delete the $0 ULB" / dismiss.
- **Control table** (User‑level & Spending families): columns **Control · what it caps | Phase | Cap (credits) | Enforcement | Utilization · alerts**.
  - **Phase badge** pill per row: `both phases` (green), `metered only` (amber), `pool phase` (blue).
  - **API‑ONLY** violet pill on CCULB rows (and included‑usage caps).
  - **Enforcement:** ULBs show a locked "Hard stop · always" green pill; spending limits show a hard‑stop **toggle** (green track = hard stop, amber track = alert‑only). An alert‑only spending limit renders a **loud amber pill**: "⚠ Alert‑only — spend continues past this limit. No hard stop."
  - **Utilization:** a thin meter (green<alert, amber≥alert, red over) + editable alert‑threshold field; "● staged change" / "⤺ drift — reconcile" markers.
  - Editing a cap, toggling enforcement, or editing alerts **stages** a change (nothing writes until Apply).
- **Included‑usage caps family:** a responsive grid of **per‑cost‑center cards** — CC name + API‑ONLY badge, enable **toggle**, auto‑computed limit ("≈79,800 funded by 42 licenses"), a "drawn" progress bar, and a **Block / Overflow → metered** segmented choice. Staged like the table.
- **Right rail (sticky) — plan → simulate → apply:**
  - **Plan — desired vs. live**: a **Terraform‑style diff** (mono, add‑green `+`, change‑amber `~`, delete‑red `-`, `old → new`), including included‑cap changes (`included_cap["ML Research"].enabled: false → true`).
  - **Simulate before apply**: "Run dry‑run simulation" → newly blocked (red) / newly unblocked (green) counts, Δ projected metered spend, and inline validation warnings (enterprise cap below sum of cost centers, `$0` ULBs, multi‑org‑licensed users, missing hard‑stop).
  - **Apply**: requires a justification textarea; changes above the approval threshold (50,000 credits) require approval; button relabels through the flow. Applying writes to the Audit log and shows a success toast.

### 4. Auto‑balance  *(the centerpiece)*
Two rebalancers on one screen, switched by a segmented control; defaults to the mode matching the current phase.
- **Mode switch:** **Pool rebalancer** ("use it or lose it") / **Metered redistributor** ("spending‑headroom redistributor").
- **① Trigger status** — a status card: amber dot, "① Trigger status · <phase>", the trigger sentence (e.g. "Day 26/30 · pool 68% consumed · projected 82% at reset → ~18% forfeit · 6 blocked, 11 at ≥95%"), a Day X/Y + days‑left readout, and a row of **condition chips** (green check + label + detail) showing which trigger conditions are met.
- **② Funding envelope** — the **signature envelope bar** (see Signature components) + the formula caption (`remaining pool − reserve − Σ projected(on‑track)`), with reserve carved out explicitly and the redistributable amount.
- **③ At‑risk entities · proposed grants** — a table: **Entity | Grant lever | % limit | Remaining demand | Proposed Δ**.
  - **Grant lever** shows the lever actually pulled. Users → `Individual ULB` (with a "converts from Universal ULB / CCULB · …" sub‑label when they're currently bound by a shared cap); a batched row reads `Individual ULB ×11`. A cost center over its cap → `Lift usage cap`.
  - **Proposed Δ** is an editable number field **for ULB/budget levers**; for the **lift‑cap row** it is a **toggle** ("lift → +2,400" / "keep cap") because the cap is not numerically adjustable.
  - A footer shows "N of M rows funded · reset to suggested" and "allocated X · unallocated Y" (green within envelope, red if over). Edits update the envelope + simulation **live**.
- **④ Simulate** (sticky right rail) — three metric cards. Pool mode: **Pool utilisation at reset** (before → after), **Metered‑tip probability**, **Users unblocked**. Metered mode: the hero **Bill delta** (what FinOps signs off), **Projected total metered**, **Remaining enterprise headroom**. Plus an assurance note ("Stays within the remaining pool …" green, or an over‑allocation warning red).
- **⑤ Approve & apply → grant lifecycle** — justification textarea, a note that grants are time‑boxed with the revert/re‑baseline policy from Settings, and an apply button that relabels by state ("Add justification to apply" → "Approve & apply N grants" / "Reduce grants to within envelope"). Applying creates grants and writes an audit event carrying the trigger + envelope.
- **Active grants panel** (below, both modes) — table: Entity (+ pool/metered phase pill) | Lever | Δ | Granted by | Expiry | **Revert**. A **grant‑creep guard** badge flags any grant that persisted past a reset.

### 5. Cost centers
Table: Cost center | DEWR mapping (division → branch → project) | Members | MTD burn | Headroom (amber when low, red when negative) | Status (within / over cap / excluded). "+ New cost center" opens a modal (name, DEWR mapping fields, "exclude from enterprise budget" toggle). Clicking a row opens a **drill modal**: MTD/headroom/excluded stat tiles + membership list (with "ent‑team: …" badges).

### 6. Users
Heavy‑user table with search, cost‑center filter, and status filters (All / Active / At risk / No usage). Columns: checkbox | Login (mono; "✕ block ~date" or "no usage yet this cycle" sublabels) | Cost center (`<select>`, 1:1 reassign) | Credits MTD | Trend **sparkline** | **Model‑mix bar** (best‑effort, with explicit "unattributable %") | ULB | "Set ULB". Row → individual‑ULB modal (value, dry‑run text, justification). Multi‑select → bulk‑ULB modal. Pagination (10/page).

### 7. Chargeback
Pivot table Division → Branch → Project (indented), columns: Credits | Metered $ | **Code‑review Actions minutes** (a second meter, shown as its own column). Snapshot‑timestamp header; Export CSV / Export PDF.

### 8. Audit
Immutable, filterable event stream (All / Budget / ULB / Auto‑balance). Each event: mono action badge + entity + actor · timestamp, expandable to **Before → After** (red → green mono), and — for auto‑balance grants — a **Trigger & binding constraint** + **Funding envelope** block, the justification, and a link to the forecast/data snapshot. Read‑only; Export.

### 9. Settings
Two‑column grid of cards: **Token & permission health**; **Policy — AI credit paid usage** (toggle changes whether pool exhaustion meters or blocks; card border turns amber when paid usage is ON); **Auto‑balance guardrails** (full‑width): on/off, four stat tiles — **Reserve buffer 5% · Max grant 15%·20k · Floor per cost center 5,000 · Approval threshold 50,000 credits** — and a **Grant rollover policy** segmented control (**Revert at reset** / **Re‑baseline**) with an explanation line; **Alert routing** per cost center.

### Help (reference screen)
Explains how a single request is evaluated (ULB → pool/metered routing → spending caps), the ULB precedence ladder, the two phases, and "rules that surprise people."

---

## Signature components (recreate carefully)

- **Pool burn‑down chart** — an SVG line chart: solid white **actual** cumulative burn; dashed blue **P50** forecast; translucent blue **P10–P90 band**; dashed neutral **allowance** line with label; a red **exhaustion marker** (dot + callout "Exhaustion · <date> · day N") with a faint red overrun shade after it; a hatched **provisional** last‑day column; y‑grid in "k" units, x‑axis in cycle days; P10/P50/P90 end labels. Reused at enterprise, heavy‑user, and (v2) cost‑center‑cap scope, and for the backtest (smaller variant).
- **Funding‑envelope bar** — a horizontal segmented bar sized to the *remaining* pool/budget: **Reserve** (hatched neutral) · **Held / on‑track use** (faint) · **→ grants** (blue tint, grows with allocation) · **slack** (green tint, the unallocated remainder). Below it, a two‑part brace ("not touchable" | "envelope = redistributable slack", blue underline) and end captions ("remaining shared pool · unconsumed 160,000" ↔ "0 → tip into metered"). Segment widths are proportional to credit/$ amounts and update live as grants are edited.
- **Budget meter** — thin rounded track with alert‑threshold ticks; fill color green/amber/red by utilization; mono "N% used · alert 75/90" caption.
- **Metered budget bar** — horizontal $ bar with P50 fill, P10–P90 band, P50 dot, P90 tick, and a dashed budget/hard‑stop line.
- **Sparkline** and **model‑mix stacked bar** — small inline SVGs in the Users table.
- **Toggles** — 34×20 pill track, 14px white knob, green (`#238636`/`#2ea043`) when on, amber (`#9e6a03`) for alert‑only enforcement, neutral (`#30363d`) when off.
- **Segmented pill switches** — `#151a22` track, `#30363d` border, 60px radius; active segment `#24292f` fill + white text.

---

## Interactions & behavior

- **Demo‑scenario switch** (Healthy / At risk / Surplus) re‑seeds every screen's numbers, banners, alerts, tiles, and badges. In a real build this is replaced by live data; keep the three states as a useful QA fixture set.
- **Staged edits → dry‑run → apply** is the universal write pattern (Controls, individual/bulk ULB modals, and Auto‑balance): nothing mutates live state until an explicit apply, which requires justification, may require approval above threshold, writes an immutable audit event, and shows a success toast (~3.8s).
- **Live recomputation:** editing an at‑risk grant amount (or toggling lift‑cap) instantly updates the envelope bar, the allocated/remaining totals, and the simulation cards; over‑allocation flips the assurance note to a red warning and disables apply.
- **Navigation cross‑links:** cliff/surplus banners → Forecast/Auto‑balance; Controls ↔ Auto‑balance; Forecast cap‑off card → Controls (Included‑usage caps); alerts → Audit; grant revert updates the active‑grants list and writes an audit event.
- **Accessibility intent (from the brief):** WCAG 2.1 AA; **never encode block/alert/API‑only state in color alone** — always pair with an icon + text label (the prototype follows this: "⚠ Alert‑only …", "API‑ONLY", "Hard stop · always", etc.). Preserve that when reimplementing. Respect `prefers-reduced-motion` for the pulsing status dot and any chart draw‑in.
- **Hover states:** nav items, buttons, and table rows lighten to `#151a22`/`#1a2029`; bordered buttons brighten their border to `#8dd6ff`. Inputs focus to a `#8dd6ff` border.

## State management

Single component in the prototype; in a real app, split by screen/domain. Key state:
- **Navigation:** `screen`; per‑screen sub‑tabs (`controlFamily`, `budget/forecast scope`, `forecastBasis`, `abMode`).
- **Demo:** `scenario` ('healthy'|'danger'|'surplus').
- **Staged writes:** `desired` (budget edits keyed by control id), `desiredIC` (included‑cap edits keyed by cost center), `simResult`, `justification`, `pendingApproval`.
- **Auto‑balance:** `abAlloc` (per‑row proposed grant, keyed `mode:entityId`; a lift‑cap row stores 0 or its fixed contribution), `abJust`, `abApplied` (active grants).
- **Domain data (replace with API):** `liveBudgets`, `liveIC`, `costCentersList`, `userCCMap`, `auditLog`, plus policy/guardrail flags (`policyPaid`, `autoBalance`, `rollover`).
- **Modals/UI:** drill, individual/bulk ULB, new‑cost‑center, toast, expanded‑audit, ULB‑bug dismissed.

Data fetching (real build): scheduled ingest of GitHub billing (AI‑credit usage by model, metrics `ai_credits_used`, cost centers, budgets, included‑usage caps, licensing) into an append‑only snapshot store; a forecasting service (run‑rate + weekday seasonality → exhaustion date/metered $, P50/P90, backtest MAPE, the 1 Sep step‑change); a guardrailed rebalancer; a desired‑state sync engine that diffs and applies via the GitHub REST API (idempotent, dry‑run + rollback). All writes are API‑first (mandated by the API‑only levers + the ULB UI bug).

---

## Design tokens

**Palette note:** a dark, GitHub‑adjacent analytics theme. Type is **Mona Sans** (GitHub's open‑source variable font, weights 200–900, via CDN); numbers/code use a monospace stack (`ui-monospace, SFMono-Regular, Menlo, monospace`). The palette is Primer‑adjacent (open‑source). This is an **original admin tool** — reuse your codebase's design system / brand where one exists; the values below reproduce the prototype exactly.

Surfaces & lines
- Canvas `#0d1117` · Pure `#000000` (sidebar) · Surface `#151a22` (cards) · Surface‑2 `#24292f` · Surface‑3 `#2e374a`
- Borders: `#21262d`, `#30363d` (default), `#1c222b` (row dividers) · Hairline `#484f58`

Text
- Ink `#ffffff` (headings) · Default `#f0f6fc` · Muted `#9198a1` · Subtle `#a4aea6` · Neutral `#7c8980` (captions/axis)

Semantic accents (never color‑only — always icon+label)
- **Blue** `#8dd6ff` — pool phase, primary accent, links (link‑accent `#4493f8`)
- **Green** `#5fed83` (dark success `#08872b`, toggle `#238636`/`#2ea043`) — healthy / within budget / always‑hard‑stop
- **Amber** `#e3b341` (toggle `#9e6a03`/`#bb8009`) — approaching / alert‑only / hard‑stop‑off / metered phase
- **Red** `#ff7b72` — block / overrun / over cap
- **Violet** `#9350ff` (light `#c9a3ff`) — **API‑only** + structural accent
- Indigo `#5049c2`

Typography scale (px / weight)
- Screen title 19/500 · Card title 15/500 · Big metric 22–26/480–500 (tabular‑nums) · Body 13–14/400 · Sub/caption 11–12.5 · Eyebrow/label 10.5–12 uppercase, letter‑spacing .4–.6px · Mono 10.5–13 for numbers, diffs, code, badges

Radius · spacing · misc
- Radius: cards 16px · inner cards/panels 10–12px · inputs 6–8px · badges/pills 5–6px · toggle/segmented 60px / 9999px
- Section padding `24px 28px 64px`; card padding 18–22px; grid/flex gaps 12–18px; screen max‑widths 1080–1360px
- Sidebar 236px; top bar 60px (sticky); right rails sticky at `top:76px`
- Selection `rgba(141,214,255,.25)`; custom scrollbar thumb `#24292f`

---

## Assets

No raster images or external icons. All iconography is **Unicode glyphs / CSS shapes** (▲ ⚠ ✓ ✕ ⧗ ⇄ ⓘ ↪ ● ▸ ○, arrows) and inline SVG for charts. Only external asset: the **Mona Sans** web font (`@font-face`, jsDelivr CDN). Reproduce charts as SVG (or your charting lib); reproduce glyph icons with your codebase's icon set where possible, preserving the icon‑plus‑label pattern.

## Files

- `Copilot Budget Manager v2.dc.html` — the full prototype (template + logic class). **Primary reference** for exact markup, seed data, chart math, and behavior. Open alongside `support.js` in a browser to run it.
- `support.js` — the DC runtime that renders the prototype. A dependency for viewing only; **not** something to port.

> Tip: read the logic class in the `.dc.html` (methods like `poolData`, `ccPoolData`, `renderBurndown`, `renderEnvBar`, `abModel`, `familyRows`, `icLive`) for the exact forecast/envelope math and seed values behind each screen.
