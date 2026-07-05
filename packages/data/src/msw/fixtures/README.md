# The DEWR fixture world

The simulated GitHub Enterprise these fixtures model. Simulation mode is a
shipped product surface (CLAUDE.md §7) — this dataset is what admins explore,
train on, and demo, so it is authored as a believable organisation, not test
data. **One mock, three consumers:** these fixtures drive simulation mode,
Playwright e2e, and vitest identically. Every value is static and
hand-authored — no `Date.now()`, no randomness, keyed to `SIM_CURRENT_DATE`.

## The organisation

**DEWR** — Australia's Department of Employment and Workplace Relations
(enterprise slug `dewr`), a mid-size GitHub Enterprise Cloud customer and
existing GitHub customer, so the **promo allowance** applies:
**7,000 credits/seat** until 1 Sep 2026, then standard 3,900 (the cliff).

- **81 Copilot seats** → enterprise pool allowance **567,000 credits**.
- Simulated "now": **2026-06-14** (`SIM_CURRENT_DATE`) — day 13 of 30 in the
  June 2026 cycle; the Overview burn-down has 14 points (Jun 1 → Jun 14).
- Logins are name-derived Australian-public-service handles (`liam-obrien`,
  `rpatel2`, `d-okafor`); external contractors are prefixed `ext-`.

## Org chart — six cost centers

Every licensed seat is attributed to **exactly one** cost center, so the six
license-computed included-usage caps sum to the pool allowance exactly:

| `COST_CENTER_IDS` key | Name | DEWR mapping (division → branch → project) | Seats | Cap (×7,000) | MTD burn | Headroom | Story |
|---|---|---|---|---|---|---|---|
| `workforce` | Workforce Australia Platform | Employment Systems Group → Digital Delivery Branch → WFA-DIGITAL | 24 | 168,000 | 30,200 | 137,800 | Flagship delivery team; carries the CCULB, the display-bug ULB (liam-obrien) and the cliff persona (noah-tanaka) |
| `employer` | Employer & Provider Portals | Employment Systems Group → Employer Engagement Branch → PROVIDER-PORTAL | 16 | 112,000 | 18,900 | 93,100 | Steady; hosts the throttled contractor ext-pshah (1,900-credit individual ULB, at-risk) |
| `capBound` | Payments Integrity Engineering | Corporate & Enabling Services → Payments Technology Branch → PAYMENTS-ASSURANCE | 8 | 56,000 | **58,300** | **−2,300** | **The crisis:** cap exhausted, overflowing into metered (2,300 credits so far) |
| `dataEval` | Data & Evaluation Platform | Data, Analytics & Evaluation Group → Data Platforms Branch → EVAL-WAREHOUSE | 9 | 63,000 | 57,400 | **5,600 (amber)** | **The warning:** headroom under the 8,000 low-headroom threshold; heaviest per-user cohort; CCULB 6,000 + the one hard-stop-ON spending limit |
| `cyber` | Cyber & Identity Services | Digital & Technology Group → Cyber Security Branch → IDAM-UPLIFT | 11 | 77,000 | 15,000 | 62,000 | Light; hosts power user sam-kelly (5,400 individual ULB) |
| `corporate` | Corporate Systems | Corporate & Enabling Services → Enterprise Applications Branch → HR-FIN-SYSTEMS | 13 | 91,000 | 12,300 | 78,700 | Lightest; hosts the offboarded contractor ext-dmorrow ($0 ULB, blocked) |

Enterprise-team provenance (`via_ent_team` badges): `payments-eng` (liam-obrien,
sarah-huang), `assurance` (faisal-noor, grace-omalley), `eval-guild` (emily-zhao).

## Narrative at day 13

- Enterprise pool: **189,800 of 567,000 burned (33.5%)** — on-pace overall,
  but consumption is uneven across teams.
- **Payments Integrity Engineering is over its cap** and metering
  ($23.00 so far). Its members are all *within* their ULBs — the breach is
  shared/automated draw (code-review runs, CI Copilot, service accounts), so
  the remedy is the cap/overflow lever or license re-attribution, **never a
  ULB grant** (CLAUDE.md §5: cap-bound teams have no grantable pool delta).
- **Data & Evaluation Platform is amber** (5,600 headroom < 8,000): six heavy
  users led by emily-zhao (5,480, 91% of the 6,000 CCULB — "at risk").
- 7 users are at-risk (≥90% of effective ULB or $0-blocked); 30 are active;
  44 licensed seats have no usage this cycle (realistic adoption curve).

## Controls (budgets.ts)

Family A — ULBs, always hard-stop, most-specific wins
(individual > CCULB > universal):

- Universal: **$46 → 4,600 credits** (everyone's baseline).
- CCULBs (API-only): Workforce **5,200**; Data & Evaluation **6,000**.
- Individual overrides: liam-obrien **5,800** (the display-bug fixture),
  sam-kelly **5,400**, ext-pshah **1,900** (throttled contractor),
  ext-dmorrow **$0** (blocked).
- **Controls-scale fixtures** (5 more individual ULBs, 12 ULB rows total —
  enough to exercise the Controls screen's 10/page pagination): declan-ryan
  **2,500**, tegan-ellis **3,700** (both Employer & Provider Portals);
  jomo-mburu **2,900**, nina-popov **4,800** (both Cyber & Identity
  Services); devi-anand **3,300** (Corporate Systems). All five are
  zero-usage seats (no CREDITS_USED_ITEMS rows) in CCULB-free cost centers —
  previously universal-ULB-governed, never referenced by any other spec/data
  test. Non-interference (hand-verified): the no-usage filter count stays 44
  and at-risk stays 7 (0 MTD against a non-zero, non-near-zero cap is never
  at-risk); the universal-raise (4,600→5,100) and Employer CCULB-create
  dry-runs stay 0/0 (removing a zero-usage user from the governed population
  never moves who's blocked — the binding max is still hannah-webb's 4,360);
  none are among the 8 Payments Integrity Engineering members; Overview/
  Cost-Centers burn figures are untouched (ULBs don't affect burn). Amounts
  are distinct from every other ULB's so a cap sort never ties.

Family B — spending limits, metered-only, hard-stop OFF by default:

- Enterprise `dewr` **$8,000** (800,000 credits), alert-only.
- Organization `dewr-digital` **$3,200** (320,000), alert-only.
- Cost center Workforce **$600** (60,000), alert-only — the write engine's
  canonical PATCH target.
- Cost center Data & Evaluation **$250** (25,000), **hard-stop ON** — the one
  fixture that lets §6.3's "alert-only requires a logged override" transition
  be exercised end to end.

Baseline validation is unblocked: Σ cost-center limits (85,000) ≪ enterprise
cap (800,000).

## The four edge fixtures (re-skinned, keys stable)

1. **ULB display bug** (`BUDGET_IDS.ulbDisplayBug`): liam-obrien's $58
   individual ULB — present in the budgets API list, omitted by GitHub's
   native UI (spec §1.4). Phase-3 repair logic must find it via the API.
2. **$0 ULB** (`BUDGET_IDS.zeroUlb`): ext-dmorrow — hard-blocked in both
   phases; exercises the near-zero-ULB validation and the "✕ blocked · $0 ULB"
   rendering.
3. **Cap-bound CC** (`COST_CENTER_IDS.capBound`): Payments Integrity — full
   56,000 cap drawn from the pool (itemised, discount-covered) + 2,300 metered
   overflow (itemised, `net_amount` > 0).
4. **Allowance cliff**: noah-tanaka (Workforce) — 468 credits on 2026-08-31
   (fully pool-covered) and 468 on 2026-09-01 (half metered) — the promo →
   standard transition datapoints. Both fall outside the June cycle, so he
   reads 0 MTD today.

## Coherence equations (keep these true when editing values)

1. **Caps ↔ allowance:** Σ(CC members × 7,000) = 81 × 7,000 = 567,000. The MSW
   PATCH handler *recomputes* `computed_limit_credits` from
   `COST_CENTER_RESOURCES`, so a CC's fixture cap MUST equal members × 7,000.
2. **Burn-down ↔ USAGE_ITEMS:** enterprise pool burned =
   Σ `round(discount_amount × 100)` over June rows = **189,800**. Each CC's
   June pool draw is itemised as CC-aggregate rows (`user_login: null`) spread
   over weekdays (Jun 2, 4, 5, 9, 11, 12 — never Jun 1, so day 0 = 0; never
   weekends). The cap-bound CC's pool rows sum to its full 56,000 cap.
3. **CC MTD ↔ USAGE_ITEMS:** each `mtd_burn_credits` = Σ its June `quantity`
   rows (pool + metered). Billing (USAGE_ITEMS) and per-user metrics
   (CREDITS_USED_ITEMS) are different GitHub APIs; per-CC,
   Σ member burns < `mtd_burn_credits` — the gap is shared/automated draw the
   per-user report can't attribute (largest, by design, in the two crisis CCs).
4. **Per-user rows sum exactly:** every active user's CREDITS_USED_ITEMS rows
   sum to their intended cycle total, and the per-row `model` tags (2026
   lineup: GPT-5.1, Claude Sonnet 4.5, Claude Opus 4.5, Gemini 2.5 Pro,
   GPT-5 mini, plus untagged = unattributable) partition that same total.
5. **Cycle filtering:** Aug/Sep cliff rows are outside
   `cycleBounds(SIM_CURRENT_DATE)` — they contribute to lifetime aggregates
   (`asOfDate` = 2026-09-01, `totalQuantity` = 193,036) but never to MTD/burn-down.

## Headline derived values (pinned by tests)

- `getUsageSummary()`: totalQuantity **193,036**, net **$25.34**
  (23.00 overflow + 2.34 cliff), licenseCount **81**, 14 burn points, final
  cumulative **189,800**.
- `listCostCenters()`: 6 CCs, member counts 24/16/8/9/11/13.
- `listHeavyUsers()`: 81 rows; top emily-zhao **5,480**; at-risk cohort of 7.
- Live controls: 16 budgets (11 + 5 controls-scale ULBs) + 6 caps; write-engine canonical target
  `budget:cost_center:Workforce Australia Platform` (60,000 credits, id
  `budget-cost-center-workforce-metered`).
