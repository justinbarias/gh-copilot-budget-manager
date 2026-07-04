# Spec: Copilot Budget Manager — MVP (Phase 1–2: Simulation Harness + Read-Only Observability)

**Status:** Draft for review
**Parent docs:** `docs/copilot-budget-manager-prd-spec.md` (v0.2, full product), `CLAUDE.md` (architecture, locked), `design/README.md` + `design/Copilot Budget Manager v2.dc.html` (delivered UI handoff)

This spec scopes an **MVP slice** of the full PRD: enough to validate the architecture and demonstrate real value, without building the control-administration, forecasting, or auto-balancing engine yet. Those remain specified in the PRD/CLAUDE.md for later phases — this document doesn't restate or replace them.

---

## Objective

**What:** A local-first Electron desktop app (TypeScript end-to-end) that a GitHub Copilot admin can open, toggle into simulation mode (default, no PAT required), run "Sync now" to pull a usage report from a mocked GitHub API into local SQLite, and see three read-only dashboards: **pool burn-down**, **per-cost-center spend**, and **heavy users**.

**Why:** The PRD's centerpiece (auto-balancing) and its control-administration surface are both high-value but high-risk to build first — they require guardrails, approval flows, and a fully-modeled write path. Before investing there, this MVP proves out the foundation everything else depends on: the monorepo/portability seams (`core` pure, `data` behind interfaces, `ui` behind a preload bridge), the MSW mock as single source of truth, PAT capture via `safeStorage`, and the Playwright + Chrome MCP verification gate — while shipping something an admin can already get value from (visibility into a fragmented, partly-buggy native control surface).

**Who:** The 2–3 non-developer GitHub admins named in CLAUDE.md's charter. For MVP they are read-only observers of their own billing data; they cannot yet fix anything through this tool.

**Explicitly excluded from this MVP** (deferred to later phases per CLAUDE.md §8 / PRD §4.8):
- Control administration (ULB/spending-limit/included-usage-cap CRUD, ULB-bug repair) — Phase 3
- Forecasting (run-rate, P50/P90, the 1 Sep cliff, backtest) — Phase 4
- Auto-balancing, both rebalancers — Phase 5–6
- Chargeback + audit export — Phase 7
- Any live GitHub network call — deferred until a PAT exists; MVP is verified against MSW only

## Assumptions (confirm or correct)

1. **Org shape:** built against the superset case — GitHub Enterprise on GHE.com, cost centers in use, "AI credit paid usage" enabled — so MSW fixtures exercise CCULBs, included-usage caps, and metered-phase concepts even though MVP doesn't yet act on them. This is a deliberate choice per your answer, not a real answer to CLAUDE.md §9's open questions — those still need answering before Phase 3 (control writes) can target your actual tenant.
2. **Live-tenant validation is out of scope for "MVP done."** PAT capture + `safeStorage` + the live/simulation toggle are built now (their seam is foundational and Phase 3 needs them immediately), but the runtime is never required to make a real call to `api.github.com` / `*.ghe.com` for MVP acceptance — the verification gate is MSW-only.
3. **Overview screen is scoped down from the full design handoff.** `design/README.md`'s Overview screen includes forecast P50/P90 bands and a projected-exhaustion marker on the burn-down chart — that's Phase 4 (Forecasting) content layered onto the same screen. MVP renders the same chart component and visual language, but only the **actual cumulative burn** line from ingested data; the forecast overlay, exhaustion marker, and "Forecast-lens toggle" render as visually-present-but-disabled until Phase 4 wires real forecasts in. Runway tiles show cycle-to-date facts (days elapsed, pool % consumed), not projected block dates.
4. **Users and Cost centers screens are read-only in MVP.** The design handoff's row actions ("Set ULB", cost-center reassignment `<select>`, "+ New cost center") are control-administration writes (Phase 3) and are hidden/disabled for MVP, not built.
5. **Nav shell shows all 9 screens** (Overview, Forecast, Controls, Auto-balance, Cost centers, Users, Chargeback, Audit, Settings, Help) per the design handoff's IA, but only Overview / Cost centers / Users / a trimmed Settings (token health + sim toggle only) are functional. The rest render as visible "coming soon" stubs behind the same navigation — so later phases slot in without reshaping the shell.
6. **Architecture note:** PRD §4.1/§4.5 describe a `.NET`-on-Azure-Container-Apps architecture; the PRD itself flags (§4.7 footnote) that this predates the Electron/TypeScript pivot now locked in CLAUDE.md §2. This spec follows CLAUDE.md — Electron + TypeScript, local-first, no server — as the current architecture.
7. **Design tokens come directly from `design/README.md`'s "Design tokens" section** (exact hex values, Mona Sans, Primer-adjacent palette). CLAUDE.md §0 anticipated a "Claude Design handoff package... and `apex` design tokens" arriving in `design/`; what actually arrived defines its own token table directly rather than naming a separate `apex` package. Flagging this per CLAUDE.md's own "if in conflict, flag it" rule — treating the delivered `design/README.md` as authoritative for MVP UI, since CLAUDE.md §0 also says "implement the UI against it."
8. No fixed deadline was specified; task granularity in the follow-on Plan/Tasks phases will assume no hard timebox unless you say otherwise.

---

## Tech Stack

Pinned by CLAUDE.md §4 (do not deviate without discussing):

- **Language:** TypeScript, `strict: true`, no `any` without a comment justifying it.
- **Runtime/tooling:** Node 22 LTS, **pnpm workspaces** (not npm/yarn/Bun — Electron's bundled Node + native-module ABI requirements rule out Bun).
- **Shell:** Electron + `electron-builder`; `contextIsolation` + `sandbox` on, `nodeIntegration` off, no remote content.
- **UI:** Vite + React + TypeScript, matching `design/README.md`'s component/token spec. Charting: an SVG-based approach per the design handoff's "signature components" (burn-down chart, meters) — implement as hand-rolled SVG or a lightweight lib (visx/Recharts); no dependency added without checking first (see Boundaries).
- **Persistence:** Drizzle ORM over `better-sqlite3`, recompiled against Electron's ABI via `@electron/rebuild` (wired into `postinstall`). DB under `app.getPath('userData')`.
- **GitHub client:** Octokit, main process only, read endpoints wired for MVP (usage/cost reporting, budgets list, cost centers list — see PRD §2.3, §2.2). No mutation endpoints called in MVP (none are needed — no writes exist yet).
- **PAT storage:** Electron `safeStorage`, main process only, never logged, never in the renderer.
- **Testing:** Vitest (unit/component), MSW (single mock source of truth for sim mode + e2e + unit tests), Playwright (e2e vs MSW, headless, the automated gate), Chrome MCP (interactive verification of the running app).

## Commands

```
pnpm install                # install all workspace deps; triggers postinstall @electron/rebuild
pnpm dev                    # electron + vite dev; simulation mode by default (no PAT present)
pnpm dev:sim                # force simulation mode regardless of stored PAT
pnpm test                   # vitest — unit/component, all packages
pnpm --filter core test     # vitest scoped to packages/core
pnpm e2e                    # playwright e2e against MSW — the blocking automated gate
pnpm e2e:ui                 # playwright interactive runner
pnpm build                  # build all packages (core, data, ui)
pnpm package                # electron-builder -> signed installer (not required for MVP acceptance)
```

## Project Structure

```
packages/
  core/            # pure TS, no I/O — Vitest covers 100% of money/percentage math
    burndown.ts    # cumulative burn %, pool-consumed %, days-elapsed calc
    ranking.ts     # heavy-user ranking / sort
    snapshot.ts    # snapshot diffing helpers (append-only invariant enforcement)
  data/
    api-client.ts       # ApiClient interface — the only thing packages/ui talks to
    github/              # Octokit wrapper, main-process only, read endpoints for MVP
    msw/
      handlers.ts        # GET handlers: usage, budgets (read), cost centers, licenses
      fixtures/           # versioned fixtures incl. edge cases (ULB display-bug entry,
                          #   $0-ULB, cap-bound cost center, promo->standard cliff data)
    db/
      schema.ts          # Drizzle schema: snapshot, usage_fact, credits_used_fact,
                          #   license, cost_center, cost_center_member, budget
      migrations/
    pat/
      storage.ts          # safeStorage wrapper interface
  ui/              # Vite + React + TS
    screens/
      Overview/           # pool burn-down (actual-only), runway tiles, alerts list
      CostCenters/        # read-only table + drill modal
      Users/               # read-only heavy-user table
      Settings/            # token health card + sim/live toggle only
      _stubs/              # Forecast, Controls, Auto-balance, Chargeback, Audit,
                            #   Help — nav-visible "coming soon" placeholders
    components/           # burn-down chart, meter, sparkline, model-mix bar
    lib/api-client-context # React context wrapping the ApiClient interface
apps/
  desktop/
    main/                # wires packages/data + packages/core; owns PAT, DB, Octokit
    preload/             # exposes the bridge — the only thing renderer can reach natively
    renderer/            # hosts packages/ui
e2e/
  *.spec.ts              # Playwright specs, one per user-visible flow
```

No `apps/server` or `apps/web` yet — CLAUDE.md keeps their seams clean for later, nothing to build now.

## Code Style

**The portability rule is the one style rule that matters most here** (CLAUDE.md §2): `packages/ui` never imports Electron, `better-sqlite3`, Octokit, or `fs` — only the `ApiClient` interface.

```ts
// packages/data/api-client.ts — the only surface packages/ui is allowed to depend on
export interface ApiClient {
  getUsageSummary(range: DateRange): Promise<UsageSummary>;
  listCostCenters(): Promise<CostCenter[]>;
  listHeavyUsers(limit: number): Promise<HeavyUser[]>;
  getSyncStatus(): Promise<SyncStatus>;
  syncNow(): Promise<void>;
}
```

```ts
// packages/core/burndown.ts — pure, no I/O, this is what gets Vitest coverage
export function poolConsumedPct(consumed: number, poolSize: number): number {
  if (poolSize <= 0) return 0;
  return Math.min(1, consumed / poolSize);
}
```

- Naming: `camelCase` functions/variables, `PascalCase` components/types/interfaces, filenames match the primary export.
- One-line comments only, and only where a non-obvious constraint exists (e.g., why a snapshot table is append-only). No block comments, no restating what a well-named function already says.
- Prefer existing, popular libraries over bespoke implementations (standing project preference) — flag before adding a new dependency (see Boundaries).

## Testing Strategy

- **Vitest** — unit tests for every function in `packages/core` (pure, so this should be near-100% coverage) and contract tests for `packages/data`'s MSW handlers (right shape, right status codes, pagination behaves).
- **MSW is the single source of truth** — the same handlers + fixtures back simulation mode at runtime, Playwright e2e, and Vitest. No separate "test-only" mock data.
- **Playwright e2e (headless, vs MSW)** — the blocking automated gate. Minimum specs for MVP:
  - App boots into simulation mode by default (no PAT stored).
  - PAT capture round-trip (mocked `safeStorage` in test env) + toggling the sim/live banner.
  - "Sync now" pulls from MSW → snapshot rows land in SQLite (assert via a data-layer check, not UI polling).
  - Overview renders pool burn-down (actual line only), runway tiles, and alerts from fixture data.
  - Cost centers screen renders the fixture list + drill modal contents.
  - Users screen renders the fixture heavy-user list, sorted correctly.
  - Stub screens (Forecast/Controls/Auto-balance/Chargeback/Audit/Help) render as visibly disabled, not broken links.
- **Chrome MCP** — interactive verification of the actual running app for every change in this MVP; confirms rendering + behavior Playwright can't (visual banner unmistakability, real Electron chrome).
- **Both green = done**, per CLAUDE.md §6.7, for every change — no exceptions for "just a UI tweak."

## Boundaries

**Always do:**
- Keep `packages/core` free of I/O — if a function needs to read a file or call an API, it doesn't belong there.
- Keep the MSW mock as the only fixture source for sim mode + e2e + unit tests — never hand-roll separate test fixtures that could drift.
- Keep the simulation-mode banner persistent and unmistakable whenever no real GitHub call is possible (which, for this MVP, is always).
- Store the PAT only via `safeStorage` in the main process; never log it, never pass it to the renderer, never write it to config files.
- Treat GitHub's snapshot data as append-only — no updates/deletes to historical snapshot rows.
- Run the Playwright + Chrome MCP gate before calling any task in this MVP "done."

**Ask first:**
- Adding any new dependency (charting lib, table primitive, etc.) — confirm the choice, per the standing "prefer popular libraries" preference, before installing.
- Any change to the Drizzle schema once the first migration is committed.
- Any change to the design handoff's specified tokens/layout, or filling a design gap not covered by `design/README.md` — CLAUDE.md §0 says not to invent visual design; ask rather than guess.
- Adding any new preload-bridge method (it's a permanent seam — get it right once).

**Never do:**
- Import Electron, `better-sqlite3`, Octokit, or `fs` directly in `packages/ui`.
- Let any request reach real `api.github.com` / `*.ghe.com` as part of MVP acceptance — verification is MSW-only; live-tenant sync is explicitly a fast-follow, not part of this spec.
- Build or expose any control-write affordance (Set ULB, new cost center, cap toggle, etc.) in MVP screens — even disabled-but-present is fine per the stub convention, but no working write path.
- Skip either half of the verification gate — Playwright-only or Chrome-MCP-only is not "done."
- Fabricate visual design for screens not yet covered by the handoff — stub behind the same interface instead (CLAUDE.md §0).

## Success Criteria

1. `pnpm install && pnpm dev` launches the Electron app in simulation mode by default; no PAT is required to see data.
2. PAT capture screen exists; entering a PAT stores it via `safeStorage` (verified not present in plaintext anywhere — config, logs); toggling simulation↔live is reflected in a persistent, unmistakable banner.
3. MSW models (per PRD §4.7): usage facts by model/user/cost-center, `credits_used_fact`, licenses, cost centers + membership, budget list (read-only), pooled-draw + two-phase routing shape, ULB precedence data, the non-settable included-usage cap as a read-only computed value, pagination — plus the edge fixtures (ULB display-bug entry, `$0`-ULB, cap-bound cost center, promo→standard cliff datapoints) even though MVP doesn't act on them yet, so Phase 3 doesn't need to reshape fixtures.
4. "Sync now" (IPC → main process) pulls a usage report from MSW and writes append-only snapshot rows into SQLite via the Drizzle schema; deterministic and resettable across runs.
5. Three screens render from ingested snapshots: **Overview** (actual-only pool burn-down, cycle-to-date runway tiles, alerts/anomalies list from fixtures), **Cost centers** (read-only table + drill modal), **Users** (read-only heavy-user table with sparkline + model-mix bar).
6. `packages/core` contains the pure math the dashboards need (burn %, ranking) with Vitest coverage.
7. Playwright e2e (headless, MSW-backed) covers the flows listed under Testing Strategy and passes.
8. Chrome MCP interactive pass confirms the same flows in the actual running app, including that the simulation banner is genuinely unmistakable.
9. Zero live GitHub network calls occur anywhere in the verification run — everything is MSW-intercepted.
10. Nav shell shows all 9 IA items; the 6 out-of-scope screens are visibly present but clearly disabled, not missing or broken.

## Open Questions

- CLAUDE.md §9's five gating questions (Enterprise vs Business + host, paid-usage policy, cost centers in use, pool posture, auto-apply appetite) are **not** answered by this MVP — they're assumed toward the superset case for fixture richness (see Assumption 1) but need real answers before Phase 3 targets your actual tenant.
- No deadline/timebox given — flag if one exists so the follow-on Plan/Tasks breakdown sizes correctly.
- Charting approach (hand-rolled SVG vs. visx/Recharts) is left open pending the "ask first" dependency conversation in Boundaries.
- Whether Phase 3+ eventually needs the `ApiClient` interface to pre-declare write method signatures now (to avoid a breaking change later) vs. adding them when Phase 3 starts — left as a Phase 3 planning concern, not decided here, to avoid designing for hypothetical future requirements prematurely.
