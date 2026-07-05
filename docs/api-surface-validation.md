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
| `simulation-enrichment` | Deliberate MSW-only shape the task requires; known to diverge from live — **reconcile in github-impl at 9.2**, do not "correct" in MSW. |
| `PRD-authority` | Real docs inconclusive/contradictory; MSW follows the PRD (standing authority) — **pin at 9.2**. |

---

## Endpoint validation table

### Reads (pre-existing, hand-wrapped in `github-impl.ts`; MSW twins in `handlers.ts`)

| # | Method + path | Consumer | Doc source | Verdict | Deviation / note |
|---|---|---|---|---|---|
| R1 | `GET /enterprises/{enterprise}/copilot/billing/seats` | `github-impl` seats | Copilot seat-management REST (established) | `documented-confirmed` (path) | Response `{total_seats, seats[]}` + Link paging — conventional; pin exact fields at 9.2. |
| R2 | `GET /enterprises/{enterprise}/settings/billing/cost-centers` | `github-impl` cost centers | Cost centers REST `2026-03-10` | `docs-indicated (summarizer)` | Real cost-center object carries `ai_credit_pool_enabled` + `ai_credit_pool_state{target_amount,current_amount}`; MSW returns the internal `included_usage_cap{enabled,overflow,computed_limit_credits}` model (see inference #2). Reconcile in github-impl at 9.2. |
| R3 | `GET /enterprises/{enterprise}/settings/billing/cost-centers/{id}/resource` | `github-impl` members | Cost centers REST `2026-03-10` | `docs-indicated (summarizer)` | Real list shape/pagination not pinned; MSW `{resources[]}` + Link header. Pin at 9.2. |
| R4 | `GET /enterprises/{enterprise}/settings/billing/budgets` | `github-impl` budgets | Budgets REST `2026-03-10` | `docs-indicated (summarizer)` | **Pagination divergence:** real list returns in-body `{budgets[], total_count, has_next_page, user?, effective_budget?}`; MSW returns `{budgets[]}` + a `Link` header. Read-path change with github-impl blast radius → **defer to 9.2** (pagination reconciliation is an explicit 9.2 task). |
| R5 | `GET /enterprises/{enterprise}/settings/billing/usage` | `github-impl` usage | Billing usage REST `2026-03-10` | `docs-indicated (summarizer)` | **Path naming:** PRD §2.3 lists `…/settings/billing/ai_credit/usage` and `…/settings/billing/usage/summary`; MSW/github-impl use `…/settings/billing/usage`. Confirm the exact live path/segments at 9.2. |
| R6 | `GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day` | `github-impl` credits-used | Copilot usage-metrics REST | `docs-indicated (summarizer)` | PRD §2.3: metrics `users-1-day`/`users-28-day` carry `ai_credits_used` (per-user daily total). Exact report path/shape pinned at 9.2. |

### Mutations (new — Tasks 4.1/4.2; MSW-only today, consumed by the write engine in Task 4.8)

| # | Method + path | Task | Doc source | Verdict | Deviation / note |
|---|---|---|---|---|---|
| M1 | `POST /enterprises/{enterprise}/settings/billing/budgets` | 4.1 create | Budgets REST `2026-03-10` | `docs-indicated (summarizer)` | Path/fields confirmed. **Success shape divergence:** real returns **`200 {message, budget:{…}}`**; MSW returns **`201`** + a *flat* budget object. **Scope-enum divergence:** see inference #2b (user-scope) and the CCULB watch-item. Reconcile the envelope in github-impl at 9.2. |
| M2 | `GET /enterprises/{enterprise}/settings/billing/budgets/{budget_id}` | 4.1 read-one | Budgets REST `2026-03-10` | `documented-confirmed` (path) | MSW returns the flat budget object; real by-id shape pinned at 9.2. |
| M3 | `PATCH …/budgets/{budget_id}` | 4.1 update | Budgets REST `2026-03-10` | `docs-indicated (summarizer)` | Real `200 {message, budget}`; MSW `200` + flat object. Patchable fields (amount/prevent_further_usage/alerting) confirmed; MSW's allow-list is a strict subset (safe). |
| M4 | `DELETE …/budgets/{budget_id}` | 4.1 delete | Budgets REST `2026-03-10` | `docs-indicated (summarizer)` | **Status divergence:** real returns **`200 {message, id}`**; MSW returns **`204`** No Content. Reconcile in github-impl at 9.2. |
| M5 | `POST /enterprises/{enterprise}/settings/billing/cost-centers` | 4.2 create | Cost centers REST `2026-03-10` | `docs-indicated (summarizer)` | Path confirmed; `PATCH` sibling confirmed real (inference #3). Real cap field is `ai_credit_pool_enabled` (inference #2). Create-response echo of `resources` is a `simulation-enrichment` (inference #7). |
| M6 | `DELETE …/cost-centers/{id}` | 4.2 delete | Cost centers REST `2026-03-10` | `documented-confirmed` (path) | Path confirmed; MSW `204`. |
| M7 | `PATCH …/cost-centers/{id}` | 4.2 edit / cap toggle | Cost centers REST `2026-03-10` | `documented-confirmed` (route exists) | **Route existence CONFIRMED** (resolves the builder's "own inference / no PATCH route" caveat — inference #3). Body/response *shape* still summarizer-grade: real cap toggle is flat `ai_credit_pool_enabled`, not nested `included_usage_cap` (inference #2). |
| M8 | `POST …/cost-centers/{id}/resource` | 4.2 add members | Cost centers REST `2026-03-10` | `simulation-enrichment` | **Request-body divergence:** real body is four optional string arrays `{users, organizations, repositories, enterprise_teams}`; MSW takes `{resources:[{type,name}]}` (inference #1). **Response divergence:** real `200 {message, reassigned_resources}`; MSW returns `201` + recomputed `computed_limit_credits` (inference #4 — deliberate, task-required). Reconcile request-body in github-impl at 9.2. |
| M9 | `DELETE …/cost-centers/{id}/resource` | 4.2 remove members | Cost centers REST `2026-03-10` | `simulation-enrichment` | Same four-array request shape as M8 (DELETE-with-body is **valid/documented** here — resolves inference #1's DELETE-with-body concern). MSW `200` + recomputed limit (enrichment, inference #4). |

**Error envelope (all mutations).** MSW uses GitHub's *conventional* REST error
shape `{message, documentation_url, errors:[{resource, field, code}]}` with
`400` (bad JSON), `422` (validation), `404` (unknown id). The billing-preview
endpoints do **not** publish an exact 422 schema in the docs, so this is
`convention-based` — pin the real 422 body against a live failure at 9.2
(inference #6).

### Auth surface (new — Task 9.1 `validatePat`)

| # | Method + path | Consumer | Doc source | Verdict | Deviation / note |
|---|---|---|---|---|---|
| A1 | `GET /rate_limit` (read `X-OAuth-Scopes` response header) | `github-impl` `validatePat` | GitHub REST auth docs: "OAuth/classic tokens return the `X-OAuth-Scopes` header on authenticated requests"; `/rate_limit` "does not count against your rate limit" | `docs-indicated (summarizer)` | **Hand-wrapped header interpretation (§6.9).** `validatePat` classifies the stored PAT by presence/absence of the `X-OAuth-Scopes` response header: **present → classic PAT** (scopes = the comma-split list; `hasManageBillingEnterprise` = list includes `manage_billing:enterprise`); **absent → fine-grained** (`github_pat_` tokens don't carry it); **`401` → invalid**. `/rate_limit` is the probe because the docs state it does not consume rate-limit budget and it returns the scopes header for classic tokens. The MSW `/rate_limit` twin (`handlers.ts`) reproduces this branching deterministically off the bearer token. **Pin at 9.2:** confirm against a live classic PAT that (a) `X-OAuth-Scopes` is actually returned on `/rate_limit`, (b) fine-grained tokens omit it, and (c) the exact scope string is `manage_billing:enterprise`. The scope *string* the enterprise billing endpoints require is CLAUDE.md §4's standing fact; the header *mechanism* is the summarizer-grade part.

### Read smoke runner (new — Task 9.2-prep)

`packages/data/src/smoke/read-smoke.ts` (`runReadSmoke`) issues one read against
each of the **existing** §6.9 read rows **R1–R6** above (no new endpoints — it is
the shape-reconciliation harness the 9.2 checklist is executed *through*) and
structurally checks each response against the shapes `github-impl.ts` parses. It
is refused in simulation mode at the `ApiClient.runLiveReadSmoke()` bridge
(never contacts GitHub); its per-endpoint `{status, details}` report is the
concrete Task 9.2 work order. The endpoint list lives in one place
(`INDEPENDENT_ENDPOINTS` + the R3 dependent read) with the `docRef` on each row
pointing back at this table.

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

- **2b — user-level scope model.** Real GitHub uses a **single `budget_scope:
  "user"`** plus a separate **`user` (username)** field: *universal* = `user` scope
  with no/empty username; *individual* = `user` scope with a username. MSW invents
  **two scope enum values `universal` / `individual`** and has no `user` field.
  Corroborated across both budget reads. → Defer to 9.2 (the plan explicitly
  anticipates this: "Lazy universal-ULB records reconciled against full
  licensing"). github-impl must map universal/individual → `user` scope + `user`
  field on live writes.
- **CCULB scope enum — UNRESOLVED.** PRD §2.1 says `multi_user_cost_center`; MSW
  uses `multi_user_cost_center`; the doc summarizer returned **contradictory**
  values (`multi_user_cost_center` vs `multi_user_customer`, once both). One
  targeted OpenAPI-line search did not converge. → **`PRD-authority`: MSW follows
  the PRD (`multi_user_cost_center`); pin against the OpenAPI schema / a live POST
  at 9.2.** **Watch-item for Task 4.10** (it POSTs the CCULB payload "verbatim per
  PRD §2.1"): if 9.2 finds `multi_user_customer`, both the MSW handler set **and**
  4.10's asserted payload change together.
- **budget_amount type.** Real docs say integer whole USD; MSW accepts any finite
  `>= 0` (incl. `$0` — correct, the documented trap — and, more permissively,
  floats). Harmless (more permissive); optionally tighten at 9.2.
- **Task 5.1 — usage/users-28-day query-param filtering.** Added `year`/`month`
  /`day` support to the R5 usage handler and `since`/`until` to the R6
  users-28-day handler, so historical fixtures (`fixtures/usage-history.ts`)
  can be surfaced on request without changing either endpoint's default
  (no-param) response or its response wire shape. These param names match
  real GitHub's documented enhanced-billing usage-report query parameters
  (`year`/`month`/`day`/`hour`) — request-side only, no new response field,
  so this doesn't change either row's read-shape verdict above.
- **Task 5.4 — `github-impl.ts` now SENDS `year`/`since`.** The Task 5.1 note
  above ("github-impl.ts does not send them yet") is superseded: Task 5.4's
  forecast-on-sync consumer (`fetchHistoricalUsageItems`/
  `fetchHistoricalCreditsUsedItems`, `packages/data/src/api-client/
  github-impl.ts`) now sends `year` (R5, whole current year — MSW resolves
  this as the open cycle unioned with the 3 prior closed cycles) and `since`
  (R6, 3 calendar months before the current cycle start, computed from
  `cycleBounds`, never hardcoded) on every `syncNow`. Both remain request-side
  only — the response wire shape these two calls parse is byte-identical to
  R5/R6's existing (no-param) shape, so neither row's read-shape verdict
  changes. Confirm the exact parameter set (and that real GitHub accepts a
  bare `year` with no `month`, and `since` with no `until`) against the
  OpenAPI schema at 9.2 alongside R5/R6's existing "pin at 9.2" items.

---

## Task 9.2 reconcile checklist (carry-forward)

When a live tenant + classic PAT (`manage_billing:enterprise`) exist, upgrade the
rows above to "confirmed against live" and fix github-impl (and MSW fixtures where
sim truthfulness needs it) for:

1. **Cap wire shape** — `ai_credit_pool_enabled` + `ai_credit_pool_state` ↔ internal
   `included_usage_cap{enabled, overflow, computed_limit_credits}`; **resolve the
   block-vs-overflow field name** (undocumented today).
2. **Resource mutations** — four-array request body `{users, organizations,
   repositories, enterprise_teams}`; real `200 {message, reassigned_resources}`.
3. **Budget success envelopes** — `200 {message, budget}` (create/patch),
   `200 {message, id}` (delete) vs MSW `201`/flat/`204`.
4. **User-scope model** — single `user` scope + `user` field vs MSW
   `universal`/`individual`.
5. **CCULB enum** — `multi_user_cost_center` vs `multi_user_customer` (also gates
   Task 4.10's verbatim payload).
6. **Budget list pagination** — in-body `{total_count, has_next_page}` vs MSW `Link`
   header.
7. **Usage path** — `…/billing/ai_credit/usage` / `…/usage/summary` (PRD §2.3) vs
   MSW `…/billing/usage`.
8. **Error/422 body** — pin the real validation-error schema.
9. **OpenAPI pass** — parse `github/rest-api-description` for the `2026-03-10`
   billing schemas to replace every `docs-indicated (summarizer)` grade above with
   machine-verified shapes.
10. **Auth surface (A1)** — confirm against a live classic PAT that `/rate_limit`
    returns `X-OAuth-Scopes`, that fine-grained tokens omit it, and that the
    required scope string is exactly `manage_billing:enterprise`. Then run
    `runLiveReadSmoke()` for real and upgrade R1–R6 from `docs-indicated
    (summarizer)` to "confirmed against live" using its report.

## Sources consulted (2026-07-05)

- Budgets REST reference (`2026-03-10`): `docs.github.com/en/rest/billing/budgets?apiVersion=2026-03-10` (+ `enterprise-cloud@latest` / `free-pro-team@latest` variants).
- Cost centers REST reference (`2026-03-10`): `docs.github.com/en/enterprise-cloud@latest/rest/billing/cost-centers`.
- Copilot concept: `docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing`.
- Changelog: "Cost centers now support included usage caps" (2026-07-02), "Per-user AI credit budgets available for cost centers" (2026-06-30), "GitHub Copilot is moving to usage-based billing" (github.blog).
- Not parsed: `github/rest-api-description` OpenAPI (size) — the §6.9-preferred source; deferred to the 9.2 OpenAPI pass.
