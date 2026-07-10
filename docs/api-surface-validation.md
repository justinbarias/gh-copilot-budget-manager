# §6.9 API-surface validation note

**Purpose.** CLAUDE.md §6.9 requires every hand-wrapped GitHub API call (anything
not going through Octokit's *typed* methods — here, all of our
`octokit.request('<verb> <path>')` calls with our own request/response types) to
be validated against GitHub's actual API surface before it counts as verified.
This file is that record for every hand-wrapped endpoint in the codebase and its
MSW twin. Phases 5–9 add rows here as they add endpoints; Task 9.2 upgrades rows
to "confirmed against live" once a real tenant is reachable.

**Standing scope.** Every endpoint below is a 2026-dated enterprise
billing/budget path (`X-GitHub-Api-Version: 2026-03-10`) that is **not** in
Octokit's typed catalog, so §6.9 applies to all of them (none are Octokit-typed
and therefore none are exempt).

---

## What could and couldn't be externally confirmed (read this first)

- **Date checked:** 2026-07-05. **API version:** `2026-03-10`.
- **Good news since the plan was written:** GitHub's usage-based Copilot billing
  (GA June 2026) and the `2026-03-10` budgets/cost-centers REST endpoints are now
  **publicly documented**. The plan/PRD assumed these might still be undocumented;
  they are not. Sources actually reached (see "Sources" below): the `2026-03-10`
  **Budgets** and **Cost centers** REST reference pages on `docs.github.com`, the
  **Copilot budgets-for-usage-based-billing** concept page, and the **June–July
  2026 changelog** entries ("Cost centers now support included usage caps",
  "Per-user AI credit budgets available for cost centers", "Copilot moving to
  usage-based billing").
- **Confidence ceiling — important.** These pages were consulted via **automated
  page-summarization** (WebFetch's small-model reader), **not** by parsing the
  machine-readable OpenAPI description (`github/rest-api-description`), which §6.9
  names as the preferred source. The OpenAPI file was **not** directly parsed (it
  is ~100 MB; not practically fetchable here). The summarizer **demonstrably
  confabulates exact enum strings**: two independent reads of the *same* Budgets
  page disagreed on the multi-user-cost-center scope value (one returned
  `multi_user_customer`, the other `multi_user_cost_center`, one listed *both*).
  **Therefore:** exact enum strings, precise success-status codes, and exact
  response envelopes below carry **summarizer-grade** confidence and are flagged
  "pin at 9.2" (verify against the OpenAPI schema or a live 422/response). Only a
  few facts corroborated across ≥2 independent retrievals are graded
  "documented-confirmed".
- **Bottom line for the gate:** the MSW mutation contract (Tasks 4.1/4.2) is
  **internally consistent and passes its data-test gate (91/91)**. Several of its
  *wire shapes* are now known to diverge from real GitHub (detailed below). Those
  divergences are **documented here and deferred to Task 9.2's live
  reconciliation**, which is the plan's designated point for MSW-vs-reality shape
  fixes ("reconcile any response-shape/pagination drift … fix fixtures/types").
  They are **not** silently corrected now — see the ruling on inference #2 for why
  a speculative rename would make MSW *less* truthful, not more.

**Verdict legend.**
| Verdict | Meaning |
|---|---|
| `documented-confirmed` | Corroborated across ≥2 independent retrievals; safe to rely on. |
| `docs-indicated (summarizer)` | Single-source page-summary; plausible but unverified exact string/shape — **pin at 9.2**. |
| `live-confirmed` | Proven against a real authenticated tenant (2026-07-08 live smoke) **and** pinned against docs.github.com `enterprise-cloud@latest` `apiVersion=2026-03-10`. |
| `machine-verified (OpenAPI)` | Quoted from GitHub's published OpenAPI description — `github/rest-api-description`, file `descriptions/ghec/ghec.2026-03-10.json` (the ~12MB calendar-versioned per-file spec; the earlier "OpenAPI too big to parse" note referred to the undated bundle and is SUPERSEDED — this file is the go-to §6.9 source from now on). Equal-strongest grade alongside `live-confirmed`. |
| `docs-confirmed, unadopted` | Endpoint confirmed real against the docs but deliberately **not** integrated — recorded so a later phase can adopt it without re-research. |
| `simulation-enrichment` | Deliberate MSW-only shape the task requires; known to diverge from live — **reconcile in github-impl at 9.2**, do not "correct" in MSW. |
| `PRD-authority` | Real docs inconclusive/contradictory; MSW follows the PRD (standing authority) — **pin at 9.2**. |

---

## Endpoint validation table

### Reads (pre-existing, hand-wrapped in `github-impl.ts`; MSW twins in `handlers.ts`)

| # | Method + path | Consumer | Doc source | Verdict | Deviation / note |
|---|---|---|---|---|---|
| R1 | `GET /enterprises/{enterprise}/copilot/billing/seats` | `github-impl` seats | Copilot seat-management REST (established) | `documented-confirmed` (path) | Response `{total_seats, seats[]}` + Link paging — conventional; pin exact fields at 9.2. |
| R2 | `GET /enterprises/{enterprise}/settings/billing/cost-centers` | `github-impl` cost centers (cap fields via `api-client/cost-center-cap.ts`) | Cost centers REST `2026-03-10` + 2026-07-08 live crash evidence | `live-confirmed` (flat cap dialect confirmed; **two mapped-field assumptions pending pin**, see A-rows) | **Live-proven 2026-07-08 (as crashes):** real GHEC cost centers carry the flat `ai_credit_pool_enabled` + `ai_credit_pool_state{target_amount,current_amount}` dialect and **no** `included_usage_cap` — reading `.included_usage_cap.enabled` off them was the live `TypeError` that crashed `getControls`/`syncNow`/`listCostCenters`. Fixed at the PARSE layer per inference #2's standing ruling: the ONE shared, total (never-throwing) mapper `normalizeIncludedUsageCap` (`cost-center-cap.ts`) is applied at BOTH fetch boundaries (`github-impl.ts` `fetchCostCentersRaw` + `write/live-state.ts` `fetchLiveControls`), folding both dialects into the internal shape — the internal model, MSW, core, and UI are unchanged (sim byte-identical: the internal-shape passthrough is exact). Two mapped fields ride **flagged assumptions** (rows A1/A2 below); the smoke's R2 row now dumps the first cost-center's full key list, `ai_credit_pool_enabled` + the entire `ai_credit_pool_state` verbatim, and every overflow-suggestive key — **that dump is the pin for both assumptions** on the next live run. Note: live cost centers also lack the sim-only DEWR-mapping/`mtd_burn` enrichments — a **display gap** on the Cost Centers screen against live (blank mapping columns, zero-burn until ingest fills it), pre-existing and non-crashing, reconciled when the live read path grows its own burn join. |
| R3 | `GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}` (get-one; members embedded) | `github-impl` members | Cost centers REST `2026-03-10` + 2026-07-08 live smoke | `live-confirmed` | **The old `GET …/{id}/resource` path DOES NOT EXIST** (live `404`, 2026-07-08; the docs' full endpoint list has `/resource` as POST/DELETE only — mutations, already modeled by M8/M9). Members/resources are **embedded** as `resources: [{type, name}]` on the cost-center objects returned by list/get-one/create/patch. `github-impl`/`live-state` now read `resources` off the already-fetched objects (net code deletion); the smoke's R3 row exercises get-one and structurally checks the embedded `resources[]`. |
| R4 | `GET /enterprises/{enterprise}/settings/billing/budgets` | `github-impl` budgets (scopes via `api-client/budget-scope.ts`) | Budgets REST `2026-03-10` + OpenAPI `ghec.2026-03-10.json` | `machine-verified (OpenAPI)` (scope model) / pagination **shape-closed, code-pending** | **Scope model reconciled 2026-07-08 (a REAL live read bug fixed):** live budgets return the wire spellings (`multi_user_customer` = universal ULB, `user` + `user` login field = individual, `multi_user_cost_center` = CCULB), and the old read path classified by our internal spellings — live Controls misfiled ULBs (wrong family/precedence; e.g. a $46 `multi_user_customer` budget now correctly reads universal/4,600 credits and a $58 `user`/liam-obrien budget individual/5,800). The shared mapper `budget-scope.ts` translates wire↔internal at both read boundaries (`fetchBudgetsRaw` + `fetchLiveControls`) and serializes creates (internal `individual` → scope `user` + `user` field). **`repository`-scoped budgets are known-unsupported:** they (and any future enum value) have no internal home and are SKIPPED from Controls — never silently: both boundaries emit a main-process `console.warn` naming the skipped scopes (`warnSkippedBudgetScopes`, validator hardening). A transitional read-tolerance also accepts the internal spellings (mock-cutover safety; real GitHub never sends them) — **remove after one full-green live cycle**. **Pagination:** shape machine-verified (in-body `{budgets[], total_count, has_next_page}`), but the CODE still reads Link-header style — single-page tenants (the maintainer's 10 budgets) are unaffected; multi-page reconciliation stays a 9.2 item. |
| R5 | `GET /enterprises/{enterprise}/settings/billing/usage` (`?year/month/day/cost_center_id`) | `github-impl` usage (via `api-client/usage-fetch.ts`) | Billing usage REST `2026-03-10` + 2026-07-08 live smoke | `live-confirmed` | **Items are camelCase** — `{date, product, sku, quantity, unitType, pricePerUnit, grossAmount, discountAmount, netAmount, organizationName, repositoryName?}`. Our old snake_case parse (`net_amount`/`discount_amount`) was why the live smoke reported `SHAPE_MISMATCH` (reading them live yields `NaN` through every money rollup). **No `user_login` and no `cost_center_id` on items** — both were our invention; per-user attribution moved to R6, per-cost-center attribution to the `cost_center_id` query param. **Default call EXCLUDES cost-center-attributed usage** (docs verbatim: "By default this endpoint will return usage that does not have a cost center"), so the correct enterprise-wide read is a **fan-out**: 1 default (unassociated) call + 1 call per known cost-center id, attributing items by WHICH query returned them (`usage-fetch.ts` `fetchUsageFanout`). MSW keeps `user_login`/`cost_center_id` as fixture-internal keys only (used to implement the query filtering) and projects both out of every emitted response; its `unitType: 'Unit'` and `organizationName: 'dewr-digital'` are **placeholder values** (docs pin the fields' existence, not their values — `pricePerUnit: 0.01` is exact per CLAUDE.md §5); pin real values on a live run. |
| R6 | 28-day: `GET …/copilot/metrics/reports/users-28-day/latest`; 1-day: `GET …/users-1-day?day=YYYY-MM-DD` (both **documented forms live-confirmed working**; path-param variants `…/users-28-day/{day}` / `…/users-1-day/{day}` **live-404'd** — retained only as fallback insurance, see note) | `github-impl` credits-used (via `api-client/users-report.ts`) | Copilot metrics-reports REST + 2026-07-08 live smokes (four authed runs) | `live-confirmed` (routes, envelope, **and file format — pin CLOSED: JSONL**) | First authed smoke: our `404` was the missing `/latest` suffix. Second authed smoke: a `400` `"Invalid day parameter…"` briefly suggested the tenant's router bound `latest` as a `{day}` path param — **that diagnosis was WRONG** (see the corrected live-contact history): the third + fourth smokes' four-variant probes, twice identical, returned `28d/latest=OK; 28d/{day}=404; 1d?day==OK; 1d/{day}=404` — **the tenant (github.com GHEC, confirmed) is DOCS-FAITHFUL**; the `400` was the old probe sending `day=<today>` for a not-yet-generated report, mislabeled under the `/latest` row. **Variant-fallback design, retained as insurance** (`users-report.ts` — inert on this tenant, guards a future GHE.com deployment): documented form first; **only an HTTP 400/404 on it** triggers the path-param retry (any other status propagates unmasked); both-fail throws the second error; winning variant memoised per Octokit instance (WeakMap — client rebuild = clean memo); `fetchUserCreditsForDays` resolves the variant on the first day sequentially (one failed probe max per fan-out). Response is the async report **envelope** `{download_links: string[], report_start_day, report_end_day}`; per-user records live in the file behind the link (see R7) — **format LIVE-PINNED: JSONL, record keys exactly `[user_id, user_login, ai_credits_used]`** (1,111 records on the maintainer's tenant). **Cycle-accuracy ruling (money-affecting):** the 28-day report is a TRAILING aggregate crossing the cycle boundary, so it is never the cycle-total source; cycle-accurate per-user totals come from users-1-day fanned out over elapsed cycle days (Sync-only), with a **≤2-day trailing-gap tolerance** (see Live-wire limitations). The smoke's R6 row remains the four-variant probe (raw `octokit.request`, bypassing the memo) reporting per-variant status + format + first-record keys; `ok` iff ≥1 variant per report family works and the download-link follow succeeds. |
| R7 | `GET <download_links[0]>` (opaque signed URL, plain `fetch`, non-Octokit) | `users-report.ts` `downloadReportRecords` (used by `fetchUsersReport` + the smoke's four-variant probe) | GitHub docs describe the link as a short-lived signed URL + 2026-07-08 live smokes (third/fourth runs) | `live-confirmed` — **format pin CLOSED: JSONL** | **Hand-wrapped HTTP call (§6.9):** the only non-Octokit request in the codebase — a bare `fetch` following the R6 envelope's first download link. **File format LIVE-PINNED (2026-07-08, two identical runs): JSONL** — one JSON object per line, first-record keys exactly `[user_id, user_login, ai_credits_used]`. `parseUsersReportFile`'s defensive sniff (leading `[` → JSON array, `{` → JSONL, else CSV-with-header) classifies it correctly and is retained as-is; the MSW twin (`msw/handlers.ts` `jsonlResponse`) is **realigned to emit the same JSONL** (one object/line, no trailing newline, `Content-Type: text/plain` — deliberately not `application/json`, so nothing can start trusting a header the live host may not send; empty day = empty body → sniffed `'empty'`). The mock's download *filenames* still end `.json` while carrying JSONL — intentional (the impl sniffs content, never filename/header; the live signed URLs' filenames are opaque anyway). **Call volume:** each users-1-day day costs an envelope request + a file download; `syncNow` fans out over elapsed cycle days (~15 at the June-14 anchor) **plus a 92-day prior-3-closed-cycle backfill** (2026-03-01..2026-05-31, from the clock seam) for per-user forecast history — ~214 HTTP requests per Sync, chunked at `USERS_REPORT_CONCURRENCY = 10` in-flight (`users-report.ts`) to stay under secondary rate limits; acceptable because Sync is an explicit job (CLAUDE.md §2), tune the knob if live rate-limiting bites. |

### Assumptions pending live pin (cap mapping — `cost-center-cap.ts`)

| # | Assumption | Basis | Risk if wrong | Pin mechanism |
|---|---|---|---|---|
| A1 | ~~USD-dollars assumption~~ **CLOSED 2026-07-08 — machine-verified:** the OpenAPI schema states `ai_credit_pool_state.target_amount`/`current_amount` are **"in dollars" (verbatim)**. The `round(USD × 100)` mapping in `cost-center-cap.ts` is confirmed correct. | OpenAPI `ghec.2026-03-10.json` | (was: limits 100× off) — risk retired. | Closed by the OpenAPI pass; the R2 dump remains useful only as a live sanity echo. |
| A2 | ~~Overflow-field sniff + `'block'` default~~ **CLOSED 2026-07-09 — NEGATIVE, doubly confirmed:** the OpenAPI schema has **no overflow/block-vs-metered field anywhere** (exhaustive machine search) AND the maintainer's live R2 dump showed the real cost-center object carries only `[id, name, state, ai_credit_pool_enabled, azure_subscription, resources]` — no `ai_credit_pool_state` on their (cap-disabled) CC, **zero overflow-suggestive keys**. Block-vs-metered at pool exhaustion is governed by the **enterprise-level "AI credit paid usage" policy** (docs verbatim: *"If this policy is disabled, usage is blocked when the shared pool is exhausted, regardless of your budget configuration"*), which itself has **NO REST surface at all** (exhaustive schema + docs search) — a UI-only toggle. | OpenAPI `ghec.2026-03-10.json` + live R2 dump (2026-07-09) + docs | Risk retired: the mapper's `'block'` default + literal-value sniff stay as written (the sniff can never fire on the real wire; harmless). | **Maintainer decision:** the internal per-CC `overflow` knob is a **SIM-ONLY what-if lever** (rebalancer scenarios) — live-disabled in the Controls caps grid with the sub-line "Governed by the enterprise \"AI credit paid usage\" policy"; never serialized to the wire. The app can only be *told* the policy's state or *infer* it (metered charges posting ⇒ ON — proven for this tenant by the live $1,034.96 AI-credit net). **Task 7.2's paid-usage card should become admin-declared-or-inferred state, not an API read.** |

### Cap WRITES — W1 CLOSED (2026-07-09)

| # | Method + path | Verdict | Note |
|---|---|---|---|
| W1 | `PATCH /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}` (cap toggle) | **CLOSED — `machine-verified (OpenAPI)` write body** | `write/engine.ts`'s `executeCapMutation` now sends **exactly `{ai_credit_pool_enabled: <boolean>}`** — the flat, machine-verified wire field. MSW's PATCH allow-list **rejects** the old nested internal shape, any `overflow` key, and non-boolean values, all with `400` (the same loud drift-guard pattern as the budget-scope 422s; all three rejections test-pinned). **Overflow-only change entries issue ZERO wire mutations** and produce one audit event (validator-ratified below). **Known dialect inconsistency, flagged:** the cost-center **CREATE** body still accepts the internal nested cap shape in MSW — the create body's cap field wasn't in any live dump yet; pin on a future smoke. |

**Validator ratifications (2026-07-09 round):**

- **Persist-raw (snapshots keep the whole bill): RATIFIED.** `syncNow` persists
  the RAW, unfiltered usage item set — every product/sku exactly as the wire
  returned it, each row's identity recoverable via the `sku` column — while
  the AI-credit filter applies at the three DERIVATION boundaries only
  (`getUsageSummary`, `computeSyncForecasts`, `assembleUsageState`'s rollup).
  Money math is clean; future chargeback/audit phases keep the full,
  append-only billing picture. **Growth note:** on live tenants every Sync now
  persists whole-bill rows (licenses, premium requests, and any other
  enhanced-billing product) — snapshot growth tracks the tenant's full bill,
  not just AI credits; revisit retention if it ever matters.
- **Audit-without-mutation for overflow-only entries: RATIFIED**, with the
  record spread across three mutually-reinforcing surfaces: (1) the audit
  event carries actor / action / before→after (including the internal
  overflow change) / trigger / data-snapshot — §6.5-complete; (2) the
  per-entry **mutation log is empty** — the zero-wire-requests fact, asserted
  in e2e (the plan rail renders no request body and no PATCH for the entry);
  (3) the lever is **live-disabled in the UI**, so overflow-only entries are
  effectively sim-only, where the persistent banner already marks every apply
  simulated (§6.8). Honest caveat: the audit event *body* alone does not say
  "zero wire requests" — the mutation log is that record.

### Recorded, not adopted (docs-confirmed alternates)

| # | Method + path | Doc source | Verdict | Note |
|---|---|---|---|---|
| N1 | `GET /enterprises/{enterprise}/settings/billing/ai_credit/usage` (+ siblings `…/premium_request/usage`, `…/usage/summary`) | Billing usage REST `2026-03-10` (docs, 2026-07-08) | `docs-confirmed, unadopted` | **Resolves old checklist item #7 — the PRD §2.3 paths are real.** Per-call filters: `user`, `organization`, `model`, `product`, `cost_center_id`. Response: `{timePeriod, enterprise, user, organization, product, model, costCenter, usageItems[]}` with items `{product, sku, model, unitType, pricePerUnit, grossQuantity, grossAmount, discountQuantity, discountAmount, netQuantity, netAmount}` — note **no per-item date**; the top-level `timePeriod` carries year/month/day. Deliberately NOT integrated in the R5 reconciliation; recorded so Phase 4+ can reach for the `user`/`model` filters when per-user/per-model drill-down is needed — in particular the `user` filter is the **recovery path for the per-user pool-vs-metered split limitation** (see "Live-wire limitations" below). |
| N2 | `GET /enterprises/{enterprise}/settings/billing/budgets/{budget_id}/user-states` | OpenAPI `ghec.2026-03-10.json` (2026-07-09 research pass) | `machine-verified, unadopted` | **Per-user budget state for a given budget** — a machine-verified endpoint we had no inventory row for. **Candidate recovery path for per-user visibility** (blocked-user detection, per-user headroom), possibly BETTER than N1's `user` filter: it reads a budget's own user-state list directly instead of re-aggregating usage. Evaluate N1-vs-N2 when the per-user metered-split/block-status work is scheduled. |
| N3 | `GET /enterprises/{enterprise}/settings/billing/reports` + `…/reports/{report_id}` | OpenAPI `ghec.2026-03-10.json` (2026-07-09 research pass) | `machine-verified, unadopted` | Enterprise billing report generation/retrieval — likely the bulk/export sibling of the usage endpoints. Relevant to Phase 8 (chargeback + audit export); recorded for that round. |
| N4 | `GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-1-day` + `…/enterprise-28-day/latest` | OpenAPI `ghec.2026-03-10.json` (2026-07-09 research pass) | `machine-verified, unadopted` | Enterprise-AGGREGATE siblings of the per-user R6 reports (same envelope pattern). A cheap cross-check for the enterprise burn series without the per-user fan-out; unadopted while R5 (billing usage) serves that role. |

**Pricing-model enum (machine-verified, 2026-07-09 research pass).** Budgets
carry a `budget_type` pricing-model enum: **`BundlePricing`** covers AI-credit
SKUs via `budget_product_sku: 'ai_credits'`; **`ProductPricing`** targets a
product (e.g. `actions`); **`SkuPricing`** targets a single SKU (e.g.
`actions_linux`). This **confirms our budget fixtures'
`budget_product_sku: 'ai_credits'` stays correct as-is** — note the budget
API's product-sku identifier space (`ai_credits`) is distinct from the usage
report's display-sku space (`"Copilot AI Credits"`); do not conflate them.

### Mutations (new — Tasks 4.1/4.2; MSW-only today, consumed by the write engine in Task 4.8)

| # | Method + path | Task | Doc source | Verdict | Deviation / note |
|---|---|---|---|---|---|
| M1 | `POST /enterprises/{enterprise}/settings/billing/budgets` | 4.1 create | OpenAPI `ghec.2026-03-10.json` (2026-07-08 pass) | `machine-verified (OpenAPI)` | **Reconciled 2026-07-08 (write-shape round):** returns **`200 {message, budget}`** (both required; status list 200/400/401/403/404/422/500 — **201 does not exist**) — MSW now emits exactly this, and the write engine parses it. **Scope enum machine-verified (7 values):** `enterprise, organization, repository, cost_center, multi_user_customer, multi_user_cost_center, user`; the `user` scope carries a separate required `user: <login>` field. MSW **rejects** the internal `universal`/`individual` spellings with `422` — a deliberate **drift-guard** that loudly surfaces any impl callsite still serializing the internal model onto the wire. `budget_amount` machine-verified `type: integer` "in whole dollars" (MSW validates integer-only). |
| M2 | `GET /enterprises/{enterprise}/settings/billing/budgets/{budget_id}` | 4.1 read-one | Budgets REST `2026-03-10` | `documented-confirmed` (path) | MSW returns the flat budget object; real by-id shape pinned at 9.2. |
| M3 | `PATCH …/budgets/{budget_id}` | 4.1 update | OpenAPI `ghec.2026-03-10.json` | `machine-verified (OpenAPI)` | **Reconciled:** `200 {message, budget}` (budget may carry `consumed_amount` for user-scoped budgets) — MSW emits it, engine parses it. PATCH bodies carry no scope (create is the only scope-serialization site). Patchable fields confirmed; MSW's allow-list is a strict subset (safe). |
| M4 | `DELETE …/budgets/{budget_id}` | 4.1 delete | OpenAPI `ghec.2026-03-10.json` | `machine-verified (OpenAPI)` | **Reconciled:** `200 {message, id}` (id = the deleted budget id; **no 204 in the status list**) — MSW emits it, engine parses it. |
| M5 | `POST /enterprises/{enterprise}/settings/billing/cost-centers` | 4.2 create | Cost centers REST `2026-03-10` + OpenAPI | `docs-indicated (summarizer)` (envelope) | Path confirmed; cap field is `ai_credit_pool_enabled` (inference #2, live-proven). Create-response echo of `resources` remains a `simulation-enrichment` (inference #7). Error statuses now machine-verified: cc mutations list **400, never 422** (MSW realigned). |
| M6 | `DELETE …/cost-centers/{id}` | 4.2 delete | Cost centers REST `2026-03-10` | `documented-confirmed` (path) | Path confirmed; MSW `204`. |
| M7 | `PATCH …/cost-centers/{id}` | 4.2 edit / cap toggle | Cost centers REST `2026-03-10` + OpenAPI | `documented-confirmed` (route) / **cap-toggle body still `known-divergent` (W1)** | Route confirmed. The cap-toggle PATCH body remains unreconciled — the OpenAPI pass **confirmed no overflow field exists anywhere in the schema** (A2 narrowed: exhaustive search over overflow/exhaustion/paid_usage/"block"/"metered" — zero hits), so the write body still cannot be built faithfully; cap writes stay out of scope (W1, blocked on the live R2 dump; if that also shows nothing, the per-CC `overflow` knob may not exist on the real API — a PRD-level modeling question, not resolvable unilaterally). |
| M8 | `POST …/cost-centers/{id}/resource` | 4.2 add members | OpenAPI `ghec.2026-03-10.json` | `machine-verified (OpenAPI)` (+ flagged sim enrichment) | **Reconciled:** request body is the four optional string arrays `{users, organizations, repositories, enterprise_teams}` (`minProperties: 1`) — the engine now sends it, MSW accepts ONLY it (the old `{resources:[{type,name}]}` shape → `400`, loudly). Response `200 {message, reassigned_resources: [{resource_type, name, previous_cost_center}] | null}` — MSW populates `reassigned_resources` only on genuine cross-CC fixture moves, `null` otherwise. Task 4.2's recomputed-limit observability rides ALONGSIDE the real keys as **`simulated_included_usage_cap`** (validator-ratified: unmistakably sim-scoped name, `simulatedUiHidden` precedent; the engine records response bodies verbatim and never parses it, so live behaviour is unaffected — a live response simply lacks the key). |
| M9 | `DELETE …/cost-centers/{id}/resource` | 4.2 remove members | OpenAPI `ghec.2026-03-10.json` | `machine-verified (OpenAPI)` (+ flagged sim enrichment) | **Reconciled:** same four-array request body (DELETE-with-body valid); response **`200 {message}` only — NO `reassigned_resources` on remove**. Same `simulated_included_usage_cap` enrichment rationale as M8. |

**Error envelopes (machine-verified 2026-07-08).** Budgets POST/PATCH list
**`422`** → the shared `validation-error` schema `{message, documentation_url,
errors?: [{resource?, field?, message?, code (required), index?, value?}]}` —
matches MSW's shape (inference #6 CLOSED). Cost-center mutations (incl.
`/resource`) list **400/403/404/409/500/503 — no 422**: validation failures
there surface as **`400`**, and MSW's cc-mutation statuses were realigned
accordingly (422 → 400).

### Auth surface (new — Task 9.1 `validatePat`)

| # | Method + path | Consumer | Doc source | Verdict | Deviation / note |
|---|---|---|---|---|---|
| A1 | `GET /rate_limit` (read `X-OAuth-Scopes` response header) | `github-impl` `validatePat` | GitHub REST auth docs: "OAuth/classic tokens return the `X-OAuth-Scopes` header on authenticated requests"; `/rate_limit` "does not count against your rate limit" | `docs-indicated (summarizer)` | **Hand-wrapped header interpretation (§6.9).** `validatePat` classifies the stored PAT by presence/absence of the `X-OAuth-Scopes` response header: **present → classic PAT** (scopes = the comma-split list; `hasManageBillingEnterprise` = list includes `manage_billing:enterprise`); **absent → fine-grained** (`github_pat_` tokens don't carry it); **`401` → invalid**. `/rate_limit` is the probe because the docs state it does not consume rate-limit budget and it returns the scopes header for classic tokens. The MSW `/rate_limit` twin (`handlers.ts`) reproduces this branching deterministically off the bearer token. **Pin at 9.2:** confirm against a live classic PAT that (a) `X-OAuth-Scopes` is actually returned on `/rate_limit`, (b) fine-grained tokens omit it, and (c) the exact scope string is `manage_billing:enterprise`. The scope *string* the enterprise billing endpoints require is CLAUDE.md §4's standing fact; the header *mechanism* is the summarizer-grade part.

### Read smoke runner (new — Task 9.2-prep)

`packages/data/src/smoke/read-smoke.ts` (`runReadSmoke`) issues one read against
each of the §6.9 read rows **R1–R6** above (it is the shape-reconciliation
harness the 9.2 checklist is executed *through*) and structurally checks each
response against the shapes `github-impl.ts` parses. Post-reconciliation, the
R3 row exercises cost-center get-one + the embedded `resources[]`; the R5 row
checks camelCase fields on the default call **and** the first cost-center
fan-out call; the R6 row checks the report envelope, follows the download link
(R7), probes `users-1-day?day=<elapsed cycle day>`, and **reports the file's
real format + first-record keys** — the format pin the R7 row awaits. It is
refused in simulation mode at the `ApiClient.runLiveReadSmoke()` bridge (never
contacts GitHub); its per-endpoint `{status, details}` report is the concrete
Task 9.2 work order. The endpoint list lives in one place
(`INDEPENDENT_ENDPOINTS` + the dependent reads) with the `docRef` on each row
pointing back at this table.

**First live-contact finding (2026-07-08 smoke, unauthenticated).** The
maintainer's first real live read smoke returned **`401 "Requires
authentication"` on every read (R1–R6)** — a wiring bug, not a shape
divergence: `apps/desktop/src/main/ipc.ts` built the routed-to `ApiClient`
**without `auth`**, so its Octokit issued unauthenticated requests (only
`validatePat`'s dedicated probe ever read the live PAT). Fixed by wiring the
stored PAT + tenant pointer into the client and rebuilding on
credential/tenant change (proven on the wire by
`packages/data/src/api-client/auth-header.test.ts`).

**First AUTHENTICATED live smoke (2026-07-08) — the R3/R5/R6 reconciliation.**
The authed re-run returned: R1 OK (50 seats) · R2 OK (6 cost centers) · **R3
`404`** (the `GET …/resource` path does not exist) · R4 OK (10 budgets) ·
**R5 `SHAPE_MISMATCH`** (15 items, first item missing `net_amount`/
`discount_amount` — because the real fields are camelCase) · **R6 `404`** (the
bare `users-28-day` path lacks `/latest`). All three divergences were pinned
against docs.github.com `enterprise-cloud@latest` `apiVersion=2026-03-10` and
reconciled in one pass (this doc's R3/R5/R6 rows, upgraded to
`live-confirmed`, carry the corrected shapes; the wire contract that drove the
fix is `wire-contract-r3-r5-r6.md`, scratchpad-only). The rewritten smoke rows
now exercise the corrected surfaces — R3 via get-one + embedded `resources[]`,
R5 via camelCase field checks on the default + first-CC fan-out calls, R6 via
the envelope + download-link follow (whose output pins the file format, R7).

**Second AUTHENTICATED live smoke (2026-07-08, post-reconciliation) — the R6
`400`.** The maintainer's re-run after the reconciliation landed: **R1–R5 all
OK** — including R5's fan-out live-proven (default call: 15
cost-center-*unassociated* items; per-CC call: 13 items) — but **R6 `400`'d**
with `"Invalid day parameter… Expected format: YYYY-MM-DD"`. This prompted the
variant-fallback + per-client memo in `users-report.ts` and the smoke's
four-variant R6 probe, under a working diagnosis that the tenant's router
bound the literal `latest` segment as a `{day}` path parameter. **That
diagnosis was WRONG — corrected below.**

**Third + fourth AUTHENTICATED live smokes (2026-07-08, four-variant probe;
two identical runs) — CORRECTION: the tenant is DOCS-FAITHFUL.** Both runs:
`28d/latest=OK; 28d/{2026-07-07}=404; 1d?day=2026-07-07=OK;
1d/{2026-07-07}=404; format=jsonl, first-record keys=[user_id, user_login,
ai_credits_used] (1,111 records, via 28d/latest)`. So: **the documented
routes (`/latest`, `?day=`) work; the path-param variants do NOT exist
(`404`)** — the earlier "router binds `latest` as `{day}`" reading (recorded
in a previous revision of this doc and of the R6 row) is retracted. The
second smoke's `400` was a **probe-day artifact**: the then-current probe
sent `day=<today>` for a report GitHub had not yet generated, and the failure
was mislabeled under the `/latest` row. **Tenant type is now answered:
github.com (GHEC), confirmed 2026-07-08** — closing that open item; there is
no docs-vs-deployment divergence to explain. Consequences, per maintainer
decisions: (a) the **variant fallback is RETAINED as insurance** — on this
(docs-faithful) tenant it is inert (the documented form succeeds first, the
path forms are never tried), and it costs nothing while guarding against a
future GHE.com data-residency deployment; (b) **the report-file format pin is
CLOSED: JSONL**, one object per line, record keys exactly `[user_id,
user_login, ai_credits_used]` (1,111 records on this tenant) — the MSW
report-file twins now emit the same JSONL (empty day = empty body; the mock's
download *filenames* still end `.json` while carrying JSONL — intentional,
the impl sniffs content, never the filename or Content-Type); (c) a Sync run
before GitHub generates the current day's report must not hard-fail — see
the trailing-gap tolerance below.

### Live-wire limitations (documented, not deferred)

- **Per-user pool-vs-metered split is NOT derivable from the real wire.** The
  R6 metrics reports give one `ai_credits_used` TOTAL per user per day (no
  pool/metered breakdown), and the R5 billing usage report carries no
  `user_login` — so `assembleUsageState` (live-state.ts) derives every user's
  `meteredCreditsUsed` as `0` and `poolCreditsUsed` as the full cycle total.
  Totals (what ULBs bind on — CLAUDE.md §5's cross-phase ULB semantics) are
  exact; only the per-user split collapsed. **Blast radius:**
  `packages/core/src/simulate.ts`'s `resolveUserBlockStatus` gates its
  per-user *spending-limit* candidates behind `meteredCreditsUsed > 0`, so on
  live-derived state that branch never fires from ingested data (engine tests
  and the rebalancer still exercise it via curated `projectedUsage`/scenario
  entities, which set per-user metered directly — all pins remain green).
  **Recovery path:** the recorded-not-adopted N1 endpoint
  (`ai_credit/usage?user=`) can attribute metered spend per user when a later
  phase needs the real split.
- **`usage_fact.user_id` now persists `NULL` for live-ingested rows** (R5
  items carry no user). The Drizzle column was already nullable
  (`db/schema.ts` — no `.notNull()`), so no schema/migration change; per-user
  facts continue to flow through `credits_used_fact` (R6) instead.
- **Trailing-gap tolerance (maintainer decision, 2026-07-08).** Live, a Sync
  run before GitHub has generated the current day's users-1-day report gets a
  report-not-yet-available failure on it — one missing trailing day must not
  fail the whole Sync. `fetchCycleUserCredits` (`users-report.ts`) therefore
  tolerates **at most 2 consecutive trailing** 400/404s, strictly at the end
  of the cycle window: the head of the window is fetched hard (any failure
  there is a mid-window hole that would silently undercount money-affecting
  per-user totals — hard error), a failed tail day followed by a successful
  one throws (same hole logic), any non-400/404 anywhere throws, and the
  historical backfill gets NO tolerance (deep-past reports must exist). The
  coverage edge is surfaced honestly via the **maintainer-approved optional
  `SyncStatus.perUserDataThroughDay`** (the ONLY sanctioned `ApiClient`
  interface extension): process-lifetime, set only after a successful ingest,
  absent before the first sync of a process (a restart reports "unknown", not
  a guess); the Settings screen appends "— per-user data through <date>" to
  its sync-status line when present. In simulation the mock serves the as-of
  day, so no gap ever fires and the field always equals the clock seam's
  as-of date post-sync — sim behaviour and all fixture pins are unchanged.

---

## Resolution of the 7 builder-flagged inferences

**1 — resource add/remove body shape + DELETE-with-body.**
**Confirmed divergence.** Real GitHub uses **four optional string arrays**
(`users`, `organizations`, `repositories`, `enterprise_teams`) on both `POST` and
`DELETE …/resource`; MSW uses `{resources:[{type,name}]}`. The DELETE-with-body
pattern is **legitimate/documented** here (not a risk). → MSW keeps its typed-array
internal convenience; **github-impl must send the four-array shape** — recorded as
a 9.2 reconcile item. No MSW change now (no consumer until 4.8; changing it
speculatively would still leave M8/M9's response as an enrichment).

**2 — cap toggle field naming (`{enabled, overflow}` vs PRD's `ai_credit_pool_enabled`). HIGHEST RISK — RULING BELOW.**
**The PRD example was ACCURATE, not hedged.** Real GitHub exposes a **flat
`ai_credit_pool_enabled` boolean** plus a read-only **`ai_credit_pool_state
{target_amount, current_amount}`** object (both auto-computed from license
entitlements; no settable amount). Corroborated three ways: the changelog/search
snippet, the cost-centers REST fetch, and PRD §2.2's own "e.g.
`ai_credit_pool_enabled`". So the earlier reading ("PRD hedged with 'e.g.', keep
our clean `enabled`") is **wrong on the facts** — `ai_credit_pool_enabled` *is* the
wire field.
**Ruling: keep the MSW/internal model (`included_usage_cap{enabled, overflow,
computed_limit_credits}`) unchanged; document the mapping; reconcile in
github-impl at 9.2.** The decisive reason is **not** blast radius — it is that the
divergence **cannot be fixed faithfully right now**: the **block-vs-overflow wire
representation is undocumented** (the concept page explicitly gives no field name
for the block/overflow choice). A rename that emitted `ai_credit_pool_enabled` +
`ai_credit_pool_state` but kept a *guessed* `overflow` field would match **neither**
real GitHub **nor** the app's clean internal model — strictly worse than either.
Secondary reasons: (a) the plan's Architecture Decision **mandates** the
`enabled`+`overflow`+read-only-`computed_limit` model *uniformly* across schema,
core, UI, and MSW — it is the app's deliberate internal contract, and the
wire↔model translation is a github-impl concern; (b) evidence is summarizer-grade
(the same reader confabulated the CCULB enum), too weak to justify rewriting the
committed MVP read path + github-impl types + tests; (c) Task 9.2 is the plan's
explicit charter for exactly this reconciliation, against live ground truth.
**Mapping to apply in github-impl at Phase 9:** wire `ai_credit_pool_enabled` →
model `enabled`; wire `ai_credit_pool_state.target_amount` → model
`computed_limit_credits`; block-vs-overflow ← **resolve the real field first**
(undocumented today).

**STATUS UPDATE (2026-07-08, live crash round): PARTIALLY RECONCILED — reads
done, writes pending.** The live crashes (`TypeError` reading
`.included_usage_cap.enabled` in `getControls`/`syncNow`/`listCostCenters`)
proved the divergence in production and forced the READ half of this mapping
early: `normalizeIncludedUsageCap` (`api-client/cost-center-cap.ts`) now
applies exactly the mapping above at both fetch boundaries
(`fetchCostCentersRaw` + `fetchLiveControls`), as a total, never-throwing
function — with `target_amount`'s **units USD-assumed** (row A1) and
**overflow defaulted to `'block'`** behind a literal-value key sniff (row
A2), both flagged pending the smoke R2 dump. The internal model, MSW, core,
and UI remain unchanged per this ruling. **The WRITE half is still
unreconciled** (row W1): `write/engine.ts`'s cap-toggle PATCH body sends the
internal nested shape — live cap writes stay unsafe until the overflow field
is pinned and the write body is mapped in its own round.

**3 — PATCH /cost-centers/{id} existence.**
**Confirmed real.** `PATCH /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}`
is a documented `2026-03-10` endpoint. The builder's "own inference / not in the
PRD inventory" caveat is **resolved** — handler comments updated to say so. No
behavior change.

**4 — resource-mutation response envelope (recomputed-limit body vs 204).**
**Confirmed divergence, deliberately kept.** Real GitHub returns
`200 {message, reassigned_resources}` (no recomputed cap). MSW returns the
recomputed `computed_limit_credits` in the immediate response **because 4.2's
acceptance criterion requires the recomputed limit to be observable, and a
stateless mock cannot show it on a re-GET** (the canonical fixture is unchanged).
This is a **simulation-enrichment**, not a mistake — **do not "correct" it back to
`204`/`reassigned_resources` in MSW** (that would break 4.2's criterion and the
consuming UI). github-impl reads the real shape live at 9.2.

**5 — EnterpriseTeam seat-count approximation.**
**Simulation-enrichment.** Real GitHub expands an `enterprise_teams` entry into its
IdP/SCIM-synced roster server-side; a stateless mock has no roster, so it
approximates seats via `ENTERPRISE_TEAM_SEAT_COUNTS` (+`DEFAULT_ENTERPRISE_TEAM_SEATS`).
The wire only ever carries the team *name*, so nothing GitHub-facing is fabricated —
only the *derived* seat count is a local convenience. Live seat counts arrive
naturally at 9.2. No change.

**6 — error envelope + status codes.**
**Convention-based.** MSW's `{message, documentation_url, errors[]}` is GitHub's
standard REST error shape; the preview billing endpoints publish no exact 422
schema. Success-status specifics **do** diverge (real create/patch/delete →
`200 {message, …}`; MSW → `201`/`200`-flat/`204`) — logged on M1/M3/M4. Pin the real
422 and success envelopes against live at 9.2.

**7 — create-response echoing `resources`.**
**Simulation-enrichment.** Real budget create echoes `{message, budget}`; the real
cost-center create response shape wasn't fully surfaced. MSW's cost-center create
echoes the full object incl. `resources` for in-session UI convenience. Harmless
enrichment; pinned at 9.2.

**8 — ULB display-bug detection signal (Task 4.14), `simulatedUiHidden`.**
**Simulation-enrichment — will never reconcile at 9.2 (not a drift, a permanent
gap).** Real GitHub's Budgets API has no field reporting that its own
"Budgets and alerts" UI is hiding a given budget from its list view — the
display bug (CLAUDE.md §5 / PRD §1.4) is a symptom of the UI layer, invisible
to the API endpoint that serves this exact list, so there is nothing for a
real wire field to even carry. MSW's `Budget` fixture type
(`msw/fixtures/budgets.ts`) adds an extra `simulatedUiHidden?: boolean` field,
set `true` on exactly one fixture (`ulbDisplayBug`, liam-obrien) and left
undefined everywhere else. It rides the **same already-validated** `GET
.../settings/billing/budgets` LIST endpoint (see R4 above) that `getControls()`
already reads — no new endpoint, no new bridge method, just one extra field MSW
controls on the existing response shape. `write/live-state.ts`'s
`toBudgetControl` carries it onto `BudgetControl.simulatedUiHidden` (a
display-only, never-diffed enrichment), and core's
`packages/core/src/ulbRepair.ts` `detectUlbRepairCandidates` reads it off the
same `ControlState[]` the Controls tab already holds from `getControls()`.
**Live consequence (honest, not deferred):** a real GitHub response will never
carry this field, so the `display_bug_hidden` candidate kind can only ever
fire in simulation mode. Live ULB-repair detection is limited to the
`orphaned_zero` heuristic (`$0` + hard-stop, a real, always-present wire
signal — not an enrichment) until GitHub ships an actual signal for this (e.g.
a documented field, or a future heuristic that cross-references the UI
independently). Not on the Task 9.2 checklist below: unlike inferences 1–7,
there is no real wire shape to reconcile this *against* — 9.2 should instead
re-confirm the gap still exists (or note if GitHub ever adds a real signal).

---

## Additional confirmed divergences (beyond the 7)

- **2b — user-level scope model. RESOLVED 2026-07-08 (machine-verified;
  supersedes this item's earlier summarizer-grade guesses).** The real enum has
  **seven** values: `enterprise, organization, repository, cost_center,
  multi_user_customer, multi_user_cost_center, user`. The earlier reading
  ("universal = `user` scope with empty username") was WRONG: **universal =
  `multi_user_customer`** (a distinct scope, "apply a universal budget to all
  users in the enterprise"); **individual = `user` scope + a required `user:
  <login>` field**. MSW now emits the real wire values (with 422 drift-guards
  rejecting the internal spellings) and `budget-scope.ts` maps both directions
  at the boundary — the internal `universal`/`individual` model is unchanged
  (see R4/M1).
- **CCULB scope enum — RESOLVED 2026-07-08 (machine-verified).** The old
  summarizer contradiction (`multi_user_cost_center` vs `multi_user_customer`)
  was **two real, distinct scopes**, not a confabulation: `multi_user_cost_center`
  IS the CCULB (PRD §2.1 and MSW were right all along) and `multi_user_customer`
  is the universal ULB (2b above). Task 4.10's verbatim payload stands — no
  change needed. Watch-item closed.
- **budget_amount type — machine-verified 2026-07-08:** `type: integer`, "in
  whole dollars". MSW now validates integer-only (the earlier float-permissive
  acceptance is tightened).
- **Task 5.1 — usage/users-28-day query-param filtering.** Added `year`/`month`
  /`day` support to the R5 usage handler and `since`/`until` to the R6
  users-28-day handler, so historical fixtures (`fixtures/usage-history.ts`)
  can be surfaced on request without changing either endpoint's default
  (no-param) response or its response wire shape. These param names match
  real GitHub's documented enhanced-billing usage-report query parameters
  (`year`/`month`/`day`/`hour`) — request-side only, no new response field,
  so this doesn't change either row's read-shape verdict above.
- **Task 5.4 — `github-impl.ts` sends `year` (R5); the R6 `since` param is
  DEAD (it was fictional).** Superseding the Task 5.1 note above: Task 5.4's
  forecast-on-sync consumer sends `year` on the R5 usage read (whole current
  year — MSW resolves this as the open cycle unioned with the 3 prior closed
  cycles; `year` is a real, documented enhanced-billing query param, now also
  a per-CC fan-out per the R5 row). Task 5.4's original R6 historical fetch
  sent `since` — **that parameter does not exist on the real metrics-reports
  surface** (disproven in the 2026-07-08 reconciliation) and was deleted.
  Per-user forecast history is instead a **users-1-day daily backfill** over
  the 3 prior closed cycles (`fetchHistoricalCreditsUsedItems`, github-impl:
  from the 1st of the month 3 calendar months before cycleStart through the
  day before cycleStart — 2026-03-01..2026-05-31, 92 days at the June-14
  anchor — dates from the `cycleBounds` clock seam, never wall-clock; strictly
  pre-cycle, so concatenation with the current-cycle fan-out cannot
  double-count a day). See R7 for the resulting Sync call volume and the
  `USERS_REPORT_CONCURRENCY` knob. Confirm at 9.2 that real GitHub accepts a
  bare `year` with no `month`.

---

## Task 9.2 reconcile checklist (carry-forward)

**Status as of the 2026-07-08 R3/R5/R6 live reconciliation** (pulled forward
from Task 9.2): the READ surface is now `live-confirmed` (R3/R5/R6 rewritten;
R1/R2/R4 proven OK on the authed smoke, exact field pins still summarizer-grade).
Remaining items, when the live tenant + classic PAT
(`manage_billing:enterprise`) is next available:

1. **Cap wire shape** — `ai_credit_pool_enabled` + `ai_credit_pool_state` ↔ internal
   `included_usage_cap{enabled, overflow, computed_limit_credits}`; **resolve the
   block-vs-overflow field name** (undocumented today). *(Still pending — writes
   were out of the 2026-07-08 read-reconciliation's scope.)*
2. ~~**Resource mutations**~~ **CLOSED 2026-07-08 (machine-verified,
   write-shape round):** engine sends the four-array body; MSW accepts only it
   (old shape → 400 loudly); add echoes `reassigned_resources | null`, remove
   `{message}` only (M8/M9).
3. ~~**Budget success envelopes**~~ **CLOSED 2026-07-08 (machine-verified):**
   uniformly `200 {message, budget}` / `{message, id}`; no 201/204 anywhere.
   MSW emits, engine parses (M1/M3/M4).
4. ~~**User-scope model**~~ **CLOSED 2026-07-08 (machine-verified):**
   `multi_user_customer` = universal; `user` + `user` field = individual;
   mapped both directions by `budget-scope.ts` (R4, inference 2b). Fixed a
   real live misclassification bug in Controls.
5. ~~**CCULB enum**~~ **CLOSED 2026-07-08 (machine-verified):** BOTH disputed
   values are real, distinct scopes — `multi_user_cost_center` is the CCULB
   (PRD/MSW/4.10 payload correct as-is); `multi_user_customer` is the
   universal ULB.
6. **Budget list pagination — shape CLOSED, code PENDING.** In-body
   `{budgets[], total_count, has_next_page}` is machine-verified, but the read
   code still consumes Link-header style pagination. Single-page tenants (the
   maintainer's 10 budgets) are unaffected; reconcile the reader before any
   multi-page tenant.
7. ~~**Usage path** — `…/billing/ai_credit/usage` / `…/usage/summary` (PRD §2.3) vs
   MSW `…/billing/usage`.~~ **RESOLVED 2026-07-08:** both path families are real
   and coexist. `…/settings/billing/usage` (R5, adopted) is the enterprise
   usage report; the PRD §2.3 paths (`ai_credit/usage`, `premium_request/usage`,
   `usage/summary`) are the filterable per-product reports — recorded as N1,
   `docs-confirmed, unadopted`.
8. ~~**Error/422 body**~~ **CLOSED 2026-07-08 (machine-verified):** budgets
   POST/PATCH use the shared `validation-error` schema (422); cost-center
   mutations list **400, never 422** — MSW realigned (see "Error envelopes").
9. ~~**OpenAPI pass**~~ **CLOSED 2026-07-08:** `github/rest-api-description`'s
   `descriptions/ghec/ghec.2026-03-10.json` (~12MB calendar-versioned per-file
   spec) parsed — the old "too big to parse" note referred to the undated
   bundle and is superseded; **this file is the go-to §6.9 source from now
   on.** Every budget/mutation shape above upgraded to `machine-verified
   (OpenAPI)`; also confirmed en passant: A1 cap units ("in dollars",
   verbatim), no overflow field anywhere in the schema (A2 narrowed), and the
   metrics `/{day}` path variants NEVER existed in the API (see item 13).
10. **Auth surface (A1)** — confirm against a live classic PAT that `/rate_limit`
    returns `X-OAuth-Scopes`, that fine-grained tokens omit it, and that the
    required scope string is exactly `manage_billing:enterprise`. *(Still
    pending an explicit A1 check on the next authed run — the 2026-07-08 smoke
    proved the PAT authenticates the R1–R6 surface, which is necessary but not
    the header-mechanism pin.)*
11. ~~**R6 file-format pin**~~ **CLOSED 2026-07-08** (third + fourth authed
    smokes, twice identical): **JSONL**, first-record keys exactly
    `[user_id, user_login, ai_credits_used]`, 1,111 records on the tenant's
    28-day report. MSW report-file twins realigned to emit JSONL (R7).
12. **R5 placeholder values — PARTIALLY closed 2026-07-09.** The sku strings
    are now live-pinned (item 16); `unitType`/`organizationName` remain
    placeholders (`'Unit'` / `'dewr-digital'`) — pin from a live item dump
    when convenient. `pricePerUnit` is now a per-sku map in MSW ($0.01 AI
    credits — exact per CLAUDE.md §5 — $19 Copilot Business, $0.04 Premium
    Request; every fixture row satisfies gross = qty × rate exactly).
13. ~~**R6 four-variant tenant-surface map + tenant type**~~ **CLOSED
    2026-07-08**: two identical runs returned `28d/latest=OK; 28d/{day}=404;
    1d?day==OK; 1d/{day}=404` — the tenant is **docs-faithful**; the
    path-param variants do not exist; the inferred `1d/{day}` twin is refuted;
    the variant fallback is retained purely as insurance (inert on GHEC).
    **Tenant type: github.com (GHEC), confirmed 2026-07-08** — the earlier
    "router binds latest as {day}" diagnosis is retracted (probe-day artifact,
    see the corrected live-contact history). **Machine-corroborated in the
    OpenAPI pass:** only `/users-1-day?day=` (query, required, format date)
    and `/users-28-day/latest` are defined — the `/{day}` path variants NEVER
    existed in any GitHub surface; the fallback chain's second variant is
    provably dead code, kept by explicit maintainer ruling (aware of this
    evidence). Also machine-verified: the 1-day envelope carries `report_day`
    (not `report_start_day`/`report_end_day` — those are the 28-day pair).
14. ~~**R2 cap-field dump**~~ **CLOSED 2026-07-09** (maintainer's third live
    smoke): first-cc keys = `[id, name, state, ai_credit_pool_enabled,
    azure_subscription, resources]`; `ai_credit_pool_enabled=false`;
    `ai_credit_pool_state=<absent>` (cap disabled); **overflow-suggestive
    keys: NONE**. Combined with the schema search this closes **A2
    negatively** — no per-CC overflow field exists; see the A2 row for the
    maintainer's sim-only-what-if ruling and the paid-usage-policy
    consequence.
15. ~~**Cap WRITE body**~~ **CLOSED 2026-07-09 (W1):** `executeCapMutation`
    sends exactly `{ai_credit_pool_enabled}`; overflow-only entries issue
    zero mutations + one audit event (ratified); MSW 400s the old nested
    shape, any overflow key, and non-boolean values. Remaining flag: the
    cc CREATE body's cap dialect (see W1 row).
16. ~~**(product, sku) usage filter**~~ **CLOSED 2026-07-09 — the dashboard
    fix landed.** The maintainer's third smoke pinned the live inventory
    verbatim: `copilot/"Copilot AI Credits" n=7 qty=486084.5584155
    gross=4860.85 disc=3825.88 net=1034.96; copilot/"Copilot Business" n=27
    qty=487.325 gross=9259.18 disc=0 net=9259.18; copilot/"Copilot Premium
    Request" n=12 qty=65288.79 gross=2611.55 disc=1753.40 net=858.15`.
    **Maintainer decision: pool/metered derive from "Copilot AI Credits"
    ONLY** — `isAiCreditUsageItem` (usage-fetch.ts, exact case-sensitive
    match) applied at the three derivation boundaries (getUsageSummary,
    computeSyncForecasts, assembleUsageState); fetches + snapshot persistence
    stay RAW (persist-raw ratification above). Fixtures realigned to the real
    sku strings (VALUES byte-identical — all AI-filtered pins hold: 193,036
    qty, per-CC 31,136·18,900·58,300·57,400·15,000·12,300) plus four
    POLLUTION rows (Business/Premium, fractional quantities; unfiltered they
    would add +514.5 qty / +1,400 phantom pool credits / +83,608 phantom
    metered credits — validator-recomputed) as a permanent regression guard.
    Live-magnitude conversions test-pinned: disc $3,825.88 → 382,588 pool,
    net $1,034.96 → 103,496 metered, unfiltered enterprise metered would
    read 150,248 in the live-shaped test world.
17. **`reassigned_resources` sub-shapes (NEW, next smoke/write):** is
    `previous_cost_center` an id or a name, and what is `resource_type`'s
    exact casing (`User` vs `user`)? The schema leaves both loose; pin from a
    real add-with-move response before the engine ever branches on them.
18. **Single-POST move optimization — RECORDED RULING (not open):** the wire
    can express a cross-CC move as one POST (add-with-reassign, per
    `reassigned_resources`), but the maintainer ruled the engine KEEPS its
    two-op remove→add sequence for drift-detection and per-CC audit-event
    semantics. Revisit only if live rate limits ever make the extra call
    matter.
19. **Transitional internal-spelling read-tolerance (removal note):**
    `budget-scope.ts` still accepts `universal`/`individual` as read
    passthrough (mock-cutover safety; real GitHub never sends them). Remove
    after one full-green live cycle so drift-guarding is total on reads too.
20. ~~**Budgets have a PRODUCT dimension**~~ **CLOSED 2026-07-09.** Control
    families now scope to **`budget_product_sku === 'ai_credits'`**
    (`isAiCreditBudget`, budget-scope.ts), applied at BOTH read boundaries —
    critically **BEFORE scope mapping in `fetchLiveControls`**, because the
    filter kills a real WRITE hazard, not just a display bug: a same-scope/
    same-entity actions budget would otherwise collide with the AI-credit
    budget's `controlIdentity` in `budgetWireByIdentity` and let a
    PATCH/DELETE silently land on the WRONG wire budget (test-pinned: the
    actions fixture's id appears nowhere in the identity map; validator
    re-read the code path — excluded budgets are unreachable via create
    targeting, delete-by-id, and drift compare alike). `fetchBudgetsRaw`
    filters likewise (test-pinned: a $2 user-scoped actions budget no longer
    outranks emily-zhao's $46 AI ULB in ULB precedence). Exclusions are
    **traced, never silent** (`warnExcludedProductBudgets` — count + sku +
    scope + entity, **never amounts**; same channel as the scope-skip
    trace). The engine's CREATE single-sources `budget_product_sku` from
    `AI_CREDITS_BUDGET_SKU`. The **maintainer-sanctioned display-only
    `productSku?: string`** landed on core's `BudgetControl`
    (validator-RATIFIED against the `simulatedUiHidden` precedent: absent
    from `BudgetDiffField`/`BudgetFieldChange`, in no mutation payload, and
    `stripDisplayOnlyFields` is an allow-list reconstruction so it
    structurally cannot reach persisted snapshots — **chargeback note:**
    persisted control snapshots therefore do NOT carry the product sku; a
    future chargeback view re-derives it from raw wire data, not snapshots).
    Controls sub-lines append "· <sku>" (`withProductSku`) to disambiguate
    same-scope rows. Mock: 3 non-AI pollution budgets — enterprise
    ProductPricing/'actions' $1,500 stop=ON (deliberately the SAME
    scope+entity as the AI enterprise budget: the collision fixture),
    enterprise SkuPricing/'actions_linux' $400, org ProductPricing/'actions'
    'dewr-digital' $250 — count model **19 = 16 ai_credits (12 Family-A + 4
    Family-B) + 3 excluded** (validator-recomputed from the fixture file).
    **Decision recorded: NO UI carrier for the excluded count** (no honest
    existing structure — it would need a second sanctioned field); the count
    lives in the operator trace + the smoke's filter split. **R4 smoke
    sampler landed:** the R4 row now prints the included=N/excluded=M split
    (+ distinct excluded skus) and one inventory line per budget —
    `budget_type/budget_product_sku/budget_scope/<entity or user login>
    $<amount> stop=<bool>`. Amounts appear in the maintainer-facing smoke
    report only, never in console traces.
21. **cc CREATE cap dialect (NEW, flagged by the mock side):** MSW's
    cost-center CREATE body still accepts the internal nested
    `included_usage_cap` shape (only the PATCH body was pinned this round);
    pin the create body's cap field on a future smoke/write and align.
22. ~~**`budget_type` PAIRING TENSION**~~ **CLOSED 2026-07-09 — LIVE-PINNED
    by the maintainer's R4 sampler over their 10 real budgets:** ALL seven
    of their `ai_credits` budgets are **`BundlePricing` at EVERY scope**
    (their enterprise $1,000 budget AND all six cost_center spending limits
    — e.g. `BundlePricing/ai_credits/cost_center/TSD-Premium $100
    stop=true`); `ProductPricing` pairs only with product skus
    (codespaces/packages/actions, all $0 stop=true on their tenant). Our
    engine's scope-inferred branch (`isUlbScope ? BundlePricing :
    ProductPricing`) was therefore WRONG for Family-B creates — a live
    spending-limit CREATE would have sent the **nonexistent
    ProductPricing+ai_credits pairing**. Fixed: the engine's CREATE
    `budget_type` is now the constant `'BundlePricing'` (branch deleted;
    every budget this tool creates is an AI-credit budget); the four
    Family-B fixtures corrected to BundlePricing (only that field); MSW
    grew a `validateBudgetPairing` **drift-guard on create** —
    BundlePricing+ai_credits 200, ProductPricing+ai_credits **422**
    (field=budget_type), SkuPricing+ai_credits 422, ProductPricing+actions
    200 (all test-pinned; validator ran them). New engine test pins a
    cost_center spending-limit CREATE's full POST body with BundlePricing.
    Sweep results: PATCH bodies never carry a type; `BudgetWireRef.budgetType`
    is passive (zero consumers — left as honest dead weight, flagged);
    validator repo sweep found and corrected one residual synthetic
    ProductPricing+ai_credits pairing in a test-local repository-skip
    fixture (behavior-neutral: that skip is scope-driven).
    **Decision recorded — inverse pairing NOT enforced:** the mock accepts
    BundlePricing+`<other sku>` because that space is unpinned (the mock
    must not reject what real GitHub might accept); flagged, revisit only
    if it ever bites. **Fixture stop-posture note:** the live tenant's
    ai_credits budgets are all stop=true (incl. three $0), while our
    Family-B keeps 3-of-4 stop=false — deliberate §6.3 narrative fixtures
    (the hard-stop-OFF default story), not drift; posture note only.
23. ~~**R5 DATE GRANULARITY**~~ **CLOSED 2026-07-09 — hypothesis CONFIRMED
    by the maintainer's histogram and fixed.** The live pins (histogram
    verbatim in the builders' comments): live R5 items are **monthly
    aggregates dated first-of-month with ISO time suffixes**
    (`"2026-06-01T00:00:00Z"`); the unparameterized call returns
    **year-to-date**; the current-month row is **MTD-cumulative and grows
    between calls**. Two live money bugs, both fixed:
    (1) `Date.parse(date + "T00:00:00.000Z")` was **NaN** on live dates —
    every live row silently fell out of the cycle window (the actual-burn=0
    Overview); (2) month totals read as daily burn (the P50 ≈ total×31 /
    $360,624 blow-up). **The design:**
    - **Normalization boundary:** `normalizeUsageDate` (day-precision
      slice, datetime-tolerant) applied inside BOTH shared fetch functions
      (`usage-fetch.ts`) — github-impl's single-CC path refactored onto the
      shared helper, closing the one bypass; no downstream consumer ever
      sees a datetime date. NaN regression test-pinned against the OLD
      construction.
    - **Grain signature:** `isMonthlyAggregateGrain` — all same-month rows
      on ONE distinct date that is the first of the month. **Documented
      edge:** a genuine per-day feed whose only usage fell on the 1st reads
      as aggregate — numerically identical series, harmless. (Validator
      swept the fixture/scenario worlds: none can trip it — canonical June
      has 6 distinct dates; every scenario world spreads via `splitDaily`
      over multiple weekdays; the lone Aug-31 cliff row is not
      first-of-month; the Sep-01 cliff row does trip the expansion but is
      post-as-of and dropped by the series fold — the enterprise byte-equal
      forecast test passes UNMODIFIED, verified purely-additive in the
      diff.)
    - **Month-bucket cycle scoping** (`date.slice(0,7) === cycleMonth`) in
      `assembleUsageState` + `getUsageSummary`'s burn-down — provably
      identical to the old day-window for per-day rows (a cycle IS a
      calendar month; the cliff rows still fall out) and correct for live
      YTD (keeps January..June out of July's line).
    - **Grain-adaptive `buildDailyBurn`:** per-day months use the original
      fold byte-identically; aggregate months take the **level** from R5's
      MTD pool total (money truth) and the **daily shape** from R6
      users-1-day per-user sums scaled to end exactly at that total, with
      a flat MTD/elapsed ramp fallback when R6 has no cycle data. **R6 is
      fetched LAZILY only on aggregate detection** — validator traced the
      gate: simulation never pays the extra fan-out.
    - **`expandMonthlyAggregates`** (pure, forecast/compute.ts): per
      (costCenterId, month) group — closed months → total/daysInMonth;
      current month → MTD/elapsed over days 1..as-of; per-day groups pass
      through untouched (validator hand-verified total preservation and ran
      the 300,000/30=10,000-per-day and run-rate-sanity pins).
    **Documented statistical consequences:** live enterprise/CC forecasts
    run **without weekday seasonality by construction** (unrecoverable from
    monthly aggregates — flat spread); the R6-derived burn-down shape is
    pool+metered-**undifferentiated** (level is money-true); live MAPE
    becomes **level accuracy** against equally-flat actuals
    (self-consistent). User-scope forecasts keep real seasonality (R6 is
    genuinely daily).
    **Mock live-grain world:** `fixtures/usage-live-grain.ts` — a
    slug-discriminated regression world (`dewr-live`), 38 hand-computable
    monthly ISO-dated YTD rows (AI June $2,400 closed + July $1,450 MTD;
    Business Jan–Jul ×3/mo; Premium Jan–May ×2/mo — validator recomputed
    every line), served by the same handler/projection; **deliberately NOT
    a scenario-selector entry** (the renderer-facing selector + its e2e
    pins stay untouched; tests reach it by slug); a no-leak guard pins the
    canonical `dewr` world still per-day/bare-dated; canonical fixtures
    byte-untouched. **Unpinned-dimension flag:** the live-grain world's
    per-row `organization_name` bucket values are a modeled guess (the live
    histogram pinned counts and dates, not bucket names).
    **Collapse blocker (flagged):** `fetchHistoricalUsageItems`' `year`
    call is live-redundant (the unparameterized call is already YTD) but
    the mock's default is current-cycle-only, so collapsing the two reads
    is blocked on a mock-side YTD-default switch — a separate decision.
    **New minor open items:** (a) `getUsageSummary`'s HEADLINE totals
    remain report-span (live: YTD) rather than cycle-scoped — the burn-down
    is now MTD-correct, but whether the Overview tiles should be
    cycle-scoped is a **product call for the maintainer**; (b) fixture
    ALERTS render even in live mode — pre-baked by design until Task 7.6
    (PLAN.md Architecture Decision), recorded so it stops surprising.
24. ~~**MODE-BLIND PERSISTENCE**~~ **CLOSED 2026-07-09.** (The bug: live-synced
    PERSISTED rows rendering inside a SIMULATION session — sim banner + the
    672,000 live allowance + the $360,624 live forecast tile + June-14
    fixture alerts on one screen; never a wire-safety issue, but simulated
    and live numbers must never co-mingle, §6.8-adjacent.) **The full
    persisted-read sweep (validator-verified independently — every
    `select`-from-schema site in non-test code):**
    | Read site | Status |
    |---|---|
    | `getSyncStatus` (sync-now.ts) | **NOW scoped** — internal signature `getSyncStatus(db, source)`; both github-impl call sites pass `config.source`; `ApiClient` surface unchanged (diff on types.ts empty). A mode whose source never synced reports `lastSyncedAt: null` — the honest pre-first-sync empty, never the other mode's timestamp. |
    | `getLastSyncedControls` (sync-now.ts) | Already scoped (`where source`, prior round). |
    | `getLatestForecast` (sync-now.ts) | Already scoped — forecast rows carry **no source column of their own**; they inherit it via `innerJoin(snapshot)` on `snapshotId` + `where snapshot.source` — **no migration needed**. |
    | `latestSnapshotId` (write/engine.ts) | Already scoped (audit-provenance round; honest-null when the mode has no snapshot). |
    | `appendAuditEvent` tip read + `readAuditChain`/`verifyStoredChain` (audit/writer.ts) | **DELIBERATELY unscoped — validator-RATIFIED against §6.5:** the audit log is ONE append-only hash chain per database; each event's hash is computed over the previous event's hash regardless of mode (writer.ts), so mode-filtering rows would present events whose `prevHash` points at filtered-out rows and **break chain verification** for any interleaved history. Per-event mode provenance already rides the mode-scoped `dataSnapshotId`. A mode-filtered audit **display VIEW** (filter after verifying the whole chain) is the flagged display-layer follow-up. |
    Both-direction tests pin the isolation (live rows invisible to sim reads
    and vice versa — including a 672,000-credit live control/forecast row,
    the maintainer's exact bleed artifact). `perUserDataThroughDay` confirmed
    leak-free (per-client-instance state, source fixed at construction,
    rebuild = fresh instance).
    **Boot mode diagnostics (same round — the maintainer's banner-mystery
    instrument):** the main process logs
    `[mode] resolved=<mode> force_simulation_env="<raw verbatim>"
    pat_present=<bool>` at every mode resolution (content-deduplicated so
    renderer polling stays quiet; an unset env prints the literal
    `"undefined"`, distinguishing "env never reached the Electron process"
    from "env set to a wrong value"; **never the token**). `rebuildClient`
    logs both branches and states the known papercut explicitly: **mode does
    NOT re-resolve until relaunch** — saving a PAT mid-session rebuilds
    credentials, never the mode (Task 9.3's charter). No mode-resolution
    behavior change.
    **Cycle-scoped headline totals (maintainer decision, same round):**
    `getUsageSummary`'s three USD totals (gross/discount/net) now sum
    cycle-month + AI-credit rows only — live, a YTD sum against a monthly
    cap was the 1115%-pathology's last surviving artifact (Controls'
    enterprise spending-limit meter; sim pin 2,534 → 2,300 credits, live
    YTD → MTD). **`totalQuantity` deliberately remains report-span** — the
    decision named only the USD fields; **flagged asymmetry, pending a
    maintainer word** (validator surfaced — **resolved by item 25's
    follow-up decision: aligned**). Changed pins all
    validator-recomputed: span-net 25.34 → 23.00 (Sep-1's 2.34 out);
    pollution-world gross 1,930.36 → 1,921.00 (cliff 4.68+4.68 out);
    workforce meter 234 → 0 (the one justified e2e edit, decision cited
    in-spec); live-shaped monthly net 2,403.56 → 1,042.72 (July MTD; June's
    1,360.84 bucketed out).
25. **COST CENTERS LIVE-CORRECTNESS + totalQuantity alignment (CLOSED
    2026-07-09).** The maintainer's live Cost Centers screen showed
    "undefined → undefined → undefined" mappings and NaN burn/headroom —
    the sim-only enrichments (`dewr_*`, `mtd_burn_credits`) are absent on
    real cost centers. Fixes, all maintainer-decided:
    - **MTD burn is now DERIVED** in `listCostCenters` from the R5 per-CC
      fan-out (cycle-month + AI-credit rows, Σ quantity, rounded once) —
      grain-agnostic (a live monthly-aggregate row's quantity IS the MTD
      cumulative; per-day fixture rows sum to the identical totals the old
      enrichment carried — validator recomputed workforce 30,200 and
      capBound 58,300 from raw fixture rows; every pre-existing pin passes
      unmodified, and the committed cost-centers/Controls meters now PROVE
      the derivation). The `mtd_burn_credits` enrichment is no longer read
      — **mock-side cleanup flag:** the fixture field can be retired in a
      mock round. NaN structurally impossible (`Math.round(map.get ?? 0)`;
      wire quantities are JSON numbers). **Cost note:** `listCostCenters`
      now performs the R5 fan-out (+1 default + 1 per CC ≈ +7 requests per
      call on the six-CC world) — acceptable, same pattern as
      `getUsageSummary`.
    - **Honest no-cap semantics:** a cap-disabled CC renders Headroom
      "— no cap" + a neutral "no cap" status chip (`NO_CAP_STATUS_META`);
      exclusion still wins; drill modal mirrors; the cap-enabled path is
      untouched (all sim fixtures are cap-enabled → sim byte-identical).
    - **DEWR mapping is APP-LOCAL metadata** (maintainer ruling): source
      precedence local DB columns → sim wire enrichment → null;
      `formatDewrMapping` renders "— not mapped" / per-segment em-dashes,
      never "undefined". **Sanctioned interface additions
      (validator-RATIFIED):** `ApiClient.updateCostCenterMapping(
      costCenterId, {dewrDivision|dewrBranch|dewrProject: string|null})`
      — the ONE new method, implemented as a local Drizzle upsert (zero
      octokit references; a test brackets the call with an
      api.github.com listener and asserts zero requests; in-modal + toast
      copy state "app-local, never contacts GitHub"); and
      `CostCenterSummary.dewr*` re-typed `string` → `string | null` (a
      truthfulness fix — the old annotation was already violated by live
      rows). No migration: the `cost_center` columns were already
      nullable. Edits survive syncs — `syncNow`'s upsert sets only
      `name`/`state` (test-pinned). Edit affordance lives in the DRILL
      MODAL header (deliberately not the table cell, protecting six
      committed `toHaveText` pins); nested-Escape handled; zero Electron
      imports in the UI (portability rule verified).
    - **`totalQuantity` cycle-scoped** — the maintainer's follow-up
      decision resolving item 24's flagged asymmetry: all FOUR headline
      totals now sum cycle-month AI-credit rows. Re-pins
      validator-recomputed: 193,036 → **192,100** (= 189,800 pool + 2,300
      metered; cliff 468+468 out) ×2 tests; workforce 31,136 → **30,200**;
      live-shaped 972,944.5584155 → **486,860** (July MTD; each pin cites
      the decision in-test).
26. **AUTO-BALANCE LIVE CONTEXT (CLOSED 2026-07-09 — both rebalancer modes
    dry-run against real tenant data, STRICTLY simulate-only).**
    `getRebalanceContext`'s live branch replaces the old
    `{available:false, reason:'live mode'}` refusal (that pin's removal is
    the maintainer-directed design change, validator-audited):
    - **Pool context** (`buildLivePoolContext`): controls via
      `fetchLiveControls`; usage via `assembleUsageState`; pool scalars
      from the persisted **mode-scoped** enterprise forecast (item 24) —
      `allowanceLine` at the as-of day = pool total, `p50/p90Cumulative`
      at cycle end (last day of the as-of month; `.at(-1)` defensive
      fallback) = projections; MTD pool consumed from the R5 fan-out
      (cycle-month, AI-credit, per-item cent rounding — the burn-down
      rule). **Honest gates, never fabricated numbers:** never-synced →
      "run Sync now first"; stale forecast (series lacks today — an
      exact-date membership test, boundary validator-checked: a series
      ending today passes) → names the forecast's `computedAt`.
    - **Metered context** (`buildLiveMeteredContext`): no Sync gate —
      direct live reads only (documented). **Entity-curation rule,
      validator-RATIFIED:** at-risk candidates are derived from the live
      control estate — every CC holding a `cost_center` spending limit +
      every user holding an individual ULB. Sound against the PRD's
      metered rebalancer: its levers are exactly cost-center-budget raises
      and individual-ULB overrides, so an entity holding neither has no
      binding constraint to relax; uncontrolled entities are out of scope
      by construction (mirrors the sim scenarios' hand-curation).
      `meteredPhaseActive` = any in-cycle enterprise metered spend.
    - **RESERVE RULING (validator, resolving the builder's "Q5 open"
      error — Q5 was answered 2026-07-07: approval-gated / 5% reserve /
      revert-at-reset):** the **pool** path already honors the 5% — core's
      `reservePct` defaults to 0.05 of `poolTotalCredits` when no params
      are passed (which the live context doesn't); validator-added pin:
      envelope reserve = round(0.05 × 672,000) = **33,600** in the live
      pool test. The **metered** engine takes only ABSOLUTE
      `reserveCredits` (no percent semantics in core;
      `DEFAULT_RESERVE_CREDITS = 0`), so "5% of what" is genuinely
      ambiguous — **0 stands, explicitly tied to Task 7.2's policy store**
      with the recorded 5% as its named default candidate (comments
      corrected in impl + test).
    - **Known limitation (flagged, Phase-7-adjacent upgrade):**
      `projectedUsage` mirrors `currentUsage` (no live per-entity growth
      projection exists yet — the same no-growth contract sim's healthy
      scenario uses).
    - **No-mutation proof:** the apply lever remains Phase-7
      hard-disabled on both rails; the screen imports no writing bridge
      method; a listener test asserts live context assembly issues >0
      GitHub requests, every one a GET.
    - **UI honesty:** a data-driven zero-ULB card (core `isUlbScope` over
      `ctx.controls`) explains that ULBs are the pool phase's entire lever
      set and points at Controls — the maintainer's real (zero-ULB) tenant
      renders an explained no-op instead of an unexplained all-zero
      proposal; the unavailable-card copy no longer says "later phase" and
      the sim-only scenario-switch advice never renders in live mode.
    - **Test coverage note:** live branches are unit-covered only
      (headless e2e runs sim — 5 new hand-computed tests incl. the 96% ≥
      `AT_RISK_THRESHOLD_PCT` 0.95 metered proposal world,
      validator-recomputed: Alpha 48,000/50,000 cap, enterprise 53,000
      used of 200,000 → 147,000 headroom). **Mock-side follow-up
      suggestion:** a live-shaped scenario world so e2e can drive the live
      gate states.

## Interactive verification record — 2026-07-09 (§6.7 second-half debt cleared)

Dedicated CDP pass per CLAUDE.md §7 (real Electron process via
`tools/cdp/harness.mjs`, throwaway scratchpad probes, both isolation dirs,
screenshots literally inspected + `getComputedStyle` calipers). Simulation
mode (no PAT on the verification machine). **Scope: the accumulated
headless-only UI debt** — the Cost Centers live-correctness round (edit-mapping
modal, derived MTD burn, no-cap/not-mapped states) and the Auto-balance
live-context round's sim side. **Outcome: verified clean, zero code changes;
one sim-only design collision documented below.**

- **Edit-mapping flow, end to end (looked at, not just asserted):** drill
  header renders the mapping + a subdued "✎ edit mapping" pill (11px,
  muted `rgb(145,152,161)`, pointer cursor — matches the design idiom);
  the editor modal (dark `rgb(21,26,34)`, 16px radius, the modal-family
  layout) opens with the verbatim statement "App-local metadata only —
  saving never contacts GitHub." and three pre-filled labeled inputs;
  nested Escape closes the editor while the drill survives; Save closes
  the editor, fires the toast "DEWR mapping saved (app-local — no GitHub
  change)." (fixed-position, z-index 40), and both the drill header and —
  after closing the drill — the table cell re-render the new mapping.
  Zero console errors.
- **Cost Centers table:** all six sim CCs render the hand-known derived
  MTD burns (30,200 / 18,900 / 58,300 / 57,400 / 15,000 / 12,300 —
  screenshot-verified digits), full DEWR mappings with no "undefined", no
  NaN anywhere; headroom/status pairing intact (Payments Integrity
  −2,300 overrun red ⚠ + "over cap" chip; Data & Evaluation 5,600 low
  amber ⚠ + "within").
- **Auto-balance sim side:** pool mode renders the healthy world (trigger
  MONITORING — NOT FIRED, day 13/30, pool 33.5%); metered mode in the
  healthy scenario shows the honest unavailable card WITH the sim-only
  scenario-switch advice (correct — sim session); switching the scenario
  selector (segmented control: Healthy / At risk / Surplus / Metered) to
  Metered renders the full fired proposal — three trigger conditions met,
  $3,200 allocatable envelope, **+$60 bill delta**, $4,860 projected
  total, $3,140 remaining headroom (the committed Phase-6 world,
  pixel-confirmed); the apply lever reads "Dry-run only — auto-apply
  arrives with guardrails" and is disabled in every state checked.
- **Regression sweep:** all 10 screens walked; the sim banner is present,
  unmistakable, and **stays visible after scrolling each screen to the
  bottom** (the Task-2.5 lesson re-checked); `window.api` exposes 26
  bridge methods incl. `updateCostCenterMapping`; `process`/`require`
  undefined in the renderer; **zero console errors or exceptions across
  the entire walk**.
- **Settings/Sync:** pre-sync "Never synced"; after a UI-driven Sync Now
  the line reads "Last synced: <timestamp> — per-user data through
  2026-06-14" (the coverage suffix, sim as-of date, exactly as specified).
- **FINDING (documented, not fixed — ask-first territory): clearing a
  mapping in SIMULATION reverts to the fixture enrichment.** The editor
  deliberately persists cleared fields as `null` ("no value stays
  honest"), and item 25's field-level precedence (`local ?? enrichment ??
  null`) then falls through to the sim enrichment — so a cleared mapping
  re-renders (and re-opens) with the fixture values. **Live is unaffected**
  (no enrichment exists; cleared stays "— not mapped"). Representing
  "explicitly cleared" distinctly would need either a schema marker or
  empty-string sentinel semantics on the sanctioned interface — both
  ask-first; recorded for the maintainer to rule on if sim-side clearing
  ever matters (it is a demo-world-only quirk).
- **NOT verifiable here (remains on the maintainer's live checklist):**
  the live-only states — "— no cap" / "— not mapped" against real cost
  centers, the live Auto-balance gates ("run Sync now first" / stale
  forecast) and the zero-ULB card against live data, and the live
  boot-mode log line.

## Task 9.3-lite — §6.9 EXEMPT (app-local; no GitHub wire surface added)

The in-app mode toggle + live-write arming change (2026-07-09) adds four
`ApiClient` methods — `getAppModeSetting` / `setAppModeSetting`,
`getWriteArmingState` / `setWriteArming` — and **none of them issue a GitHub
request**. They are entirely app-local: the mode setting is a SQLite
`app_settings` KV read/write (migration 0004), and arming is a main-process
memory singleton (`write/arming.ts`, deliberately never persisted). No
`octokit.request` / raw `fetch` / hand-wrapped path was introduced or changed,
so there is no wire shape to validate against the OpenAPI description — §6.9 does
not apply (confirmed by grepping the diff for new GitHub calls: none). The
write-engine's live mutation paths (M1/M3/M4/M7, above) are unchanged; 9.3-lite
only prepends the `not_armed` arming gate in front of them (`source==='github'
&& !isWriteArmed()` returns before any live re-read or mutation; `source==='msw'`
and `dryRunPlan` are never gated).

Also in this change: the `COPILOT_BUDGET_FORCE_SIMULATION` env seam is **retired**
(the Task 1.7 stale-seam note is resolved) — mode now resolves from the persisted
`app_mode` selection AND PAT presence (`resolveMode`); the root `dev:live` script
and the unused `cross-env` devDependency are removed. Both §6.7 gate halves green:
Playwright headless (74 e2e incl. the new `settings-mode-arming.spec.ts`, 1
pre-existing skip) + interactive CDP against the real Electron process
(simulation, no PAT) — SimBanner in-viewport and unmistakable, the Settings Mode
card + inert Write-arming card render to the design idiom, the mode selection
persists without re-resolving the running process (restart-note + no-PAT-note
shown), and no reproducible console error (a one-off Electron-internal
`sandbox_bundle` prewarm artifact did not recur across four clean runs of the
same flow).

## Live wire behavior — users-1-day ZERO-FILLS history beyond retention (2026-07-10)

**Live-observed fact (maintainer's tenant, 2026-07-10 authed smoke), recorded
for future work.** The R6 users-1-day per-user metrics report **zero-fills**
history older than its retention window (roughly the current cycle): a
users-1-day fan-out over April/May/June 2026 came back as a **full roster with
real `user_login`s but every `ai_credits_used = 0`**, while July 1–8 carried
real nonzero values — even though R5 SKU-level billing shows those earlier
months DID consume AI credits. So the report does **not** omit past days; it
returns present-but-zero rows for them. This is a **wire-shape behavior**, not
an error (envelope + JSONL record keys `[user_id, user_login, ai_credits_used]`
are exactly as R6/R7 pin; the values are simply 0), so it is §6.9-relevant as a
recorded observation but touches no request/response schema.

**Consequence + local handling (no wire change).** Persisted zero rows are real
`credits_used_fact` rows, so deriving the distribution's coverage bounds from
*all* persisted dates made a zero-filled month count as a "complete" covered
month — the live per-month view rendered ~100 truthful-but-useless zero
observations for June. Fixed **entirely local** in `readDistributionFactBaseFor`
(`api-client/github-impl.ts`): the coverage bounds (`earliestDate`/`toDate`) now
derive from **winning rows with `creditsUsed > 0` only**; winning-row selection,
the per-user SUMS, and the persisted rows themselves are untouched (zero rows
still flow into `factRows`/`winnerSnapshotByDate`, so `computeLocalCreditsCoverage`
keeps showing the raw persisted truth for diagnostics). Both distribution
readers inherit the rule: the live repro (zero-filled Apr–Jun + real Jul 1–8)
anchors the "Totals" window at toDate 07-08 (truncated to earliest 07-01) and
yields NO complete calendar month → the "Per month" empty state. An interior
genuinely-zero month (nonzero months on both sides) still counts as complete and
yields all-zero observations — accepted (edge-based bounds, not a per-month
filter). **§6.9:** local-only change; no `octokit.request`/`fetch`/hand-wrapped
path added or modified — this section is the recorded wire-behavior fact, not a
new call to validate.

### Follow-up: the retention window SLIDES, and zero-fill was ERODING real history (2026-07-11)

**Live-observed fact (maintainer's tenant, 2026-07-11).** The zero-fill window is
not fixed — it **slides forward one day per day**. Yesterday the DB held real
`ai_credits_used` for 07-01..07-08; after today's sync the per-user view showed
02 Jul–09 Jul, and **07-01 had flipped from real to zero**. Because snapshots are
append-only and the distribution read took a naive per-date *latest-snapshot-wins*
merge, the newest snapshot's **zero-filled 07-01 rows won over the earlier
snapshot's real 07-01 rows** and erased them from the view. Left unfixed, each
daily sync would erode one more day, so the app could **never accumulate per-user
history past the wire's retention** — the whole point of persisting it. (Nothing
was actually lost: the real rows still live in the older, append-only snapshots.)

Also note the "~8-day / current-cycle" retention span is an **unverified
hypothesis**: GitHub's docs document **no** retention for this report, and
`ai_credits_used` only launched **2026-06-19** (changelog), yet the maintainer's
19–30 Jun rows came back zero-filled too. The fix below is deliberately
independent of any particular window size.

**Chosen winner rule (read-time) + persist-time drop — both local, no migration.**

1. **Read-time winner rule** (`readDistributionFactBaseFor`, `github` branch):
   per date, the winning snapshot is the **latest snapshot that has ≥1 row with
   `creditsUsed > 0` on that date**; if no snapshot has a nonzero row for the
   date, fall back to the latest snapshot with any row (preserves genuinely-idle
   days + old all-zero persistence). Rows for the date still come only from the
   winning snapshot. Semantics: **zero-fill never overwrites real data**; a
   genuine settling correction that zeroes ONE user while others stay nonzero on
   that date still wins (its snapshot has nonzero rows → eligible), so that
   user's real zero is honored; whole-date zero-fill (retention aging) is ignored
   in favor of the older real snapshot. **Self-healing**: already-eroded dates
   (e.g. the maintainer's 07-01) **reappear with NO data migration**. Correct
   under every retention hypothesis and robust to transient wire zero-fill
   glitches (depends only on "nonzero beats zero for the same date"). The `msw`
   (simulation) latest-snapshot-only path is behaviorally untouched.

2. **Persist-time zero-drop** (`sync-now.ts`): `syncNow` skips items with
   `creditsUsed <= 0` when inserting `credits_used_fact` (cycle AND historical
   backfill). Zero rows carry no information (roster/idle zeros are reconstructed
   from the license join at read time), so dropping them removes both DB bloat
   and the erosion vector for future syncs. Forecast inputs are unaffected
   (`computeSyncForecasts` folds the in-memory arrays, not the table).

**§6.9:** both halves are local-only; no `octokit.request`/`fetch`/hand-wrapped
path added or modified — this is a recorded wire-behavior observation plus local
handling, not a new call to validate.

## Sources consulted (2026-07-05, updated 2026-07-08)

- **`github/rest-api-description`, `descriptions/ghec/ghec.2026-03-10.json`**
  (~12MB calendar-versioned per-file spec) — **parsed 2026-07-08; the §6.9
  go-to source from now on.** The 2026-07-05 note "Not parsed: OpenAPI (size)"
  referred to the undated bundle and is superseded.
- Budgets REST reference (`2026-03-10`): `docs.github.com/en/rest/billing/budgets?apiVersion=2026-03-10` (+ `enterprise-cloud@latest` / `free-pro-team@latest` variants).
- Cost centers REST reference (`2026-03-10`): `docs.github.com/en/enterprise-cloud@latest/rest/billing/cost-centers`.
- Copilot concept: `docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing`.
- Changelog: "Cost centers now support included usage caps" (2026-07-02), "Per-user AI credit budgets available for cost centers" (2026-06-30), "GitHub Copilot is moving to usage-based billing" (github.blog).
