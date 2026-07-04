# CLAUDE.md — Copilot Budget Manager

Bootstrapper for Claude Code. Read this fully before writing any code. This is an internal FinOps tool for **2–3 non-developer GitHub admins** to govern GitHub Copilot AI-credit spend after the June 2026 usage-based billing change.

---

## 0. Read first (companion docs)

These are the source of truth. Do not re-derive their contents from memory — read them.

- `docs/copilot-budget-manager-prd-spec.md` — **the spec** (v0.2). Billing model, control surface, API inventory, requirements, auto-balancing engine. Authoritative for *what* to build and *how the domain works*.
- `docs/claude-design-handoff-copilot-budget-ui.md` — the design brief (IA, screens, principles).
- `design/` — **a Claude Design handoff package will be delivered here** (screens, component specs, and `apex` design tokens). **Implement the UI against it. Do not invent visual design.** If `design/` is not yet present, scaffold everything else and stub the UI with placeholder components behind the same interfaces; do not guess the visual language.
- `docs/controls-compare.html` — reference visual for the control model (open it to internalise the two-families + one-lever mental model).

If any instruction here conflicts with the spec, the spec wins — flag the conflict, don't silently pick.

---

## 1. What we're building

A **local-first Electron desktop app**, TypeScript end-to-end, that lets admins:
1. **Administer every GitHub Copilot budget control** from one reliable surface (the native UI is fragmented, two key controls are API-only, and GitHub's ULB UI has a display bug — see spec §1.4).
2. **Forecast** pool burn-down and metered spend, including the 1 Sep 2026 allowance cliff.
3. **Auto-balance in both phases** — the centrepiece (see §4 below and spec §4.4).

It is **not** a proxy, not the billing system of record, and does not expand the pool — it redistributes *access* to it.

**No PAT is available yet.** All development, demoing, and verification happens through **simulation mode** backed by an MSW mock of the GitHub API (§7). This is a first-class, shipped feature — not scaffolding to throw away.

---

## 2. Architecture (locked — do not revisit without asking)

- **Electron** shell, **not** Tauri. Rationale: TypeScript-only (no Rust seam), and the clean port path to full-stack web (Electron main process = future Node server). Bundle size is irrelevant at this audience.
- **Local-first:** the PAT is **user-provided in-app** and stored via Electron `safeStorage` (OS-backed, encrypted at rest). No central token, no cloud. Sync is an **explicit "Sync now" job** (IPC → main process), not a scheduler.
- **Portability is a first-class requirement.** Build it as a normal full-stack web app wrapped in a desktop shell so it ports later with a near-zero diff. The escape hatch if footprint ever matters is Tauri + a bundled Node sidecar (a shell swap, not a rewrite) — not our concern now.

### The portability rule (enforce this in every PR)

- The **UI touches native capabilities only through a preload bridge behind a TypeScript interface** — never `import`s Electron, `better-sqlite3`, Octokit, or `fs` directly.
- **`core` is pure** (no I/O) and runs identically in Electron main, a Node server, or a browser.
- **`data` sits behind interfaces**; the local (Electron) implementation is swappable for an HTTP implementation later without the UI noticing.

---

## 3. Monorepo layout

pnpm workspaces. Create:

```
packages/
  core/     # pure TS domain logic — forecasting, rebalancer envelope math,
            # budget diffing, binding-constraint resolution. NO I/O. Fully unit-tested.
  data/     # GitHub client (Octokit), persistence (Drizzle), PAT access — all behind interfaces.
  ui/       # Vite + React + TS. Standard web app. Talks to an ApiClient interface only.
apps/
  desktop/  # thin Electron shell: main process wires core+data, preload exposes the bridge,
            # renderer hosts packages/ui.
# later (do not build yet, but keep the seams clean for them):
#   apps/server  -> Fastify/Hono exposing core+data over HTTP
#   apps/web     -> serves packages/ui for the browser
```

The `apps/desktop` main-process wiring must be a thin adapter over `packages/data` + `packages/core`, so it lifts into `apps/server` verbatim.

---

## 4. Tech stack (pinned; deviate only with a stated reason)

- **Language:** TypeScript, `strict: true`, no `any` without justification.
- **Runtime & toolchain:** Node 22 LTS. **Package manager and task runner: pnpm (pnpm workspaces) — required, project-wide.** Do **not** use Bun (or npm/yarn) for install, scripts, or build. Rationale: Electron's main process runs on its own bundled Node runtime and native modules (`better-sqlite3`) are recompiled against Electron's ABI, so Bun's runtime is a non-starter here; standardising the whole toolchain on pnpm avoids a mixed lockfile/ABI mess. Commit `pnpm-lock.yaml`; use `pnpm install --frozen-lockfile` in CI. (If a Bun-native desktop stack is ever revisited, that's Electrobun territory and a separate decision — not this repo.)
- **Shell:** Electron + `electron-builder` (packaging, code signing, auto-update). Enable `contextIsolation`, `sandbox`, disable `nodeIntegration` in the renderer. **No remote content.**
- **UI:** Vite + React + TypeScript — unless the `design/` package specifies otherwise; match its component library and the `apex` tokens.
- **Persistence:** **Drizzle ORM** over `better-sqlite3` (local, synchronous). Drizzle chosen specifically so the driver swaps to Postgres or **libSQL** (`@libsql/client`) later with a config change and generated migrations, same schema. DB lives under `app.getPath('userData')`. Note: `better-sqlite3` is a native module — recompile it against Electron's ABI with `@electron/rebuild` (wire it into a `postinstall`), and rebuild after every Electron upgrade.
- **GitHub:** **Octokit** in the main process only. The PAT never reaches the renderer. Any endpoint touched outside Octokit's typed methods (hand-rolled requests) must clear the §6.9 API-surface validation gate before it's considered verified.
- **PAT storage:** Electron `safeStorage`. Never in config files, env, logs, or the renderer.
- **Testing & verification:** **Vitest** (unit/component; high coverage on `packages/core` — it's pure and it's where money-affecting math lives). **MSW (Mock Service Worker)** is the single fake GitHub API, shared by simulation mode, e2e, and unit tests. **Playwright** for e2e against MSW. **Chrome MCP** for agent-driven verification of the running app. See §7, and the verification gate in §6.

---

## 5. Domain facts you must get right

Verify against the spec; these are the ones that are easy to get subtly wrong.

- **Unit:** 1 AI credit = **$0.01 USD**. Completions/NES are free. Code review also burns Actions minutes (second meter).
- **Two phases:** pool phase (shared included credits) → metered phase ($0.01/credit, only if the "AI credit paid usage" policy is enabled; otherwise exhaustion **blocks**).
- **Control model — two families + one lever** (spec §1.3):
  - **User-level budgets (ULBs)** — cap a *person's total* across **both** phases, **always hard-stop**. Three scopes, most-specific wins: **individual > cost-center (CCULB) > universal**.
  - **Spending limits** (enterprise / org / cost-center budget) — cap **metered charges only**, hard-stop is **OFF by default**.
  - **Cost-center included-usage cap** — caps a team's **pool** draw before it tips to metered. **Not amount-settable:** GitHub auto-computes the limit from attributed licenses; the only knobs are `enabled: bool` + `overflow: block|metered`. No editable amount field in the model or UI — show the computed limit read-only.
  - **Lowest remaining headroom wins**: size ULBs and spending limits together.
- **API surface** (spec §2): API version header `X-GitHub-Api-Version: 2026-03-10`; enterprise endpoints need a **classic PAT with `manage_billing:enterprise`** (no App/fine-grained tokens); GHE.com swaps `api.github.com` → `api.SUBDOMAIN.ghe.com`.
- **API-only controls:** the **CCULB** (`budget_scope: "multi_user_cost_center"`) and the **included-usage cap** have no native GitHub UI. Surface them as first-class here.
- **ULB display bug:** GitHub's UI often fails to list ULBs. → **API-first for all writes**; treat GitHub's UI as read-only. Detect orphaned/hidden budgets and offer repair.
- **Auto-balancing** (spec §4.4): both rebalancers follow one pattern — *detect trigger → size a funding envelope → resolve each at-risk entity's binding constraint → allocate greedily by priority → **simulate** → apply the **most-specific** lever → track as a **grant** → revert/re-baseline at rollover.* Pool phase redistributes unconsumed pool access; metered phase redistributes unused enterprise/org headroom.
- **Pool-phase redistribution is ULBs only.** The binding-constraint resolver must branch by *type*: **ULB-bound** → grant a delta on the most-specific ULB (individual override = surgical and precedence-winning; CCULB = blunt, lifts the whole team's per-user ceiling). **Cap-bound** (team hit its included-usage cap) → **no grantable delta**; the only moves are disable the cap, overflow → metered, or re-attribute licenses. Cost-center *budgets* are metered-only and the cap doesn't grant, so ULBs are the entire pool-phase redistribution toolkit. Do not model the included-usage cap as a grantable lever.
- **Grant lifecycle is mandatory:** budgets **persist across cycles** (only the pool resets), so untracked end-of-cycle grants become permanent ceiling creep. Every auto-grant is time-boxed.

---

## 6. Hard invariants (never violate)

1. **No write without simulate-before-apply** — every budget/cap change (manual or auto) previews who blocks/unblocks and the pool/spend/bill delta first, then requires confirmation.
2. **Re-read live state before applying** (`GET /budgets`, cost-center state) to reconcile drift — this is what makes multiple local instances safe without a shared backend.
3. **Enforce `prevent_further_usage: true`** for any intended hard cap; making an alert-only limit requires an explicit, logged override.
4. **Validate on write:** block enterprise-cap-below-sum-of-cost-centers; flag multi-org-licensed users; warn on `$0`/near-zero ULBs.
5. **Immutable, append-only audit log** (hash-chained): every recommendation and applied change records actor, trigger, envelope, binding constraint, before/after, and the data snapshot it was based on. This is a government/compliance deliverable — treat it as such.
6. **PAT isolation:** main process only, `safeStorage` only, never logged.
7. **Verification gate — no change is "done" until BOTH pass.** **Playwright** e2e (headless, MSW-backed, deterministic) is the automated gate that blocks the change; **Chrome MCP** interactive verification of the actual running app confirms rendering + behaviour for that specific change (the check headless can't make). Green on both, or it isn't done — for *every* change. See §7.
8. **Simulation-mode safety.** In simulation mode no request ever reaches real GitHub and no real budget/cap is mutated. The mode is **unmistakable in the UI** (persistent banner); apply/grant actions are visibly simulated. Never let a simulated action look live — this tool moves money-affecting controls.
9. **API-surface validation for hand-wrapped GitHub clients.** Any code that calls the GitHub API outside an official/community SDK's typed surface — raw `fetch`/HTTP calls, hand-rolled request/response types, or `octokit.request()` against a guessed/undocumented path — must be validated against GitHub's actual API surface (the published OpenAPI/Swagger description, e.g. `github/rest-api-description`, or the official REST/GraphQL docs) before it's considered verified. **Exemption:** calls made through an official or established community SDK's typed methods (Octokit's REST/GraphQL clients, `@octokit/*` plugins) are exempt — their shapes are already validated upstream by the SDK maintainers. This is an *additional* gate, not a substitute for the §6.7/§7 Playwright + Chrome MCP gate.

---

## 7. Simulation mode & the mock layer (MSW)

**There is no PAT yet, so simulation mode is how the app is developed, demoed, and verified — it is not optional.** Build it in Phase 1, before anything that needs live data.

**One mock, three consumers.** A single **MSW (Mock Service Worker)** layer fakes the GitHub billing/budget API. The *same* handlers + fixtures power (a) **simulation mode** at runtime, (b) **Playwright e2e**, and (c) **unit/component tests** — one source of truth, so simulation mode and the tests can never drift.

**What the mock must model** (not happy-path shells): pooled draw + two-phase routing; ULB precedence (individual > CCULB > universal); lowest-remaining-headroom-wins; the auto-computed, non-settable included-usage cap (on/off + overflow); the API-only CCULB (`multi_user_cost_center`); the API-version + auth surface; realistic pagination; and crucially the **mutations** (`POST/PATCH/DELETE` budgets, cost-center edits) so simulate-before-apply and both rebalancers run end to end. Ship edge fixtures too: the ULB display-bug (budget in API, absent from a list view), `$0`-ULB block, a cap-bound team, and the promo→standard allowance cliff.

**Stateless & deterministic.** The mock is **seeded from static fixtures and resets to them on every run** — each e2e test and each app launch boots from a known state; tests never share state (reset in `beforeEach`). e2e asserts on the **request issued** (correct endpoint + payload) and the immediate response, **not** cross-request persistence. Where a flow must show apply→result within a session, use the UI's optimistic update; the mock's canonical state still resets to fixtures. Fixtures are versioned and live in `packages/data` (or a `fixtures/` package).

**Shipped as a real mode.** Simulation mode is **not stripped from production** — it ships as an **offline/demo mode admins can toggle** (explore, train, or preview with no PAT), guarded by the §6 safety invariant. Runtime switch: *PAT present + simulation off* → live GitHub; *simulation on (or no PAT)* → MSW.

**Verification workflow — run for every change:**
1. Write/extend **Playwright** e2e that drives the change against MSW; must pass headless (this is the blocking gate).
2. Use **Chrome MCP** to open the actual running app (simulation mode) and confirm the change renders and behaves correctly.
3. **If this change adds or modifies a hand-wrapped GitHub API call** (anything not going through Octokit's typed methods): validate its request/response shape against GitHub's OpenAPI/Swagger description or official REST/GraphQL docs (§6.9). Official/community SDK usage (Octokit) is exempt from this step.
4. All applicable steps green → done. None of the applicable steps are skippable (§6.7, §6.9).

---

## 8. Build order

Follow the phased plan in spec §4.7. Do **not** jump ahead to auto-apply.

1. **Scaffold + simulation harness (do this first).** Monorepo, the three packages, the Electron shell, the preload bridge + `ApiClient` interface, Drizzle schema + migrations, PAT capture via `safeStorage` — **and** the **MSW layer + fixtures, simulation-mode toggle, and the Playwright + Chrome-MCP harness**. The smoke test is a "Sync now" that pulls a usage report **from MSW** into SQLite and is verified through the gate. Without a PAT, this harness is the foundation everything else is built and verified on.
2. **Read-only observability** — ingestion of all entities into append-only snapshots; dashboards (pool burn-down, per-cost-center spend, heavy users).
3. **Full control administration** — API-first CRUD of every control incl. the two API-only levers; ULB-bug repair.
4. **Forecasting** — run-rate, the 1 Sep cliff, runway, P50/P90, backtest.
5. **Auto-balancing, dry-run** — both rebalancers, simulate only.
6. **Guardrailed auto-apply** + grant lifecycle + custom alerting.
7. **Chargeback + audit export.**

Every phase's work passes the §6.7 verification gate (Playwright + Chrome MCP against MSW) before it's considered done.

---

## 9. Confirm before building (open questions — spec §5)

Ask the maintainer and record the answers at the top of the repo README; several gate real functionality:

1. **Enterprise or Business**, and **github.com or GHE.com**? Gates cost centers, CCULBs, included-usage caps, allowances, and the API host. (Cost centers are **GHE Cloud only** — on Business, the two API-only levers don't exist.)
2. Is **"AI credit paid usage" enabled**? Determines whether the metered rebalancer is in scope.
3. Are **cost centers** in use, driven by **enterprise teams**?
4. **Pool posture:** hard-stop at pool, or a controlled metered budget? Sets the default `prevent_further_usage`.
5. **Auto-apply appetite**, **reserve buffer %**, and **grant rollover policy** (revert vs re-baseline)?

---

## 10. Conventions

- Small, reviewable PRs mapped to the phases above.
- **No PR is done until the §6.7 gate is green:** Playwright e2e (vs MSW) passes headless, and Chrome MCP verification of the running app confirms the change. State both outcomes in the PR. If the PR adds/modifies a hand-wrapped GitHub API call, also state the §6.9 API-surface validation outcome (or that it's exempt via Octokit).
- Every money-affecting function in `core` gets unit tests before it's wired to I/O.
- Prefer existing, popular libraries over bespoke implementations (project owner's standing preference).
- Keep this file current: when a decision changes, update `CLAUDE.md` in the same PR.
- Fill in the `## Commands` section below as you scaffold (install / dev / build / test / e2e / package).

## Commands

_(populate during scaffolding)_

```
pnpm install
pnpm dev            # electron + vite dev (simulation mode by default when no PAT)
pnpm dev:sim        # force simulation mode (MSW)
pnpm test           # vitest (unit/component, MSW)
pnpm e2e            # playwright e2e against MSW (the automated gate)
pnpm e2e:ui         # playwright interactive
pnpm build          # build all packages
pnpm package        # electron-builder -> signed installer
```
