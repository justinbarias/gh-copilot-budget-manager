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

## Historical cycles (usage-history.ts, Task 5.1)

Three closed monthly cycles precede the open June 2026 cycle above — March,
April, May 2026 — plus the per-user rows for five named personas. Every value
is generated by a **pure, seeded formula** (no `Math.random()`, no wall-clock)
from a small plan of target totals in `usage-history.ts`, so re-running the
suite always reproduces the same fixtures. This is **additive-only**: neither
array is exported into `USAGE_ITEMS`/`CREDITS_USED_ITEMS` — the MSW handlers
only surface them when a request explicitly asks (usage: `year`[`+month`
[`+day`]]; users-28-day: `since`/`until`), so every current-cycle pin above is
computed exactly as before and is untouched by this file's existence.

- **Enterprise/per-CC billing view** (`HISTORICAL_USAGE_ITEMS`): CC-aggregate
  daily rows (`user_login: null`), split across the six CCs in the SAME seat
  proportion as the live roster (24/16/8/9/11/13 of 81) — no crisis/amber skew
  applied historically; that's this cycle's story, not a standing pattern.
  Fully pool-covered every day (`discount_amount == gross_amount`,
  `net_amount == 0`) — no closed cycle ever exhausted its pool. Monthly
  enterprise-wide totals (Σ quantity, regression-pinned by
  `usage-history.test.ts`): **March 405,005 · April 429,004 · May 452,014** —
  all inside the 380k–470k "plausible, under the 567,000 pool" band, ramping
  gently toward June's day-13-annualised pace (189,800 / 13 × 30 ≈ 437,800).
- **Per-user metrics view** (`HISTORICAL_CREDITS_USED_ITEMS`): daily rows for
  emily-zhao, liam-obrien, faisal-noor, hannah-webb, noah-tanaka. The first
  four are anchored to their OWN June `CREDITS_USED_ITEMS` total ÷ 13 (their
  current day-13 daily pace: emily-zhao 5,480/13, liam-obrien 4,930/13,
  faisal-noor 4,180/13, hannah-webb 4,360/13 — the last two are pinned figures
  elsewhere in this doc/Task 5.1's brief), so the historical series reads as
  "the same person, earlier", not an arbitrary number. noah-tanaka has 0 MTD
  this cycle (only the Aug/Sep cliff rows touch his June-adjacent lifetime
  total), so his historical rate (300 credits/weekday baseline) is an
  independent, modest figure — narratively "active before, quiet this cycle,
  back for the cliff". Per-persona totals across all three closed cycles
  (regression-pinned): emily-zhao **25,147** · liam-obrien **22,609** ·
  faisal-noor **19,181** · hannah-webb **20,006** · noah-tanaka **17,890**.
- **Weekday seasonality:** every generated series uses `WEEKEND_RATIO = 0.3`
  (weekend day = 30% of a weekday's rate), giving an exact **weekday:weekend
  ratio of 1/0.3 ≈ 3.33×** for both the CC-level and per-persona series —
  comfortably clear of the >2× a trailing-7 weekday-index computation needs to
  recover the seasonal signal (spec §4.3).
- **Provisional/"not yet settled" latest day:** 2026-06-14 (`SIM_CURRENT_DATE`,
  day 13 of 30) is itself a **Sunday** — under this world's existing
  weekends-carry-no-billing-row convention (coherence eq. #2, above), it
  already has no USAGE_ITEMS row, so the burn-down's last point (189,800)
  already reflects "today's figure isn't in yet" without any new data or a
  changed total. No provisional-day fixture was added; this is the existing
  convention read through the settling-window lens (spec §4.3's "latest day
  treated as provisional").
- **Standard (post-cliff) allowance:** already modeled in
  `packages/core/src/poolAllowance.ts` (`STANDARD_PER_SEAT.enterprise = 3900`,
  promo window 1 Jun–1 Sep 2026 exclusive) — this task did not add a
  duplicate constant. **Flagging a spec-internal inconsistency, not silently
  resolved (CLAUDE.md's "spec wins, but flag conflicts"):** spec §1.1 states
  both "the pool shrinks ~37% on 1 Sep 2026" AND concrete Enterprise
  allowances of promo 7,000 / standard 3,900 per seat in the same sentence;
  7,000→3,900 is actually a **44.3%** drop, not ~37% (7,000→~4,410 would be
  37%). `poolAllowance.ts` (pre-existing, not touched here) uses the spec's
  explicit **3,900** figure, since a concrete stated number outranks a rounded
  rhetorical percentage — flagging for the maintainer to reconcile the prose.
- **Query-param filtering:** the usage handler's `year`/`month`/`day` and the
  users-28-day handler's `since`/`until` match real GitHub's documented
  enhanced-billing query parameters (`docs/api-surface-validation.md` R5/R6);
  no new response-wire field was introduced, only request-side filtering, so
  this stays within the already-validated response schema.

## Headline derived values (pinned by tests)

- `getUsageSummary()`: totalQuantity **193,036**, net **$25.34**
  (23.00 overflow + 2.34 cliff), licenseCount **81**, 14 burn points, final
  cumulative **189,800**.
- `listCostCenters()`: 6 CCs, member counts 24/16/8/9/11/13.
- `listHeavyUsers()`: 81 rows; top emily-zhao **5,480**; at-risk cohort of 7.
- Live controls: 16 budgets (11 + 5 controls-scale ULBs) + 6 caps; write-engine canonical target
  `budget:cost_center:Workforce Australia Platform` (60,000 credits, id
  `budget-cost-center-workforce-metered`).

## Scenario worlds (Task 6.7 — `scenarios.ts`)

The default `healthy` scenario IS the DEWR world above, byte-identical. The
three alternates reuse the same roster/cost-centers/budgets and differ only in
usage + as-of date (all at **2026-06-27, day 26/30**). Each alternate's MSW wire
is authored so the **assembled state agrees with the engine scalars** the
rebalancer proofs pin (`scenarios.engine.test.ts`) — the two must never tell
different stories (the Checkpoint-6 defect: At-risk's wire summed to 95,000
while its engine scalar said 511,150). `scenarios.coherence.test.ts` is the
regression guard.

**Wire↔engine coherence equation (per scenario):**
`assembled Σ(per-CC poolCreditsUsed) == POOL_SCENARIO_INPUTS.poolConsumedCredits`
— and that Σ (Σ `discount_amount` over the in-cycle CC-aggregate rows) IS the
Overview burn-down's cycle-to-date figure, so **burn-down == engine scalar**.

| Scenario | Burn-down (= Σ CC pool = scalar) | Per-CC pool draw (of cap) | Enterprise metered | Forecast (enterprise) |
|---|---|---|---|---|
| `healthy` | 189,800 | on-pace, all well under cap | 0 (June cycle) | runway ~15d, exhaustion 2026-06-29 |
| `at-risk` | **511,150** (90.1%) | wf 152k/168k · emp 100k/112k · dataEval 54k/63k · cyber 68k/77k · corp 82.15k/91k · **payments 55k/56k (cap-bound, →61k)** | 0 | runway **~3d**, exhaustion **2026-06-30** |
| `surplus` | **14,000** (2.5%) | wf 8.6k · cyber 5.4k (both far under cap) | 0 | no exhaustion (drastic under-consumption) |
| `metered` | 67,900 pool | dataEval 63k/63k (== cap, exhausted) · cyber 4.9k | **300,000** (dataEval 24.5k + employer 275k + sam-kelly 0.5k) | cliff exhaustion 2026-09-21 |

- **Daily rows through day 25 (Defect 2(a)):** every alternate's CC-aggregate
  billing rows are spread across the June weekdays (Jun 2 → Jun 26, `splitDaily`)
  so the persisted forecast's last-actual marker lands at **day 25** and runway
  is story-consistent — not the pre-fix single Jun-15 (day 14) row that stalled
  the marker at day 14 with a nonsensical ~87-day runway.
- **Member burns < CC-aggregate** (coherence eq. #3, above) holds in every
  alternate: the gap is shared/automated draw, maximal in `at-risk` where a 90%
  pool draw is dominated by non-attributable consumption. At-risk populates the
  Users screen with the named cohort (blocked/approaching/held) **plus** a
  21-seat "comfortable" cohort at 2,500 each (54% of the 4,600 universal ULB —
  never at-risk), so the world reads as a busy month, not 12 lonely rows.
- **Every non-Payments CC keeps utilisation < 95%** (the `AT_RISK_THRESHOLD_PCT`)
  so no extra CC/user enters the at-risk set — the engine proof's **17** stays 17.

**Persisted forecasts follow scenario switches (Defect 2(b)):** `setScenario`
(the `github-impl.ts` bridge) re-runs the same `syncNow` ingestion after
re-seeding, so the source-scoped-but-scenario-blind `getLatestForecast`/
`getLastSyncedControls` reads always match the active world (no new bridge
surface — the existing sync path is reused). The audit-provenance path stays
sensible: an apply after a switch references the new world's snapshot.
