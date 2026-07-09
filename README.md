# Copilot Budget Manager

Internal FinOps tool for 2–3 non-developer GitHub admins to govern GitHub Copilot AI-credit spend after the June 2026 usage-based billing change. See `CLAUDE.md` for the full bootstrapper, `SPEC.md` for the product spec, and `PLAN.md` for the phased build plan.

## Maintainer decisions (CLAUDE.md §9)

CLAUDE.md §9 lists five open questions that gate real functionality. Answers are recorded here as they're checkpointed with the maintainer.

- **Q5 — Auto-apply appetite, reserve buffer, rollover default (answered 2026-07-07):**
  - **Q5a Auto-apply appetite:** Approval-gated per run — a human reviews and approves each rebalance run before it applies; one approval per grant set; above-threshold grants individually confirmed.
  - **Q5b Reserve buffer default:** 5% (matches the engine default and the design's guardrails card; adjustable in Settings once Task 7.2 lands).
  - **Q5c Grant rollover default:** Revert at reset — every grant is time-boxed to its cycle; at rollover the inverse mutation restores the baseline, audited.

- **Q1–Q4 remain open**, pending the live tenant / PAT:
  1. Enterprise or Business, and github.com or GHE.com?
  2. Is "AI credit paid usage" enabled?
  3. Are cost centers in use, driven by enterprise teams?
  4. Pool posture: hard-stop at pool, or a controlled metered budget?

## Launching live mode

`pnpm dev` boots the app; mode is chosen by an **in-app toggle** (Task 9.3-lite), not an env var. The selection is persisted (`app_settings` `app_mode`, default **simulation**) and resolved at startup: per CLAUDE.md §7, **mode = live only when the selection is `live` AND a PAT is stored** (`resolveMode` in `packages/data/src/pat/mode.ts`). A `live` selection with no PAT still resolves to simulation — that's expected, not a bug.

In-app flow to reach live mode:
1. **Settings → Mode**: switch the selection to **Live**. The card notes you must **restart the app to apply a mode change** (the selection does not re-resolve the running process).
2. **Settings → Token & permission health**: paste a classic PAT and **Save token**.
3. **Validate token**: confirms token kind and the `manage_billing:enterprise` scope.
4. **Tenant configuration**: set the host (`github.com` or `GHE.com` + subdomain) and enterprise slug, then **Save tenant**.
5. **Restart** `pnpm dev`. With the selection `live` and a PAT stored, the app now resolves to live.
6. **Live read smoke** (**Run live read smoke**): reads every enterprise billing/budget endpoint once and reconciles the response shape against what the app parses. Unavailable while simulating.

> **Live writes are gated behind explicit arming (Task 9.3-lite).** In live mode the app boots **read-only**: the Controls apply path returns `not_armed` and issues **no** GitHub mutation until you arm live writes. **Settings → Live-write arming**: type the enterprise slug verbatim to confirm, then **Arm live writes**. Arming lives in main-process memory only — it is **disarmed on relaunch**, and a PAT/tenant change force-disarms it. Only while armed does an apply issue real budget/cap mutations; the app-level banner turns to a prominent **LIVE — writes ARMED** warning whenever it is.
>
> **Scope note — this is 9.3-*lite*.** Read/write token *separation* and RBAC-lite roles from the full Task 9.3 charter are still deferred: one PAT does both reads and writes. What 9.3-lite adds is the in-app mode toggle and the explicit live-write arming gate above.
