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
| A2 | **Overflow (block vs metered at cap exhaustion) defaults to `'block'`** when no wire field sniffs. Sniff rule: any key on the cost-center object or its `ai_credit_pool_state` matching `/overflow\|exceed\|block/i` whose value is literally `'block'` or `'metered'`; **boolean candidates deliberately unmapped** (`allow_overflow: true` vs `block_on_exceed: true` would mean opposite things — guessing polarity is worse than defaulting). | The real field is undocumented anywhere reachable. `'block'` matches the platform's default posture (pool exhaustion blocks unless paid-usage is enabled, CLAUDE.md §5) and **fails conservative**: a wrong `'block'` gives earlier exhaustion warnings; a wrong `'metered'` would project spend capacity a hard stop will deny. | A genuinely-metered CC is forecast as blocking (over-conservative alerts) until pinned. | The smoke R2 row lists every overflow-suggestive key + value on the first cost-center — if GitHub ships the field under any recognisable name, the dump surfaces it. |

### Known divergence — cap WRITES (do not toggle a cap against live yet)

| # | Method + path | Verdict | Note |
|---|---|---|---|
| W1 | `PATCH /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}` (cap toggle) | **`known-divergent (writes)` — blocked on the A2 overflow pin** | The READ path now maps the real wire (R2), but `write/engine.ts`'s cap-toggle PATCH body **still sends the internal nested `included_usage_cap` shape** — a live cap write would send a field GitHub doesn't recognise (at best ignored, at worst a 422). Live cap toggles are NOT safe from the app until this is reconciled — which is deliberately deferred to its own round because the write body needs the real overflow field name (A2) that only the R2 dump can pin. MSW mutation handlers stay on the internal shape (inference #2's ruling) until then. |

### Recorded, not adopted (docs-confirmed alternates)

| # | Method + path | Doc source | Verdict | Note |
|---|---|---|---|---|
| N1 | `GET /enterprises/{enterprise}/settings/billing/ai_credit/usage` (+ siblings `…/premium_request/usage`, `…/usage/summary`) | Billing usage REST `2026-03-10` (docs, 2026-07-08) | `docs-confirmed, unadopted` | **Resolves old checklist item #7 — the PRD §2.3 paths are real.** Per-call filters: `user`, `organization`, `model`, `product`, `cost_center_id`. Response: `{timePeriod, enterprise, user, organization, product, model, costCenter, usageItems[]}` with items `{product, sku, model, unitType, pricePerUnit, grossQuantity, grossAmount, discountQuantity, discountAmount, netQuantity, netAmount}` — note **no per-item date**; the top-level `timePeriod` carries year/month/day. Deliberately NOT integrated in the R5 reconciliation; recorded so Phase 4+ can reach for the `user`/`model` filters when per-user/per-model drill-down is needed — in particular the `user` filter is the **recovery path for the per-user pool-vs-metered split limitation** (see "Live-wire limitations" below). |

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
12. **R5 placeholder values (NEW)** — pin real `unitType`/`organizationName`
    values from a live response (MSW currently emits placeholders `'Unit'` /
    `'dewr-digital'`; `pricePerUnit: 0.01` is exact per CLAUDE.md §5).
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
14. **R2 cap-field dump — A1 CLOSED by the OpenAPI pass; the dump now pins A2
    only.** The schema says `ai_credit_pool_state.target_amount`/
    `current_amount` are **"in dollars" (verbatim)** — the USD×100 mapping is
    machine-confirmed (assumption A1 CLOSED; row A1 below stands as record).
    Still capture the smoke R2 dump verbatim on the next live run for **A2**:
    the overflow field is confirmed ABSENT from the schema (exhaustive
    search), so the dump is the last place a real field could surface; if it
    also shows nothing, the per-CC `overflow` knob may not exist on the real
    API (behavior may hang off the enterprise paid-usage policy) — a
    PRD-level modeling question for the maintainer, not to be resolved
    unilaterally.
15. **Cap WRITE body (blocked on 14/A2)** — map `write/engine.ts`'s
    cap-toggle PATCH body from the internal nested `included_usage_cap` shape
    to the real flat wire fields once A2 resolves. Until then, live cap
    toggles from the app are unsafe (row W1). Explicitly untouched in the
    write-shape round per contract.
16. **(product, sku) usage filter (NEW — the maintainer's CURRENT dashboard
    symptom).** Live, the R5 usage endpoint returns EVERY enhanced-billing
    product (Actions, storage, …) and ingestion has NO product/sku filter —
    pool/metered sums are polluted with the whole GitHub bill (the observed
    "0 pool consumed / ~$64k phantom metered" dashboard). The smoke R5 row now
    prints a per-(product, sku) inventory line (n/qty/gross/disc/net sums;
    fixture pin `copilot/ai_credits n=39 qty=193036 gross=1930.36
    disc=1905.02 net=25.34`, validator-recomputed). **Capture that line on the
    next live run — it pins the real Copilot AI-credit (product, sku) pair**
    (our fixtures' `copilot`/`ai_credits` is a PRD guess; filtering on a wrong
    guess would zero real data), and the ingestion filter lands in its own
    round against that pin.
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
19. **Transitional internal-spelling read-tolerance (NEW — removal note):**
    `budget-scope.ts` still accepts `universal`/`individual` as read
    passthrough (mock-cutover safety; real GitHub never sends them). Remove
    after one full-green live cycle so drift-guarding is total on reads too.

## Sources consulted (2026-07-05, updated 2026-07-08)

- **`github/rest-api-description`, `descriptions/ghec/ghec.2026-03-10.json`**
  (~12MB calendar-versioned per-file spec) — **parsed 2026-07-08; the §6.9
  go-to source from now on.** The 2026-07-05 note "Not parsed: OpenAPI (size)"
  referred to the undated bundle and is superseded.
- Budgets REST reference (`2026-03-10`): `docs.github.com/en/rest/billing/budgets?apiVersion=2026-03-10` (+ `enterprise-cloud@latest` / `free-pro-team@latest` variants).
- Cost centers REST reference (`2026-03-10`): `docs.github.com/en/enterprise-cloud@latest/rest/billing/cost-centers`.
- Copilot concept: `docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing`.
- Changelog: "Cost centers now support included usage caps" (2026-07-02), "Per-user AI credit budgets available for cost centers" (2026-06-30), "GitHub Copilot is moving to usage-based billing" (github.blog).
