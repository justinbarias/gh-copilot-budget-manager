# Implementation Plan: Copilot Budget Manager MVP

**Source spec:** `SPEC.md` (Phase 1–2 of CLAUDE.md §8 / PRD §4.8: simulation harness + read-only observability)

## Overview

Sixteen tasks across four phases, ordered bottom-up by dependency and sliced vertically by user-visible capability where possible. Phase 0 stands up the monorepo/Electron shell with nothing user-visible yet. Phase 1 delivers the simulation harness — the CLAUDE.md Phase-1 smoke test ("Sync now" pulls MSW data into SQLite). Phase 2 delivers the three read-only dashboards. Phase 3 is verification hardening against every Success Criterion in `SPEC.md`. Every task from Phase 1 onward carries its own Playwright spec as it's built, satisfying the CLAUDE.md §6.7 per-change gate incrementally rather than in one pass at the end.

## Architecture Decisions

- **MSW interception happens in the main process, via `msw/node`'s `setupServer` — never a browser service worker.** Octokit runs main-process-only (the PAT never reaches the renderer), so that's where requests need intercepting. The app runs the *same* Octokit code path in simulation and live modes; only whether the `msw/node` listener is attached differs. Consequently, **Playwright e2e must launch the actual Electron app via `_electron.launch()`** with simulation mode forced, not drive a standalone browser test page — otherwise the interception path being tested isn't the one that runs in production.
- **Pool size / allowance and cycle boundaries are pure functions in `packages/core`**, not a new DB table: `poolAllowanceCredits(licenseCount, asOfDate, allowanceBasis)` and `cycleBounds(asOfDate)`, derived from ingested license count + the documented promo→standard rule (1 Sep 2026 cliff). This mirrors how the included-usage cap is "auto-computed from licenses, not dial-able" elsewhere in the domain model, and avoids inventing a `billing_cycle` fixture/table MVP doesn't otherwise need.
- **Any `packages/core` function depending on "now" takes it as an explicit `asOfDate` parameter** — never `new Date()`/`Date.now()` internally. Required for purity (CLAUDE.md §2) and for deterministic fixtures/e2e (PRD §4.7).
- **DEWR division/branch/project mapping lives as columns directly on the `cost_center` row** for MVP — not a separate `dewr_mapping` table. Simplest shape that satisfies the Cost Centers screen; revisit only if a later phase needs the mapping to have its own independent lifecycle.
- **Alerts/anomalies in Overview are pre-baked MSW fixture data**, surfaced via a new `ApiClient.listAlerts()` read method — not derived from `syncNow`/ingested snapshots. Anomaly detection is explicitly a later-phase capability (PRD FR17); MVP just displays what the fixtures say. This is a small, additive extension to the `ApiClient` interface in `SPEC.md`'s Code Style section — noted here rather than reopening that review.

## Task List

### Phase 0: Foundation

- [x] **Task 0.1: pnpm workspace scaffold** — S/M
  - **Description:** Root `package.json` + `pnpm-workspace.yaml`; `packages/{core,data,ui}` and `apps/desktop` each with a minimal `package.json` + `tsconfig.json` extending a shared `tsconfig.base.json`.
  - **Acceptance:** `pnpm install` succeeds from repo root; workspace resolves internal package references (e.g. `@copilot-budget/core`).
  - **Verification:** `pnpm install && pnpm -r run build` (stub builds) exits 0.
  - **Dependencies:** None.
  - **Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, each package's `package.json`/`tsconfig.json`.

- [x] **Task 0.2: Electron shell + Vite/React renderer boots** — M
  - **Description:** `apps/desktop` main process opens a `BrowserWindow` (`contextIsolation`+`sandbox` on, `nodeIntegration` off); preload stub exposes an empty bridge; `packages/ui` is a Vite+React app the renderer loads.
  - **Acceptance:** `pnpm dev` opens an Electron window rendering a placeholder page; zero Electron/Node imports exist in `packages/ui` source.
  - **Verification:** Chrome MCP confirms the window opens and renders; `pnpm build` produces a renderer bundle with no errors.
  - **Dependencies:** 0.1.
  - **Files:** `apps/desktop/main/index.ts`, `apps/desktop/preload/index.ts`, `packages/ui/src/main.tsx`, `packages/ui/src/App.tsx`, electron-vite config.

**Checkpoint 0:** `pnpm install` and `pnpm dev` both work; empty shell boots; no package-boundary violations. Review before Phase 1.

---

### Phase 1: Simulation harness (= CLAUDE.md Phase 1)

- [x] **Task 1.1: `packages/core` pure math — burndown, ranking, pool allowance, snapshot diff** — S/M
  - **Description:** `poolConsumedPct`, `cycleBounds(asOfDate)`, `poolAllowanceCredits(licenseCount, asOfDate, allowanceBasis)` (promo→standard cliff at 1 Sep 2026), heavy-user ranking sort, and a snapshot-diff helper enforcing append-only. **Every function needing "now" takes `asOfDate` as an explicit parameter** — no internal `Date.now()`.
  - **Acceptance:** Vitest covers edge cases (poolSize=0, empty user list, ranking ties, dates on either side of the 1 Sep cliff); zero I/O imports anywhere in the package.
  - **Verification:** `pnpm --filter core test` green.
  - **Dependencies:** 0.1.
  - **Files:** `packages/core/src/burndown.ts`, `ranking.ts`, `poolAllowance.ts`, `snapshot.ts` + matching `*.test.ts`.

- [x] **Task 1.2: Drizzle schema + migrations for MVP entities** — M
  - **Description:** `snapshot`, `usage_fact`, `credits_used_fact`, `license`, `cost_center` (with `dewr_division`/`dewr_branch`/`dewr_project` columns folded in), `cost_center_member`, `budget` (read-only fields). DB path under `app.getPath('userData')` with a dev override.
  - **Acceptance:** `drizzle-kit generate` produces a migration creating all 7 tables; a smoke script inserts/reads a row per table.
  - **Verification:** `pnpm --filter data test` (schema test) + migration applies cleanly against a fresh sqlite file.
  - **Dependencies:** 0.1.
  - **Files:** `packages/data/db/schema.ts`, `packages/data/db/migrations/0000_init.sql`, `packages/data/db/client.ts`.

- [x] **Task 1.3: MSW handlers + fixtures — shared across 3 consumers, incl. edge fixtures** — M
  - **Description:** GET handlers for usage/cost reporting, cost centers + membership, licenses, budget list. Structure as **shared handler definitions** consumed by three bootstraps: (a) `msw/node` `setupServer` attached in the Electron **main process** for the simulation runtime, (b) the same `setupServer` for Vitest contract tests, (c) Playwright reuses (a) by launching the real app (see 1.5). Include the 4 edge fixtures required by `SPEC.md` Success Criterion #3: ULB display-bug entry, `$0`-ULB, cap-bound cost center, promo→standard cliff datapoints.
  - **Acceptance:** Handlers respond with realistic pagination; all 4 edge fixtures present even though nothing renders them yet.
  - **Verification:** `pnpm --filter data test` contract test hits each handler, asserts shape + pagination.
  - **Dependencies:** 0.1.
  - **Files:** `packages/data/msw/handlers.ts`, `packages/data/msw/fixtures/*.ts`, `packages/data/msw/server.ts`.

**Checkpoint 1a:** `pnpm test` green across core/data; schema migrates cleanly; MSW handlers verified in isolation. Quick review before wiring together.
- [x] Reached — 1.1, 1.2, 1.3 all complete.

- [x] **Task 1.4: PAT capture + `safeStorage` wrapper + sim/live mode resolver** — M
  - **Description:** `packages/data/pat/storage.ts` behind a `get/set/clear` interface, backed by Electron `safeStorage` in `apps/desktop/main`. Main-process mode resolver: PAT present + simulation off → live-mode branch (wired, unused until a real PAT/tenant exists); otherwise simulation (msw/node attached).
  - **Acceptance:** Stored PAT is verified not present in plaintext anywhere on disk; clearing works; mode is queryable via IPC.
  - **Verification:** Vitest with mocked `safeStorage`; Chrome MCP confirms no plaintext PAT in any log output.
  - **Dependencies:** 0.2, 1.2.
  - **Files:** `packages/data/pat/storage.ts`, `apps/desktop/main/pat-bridge.ts`, `apps/desktop/main/mode.ts`, `apps/desktop/preload/index.ts`.

- [x] **Task 1.5: `ApiClient` interface + MSW-backed implementation + preload bridge** — M
  - **Description:** Define `ApiClient` (`getUsageSummary`, `listCostCenters`, `listHeavyUsers`, `listAlerts`, `getSyncStatus`, `syncNow`). Implement against the main-process `msw/node` listener from 1.3. Wire through the preload bridge so `packages/ui` calls it with zero Electron/Node imports.
  - **Acceptance:** A renderer call to any `ApiClient` method round-trips through preload → main → MSW → back with correct typing.
  - **Verification:** Playwright spec **launches the real Electron app via `_electron.launch()`** with simulation mode forced, calls one `ApiClient` method through the UI, asserts the MSW-shaped response arrives — not a standalone browser page.
  - **Dependencies:** 1.3, 1.4.
  - **Files:** `packages/data/api-client.ts`, `packages/data/api-client-msw-impl.ts`, `apps/desktop/preload/index.ts`, `apps/desktop/main/ipc.ts`.

- [x] **Task 1.6: "Sync now" ingests MSW data into SQLite snapshots** — M
  - **Description:** `syncNow()` pulls usage/cost-center/license data via the `ApiClient` and inserts new append-only snapshot rows into the Task 1.2 schema (never overwrites existing rows). `getSyncStatus()` reports last-synced-at / in-progress.
  - **Acceptance:** Two `syncNow()` calls produce two distinct snapshot generations; a fresh DB + one call matches ingested fixture data exactly.
  - **Verification:** `pnpm --filter data test` integration test — this is the CLAUDE.md Phase-1 smoke test.
  - **Dependencies:** 1.2, 1.5.
  - **Files:** `packages/data/sync/sync-now.ts` + test.

- [x] **Task 1.7: Sim-mode banner + Settings screen (token health, Sync Now button, PAT entry)** — S
  - **Description:** Persistent, unmistakable simulation banner (visible whenever not in a verified live+PAT state — i.e., always, for MVP). Settings screen: PAT entry wired to 1.4's bridge, and a real **Sync Now button** wired to 1.6 (not a dev-only hook — this is the human-operable trigger).
  - **Acceptance:** Banner visible on every screen; PAT entry reflects stored/cleared state; Sync Now button triggers ingestion and updates sync status; styling matches `design/README.md` tokens.
  - **Verification:** Playwright spec drives PAT entry + Sync Now, asserts banner text/visibility and updated status. Chrome MCP confirms the banner reads as genuinely unmistakable.
  - **Dependencies:** 1.4, 1.6, 0.2.
  - **Files:** `packages/ui/src/components/SimBanner.tsx`, `packages/ui/src/screens/Settings/TokenHealth.tsx`, `packages/ui/src/lib/api-client-context.tsx`.

**Checkpoint 1 (= CLAUDE.md Phase 1 done):**
- [x] `pnpm dev` boots to a screen with the sim banner and a working PAT + Sync Now flow.
- [x] Clicking Sync Now populates SQLite with snapshot rows from MSW.
- [x] `pnpm test` and `pnpm e2e` both green.
- [x] Chrome MCP confirms the above interactively. (Per CLAUDE.md §7, driven via raw CDP against the real Electron process, not the `mcp__chrome-devtools__*` browser-tab tool suite — see the live-CDP verification for Tasks 1.6/1.7.)
- Reached — Phase 1 complete. Proceeding to Phase 2 per maintainer instruction.

---

### Phase 2: Read-only observability (= CLAUDE.md Phase 2, MVP feature-complete)

- [ ] **Task 2.1: Overview screen — burn-down chart (actual-only) + runway tiles** — M
  - **Description:** Per `design/README.md` §1 and `SPEC.md` Assumption 3: actual cumulative burn line only (no forecast band/exhaustion marker); runway tiles show cycle-to-date facts using 1.1's `cycleBounds`/`poolConsumedPct`/`poolAllowanceCredits`, fed by ingested license count + the current date. Forecast-lens toggle renders present-but-disabled.
  - **Acceptance:** Chart renders real ingested-snapshot data via `getUsageSummary()`; tile math matches 1.1's unit-tested functions; disabled toggle is visibly non-interactive, not silently missing.
  - **Verification:** Playwright spec asserts chart points match fixture-derived expected values.
  - **Dependencies:** 1.1, 1.6, 1.5, 1.7.
  - **Files:** `packages/ui/src/screens/Overview/Overview.tsx`, `components/BurndownChart.tsx`, `components/RunwayTile.tsx`.

- [ ] **Task 2.2: Overview screen — alerts & anomalies list** — S
  - **Description:** Render the alerts list from **pre-baked MSW fixture data** via the new `ApiClient.listAlerts()` (see Architecture Decisions) — not derived from `syncNow`/ingested snapshots. No anomaly-detection logic in MVP.
  - **Acceptance:** List renders all fixture alert entries with correct severity styling; empty state handled.
  - **Verification:** Playwright spec checks item count/content against fixtures.
  - **Dependencies:** 2.1, 1.5.
  - **Files:** `packages/ui/src/screens/Overview/AlertsList.tsx`, `packages/data/api-client.ts` (add `listAlerts`), fixture addition in `packages/data/msw/fixtures/`.

- [ ] **Task 2.3: Cost Centers screen — read-only table + drill modal** — M
  - **Description:** Per `design/README.md` §5: Cost center | DEWR mapping (now columns on the row, per Architecture Decisions) | Members | MTD burn | Headroom | Status. Row click → drill modal. No "+ New cost center."
  - **Acceptance:** Table renders fixture cost centers with correct headroom color-coding; drill modal shows correct membership for a clicked row.
  - **Verification:** Playwright spec: load, assert values, click a row, assert modal contents.
  - **Dependencies:** 1.5, 1.6.
  - **Files:** `packages/ui/src/screens/CostCenters/CostCentersTable.tsx`, `DrillModal.tsx`.

- [ ] **Task 2.4: Users screen — read-only heavy-user table** — M
  - **Description:** Per `design/README.md` §6, read-only: login, cost center (display only), credits MTD, sparkline, model-mix bar, ULB (display only). Search + cost-center filter + status filter + pagination (10/page).
  - **Acceptance:** Renders fixture users ranked via 1.1's ranking function; search/filter/pagination function correctly; no write affordance present.
  - **Verification:** Playwright spec exercises search, filter, pagination.
  - **Dependencies:** 1.1, 1.5, 1.6.
  - **Files:** `packages/ui/src/screens/Users/UsersTable.tsx`, `components/Sparkline.tsx`, `components/ModelMixBar.tsx`.

- [ ] **Task 2.5: Nav shell + 6 stub screens** — S
  - **Description:** Full 9-item nav per the design handoff's IA. Overview/Cost Centers/Users/Settings route to real screens; Forecast/Controls/Auto-balance/Chargeback/Audit/Help show a consistent "coming soon" placeholder.
  - **Acceptance:** All 9 items clickable; 4 functional, 6 clearly-stubbed-not-broken, no console errors.
  - **Verification:** Playwright spec clicks each of the 9 items, asserts correct state.
  - **Dependencies:** 2.1, 2.3, 2.4, 1.7.
  - **Files:** `packages/ui/src/App.tsx`, `screens/_stubs/ComingSoon.tsx`, `components/Nav.tsx`.

**Checkpoint 2 (MVP feature-complete):**
- [ ] All three dashboards render real data pulled through Sync Now.
- [ ] Nav shows all 9 items; 6 clearly stubbed.
- [ ] `pnpm test` and `pnpm e2e` both green.
- Review with human before hardening.

---

### Phase 3: Verification hardening

- [ ] **Task 3.1: Coverage audit — every SPEC.md e2e bullet maps to a named spec** — S/M
  - **Description:** Since each Phase 1–2 task already ships its own Playwright spec (per CLAUDE.md §6.7's per-change gate), this is an **audit and gap-fill**, not a re-authoring: confirm every bullet in `SPEC.md`'s Testing Strategy has a 1:1 named spec, and write only the genuinely missing ones.
  - **Acceptance:** Full suite green headless; no SPEC.md e2e bullet without a corresponding spec.
  - **Verification:** `pnpm e2e` exits 0.
  - **Dependencies:** 2.5.
  - **Files:** `e2e/*.spec.ts` (additions only where gaps exist).

- [ ] **Task 3.2: Chrome MCP full-flow pass + fixture-completeness check** — S
  - **Description:** Drive every flow from 3.1 via Chrome MCP against the real running app, confirming what headless can't (banner unmistakability, token fidelity, disabled-state clarity). Separately confirm the 4 edge fixtures from Task 1.3 exist in `packages/data/msw/fixtures/` (Success Criterion #3 — they don't need to render yet, just exist).
  - **Acceptance:** Every flow confirmed correct interactively; all 4 edge fixtures present.
  - **Verification:** This task's execution is the verification — document pass/fail per flow.
  - **Dependencies:** 3.1.
  - **Files:** None expected, unless bugs surface.

**Checkpoint 3 (MVP done):**
- [ ] All 10 Success Criteria in `SPEC.md` met.
- [ ] Playwright + Chrome MCP both green for every flow.
- [ ] Zero live GitHub network calls observed anywhere in verification.
- Final review with human.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `better-sqlite3` ABI mismatch after Electron version bumps | Med | `@electron/rebuild` wired into `postinstall` (Task 1.2), per CLAUDE.md §4 |
| MSW fixtures drift once Phase 3+ (control admin) needs mutation handlers | Med | Full 7-entity schema + edge fixtures built now (Task 1.3) even though unused, precisely to avoid reshaping later |
| Preload bridge shape locked in before Phase 3's write methods are known | Med | Deliberately deferred (see `SPEC.md` Open Questions) — accepted risk, not solved by over-designing the interface now |
| Design token fidelity drifts from the `.dc.html` prototype | Low-Med | "Ask first" boundary in `SPEC.md` for any gap the handoff doesn't cover; reference `.dc.html` directly for exact values |
| `safeStorage` hard to test outside real Electron runtime | Low | Mock in Vitest per Electron testing conventions; final confirmation via Chrome MCP against the real app |

## Open Questions

- Charting approach (hand-rolled SVG vs. visx/Recharts) — still open per `SPEC.md`'s "ask first" dependency boundary; resolve before starting Task 2.1.
- "Existing customer" promo-eligibility flag (feeds `poolAllowanceCredits`'s allowance-basis) is assumed `true` for MVP fixtures, consistent with `SPEC.md`'s superset assumption — flag if your actual tenant differs.
- Carried from `SPEC.md`: CLAUDE.md §9's five gating questions remain unanswered; no deadline/timebox given.
