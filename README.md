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

`pnpm dev` always boots simulation mode — CLAUDE.md §9's open questions mean there's no PAT yet, and `apps/desktop/src/main/mode.ts` force-locks the app to simulation by default via `COPILOT_BUDGET_FORCE_SIMULATION`. To disarm that lock during local development:

```
pnpm dev:live
```

This sets `COPILOT_BUDGET_FORCE_SIMULATION=0` and runs the same dev chain as `pnpm dev`. The env-prefix syntax is macOS/Linux shell syntax; on Windows, set the variable separately first (e.g. `set COPILOT_BUDGET_FORCE_SIMULATION=0 && pnpm --filter @copilot-budget/desktop run dev` in `cmd`, or `$env:COPILOT_BUDGET_FORCE_SIMULATION=0; pnpm --filter @copilot-budget/desktop run dev` in PowerShell) — this repo is developed on macOS, so that path is untested.

Disarming the lock does not, by itself, put the app in live mode: per CLAUDE.md §7, **mode = live only when the lock is disarmed AND a PAT is stored** (`resolveMode` in `packages/data/src/pat/mode.ts`). With no PAT saved, `dev:live` still boots simulation — that's expected, not a bug.

In-app flow to reach live mode:
1. **Settings → Token & permission health**: paste a classic PAT and **Save token**.
2. **Validate token**: confirms token kind and the `manage_billing:enterprise` scope.
3. **Tenant configuration**: set the host (`github.com` or `GHE.com` + subdomain) and enterprise slug, then **Save tenant**.
4. **Live read smoke** (**Run live read smoke**): reads every enterprise billing/budget endpoint once and reconciles the response shape against what the app parses. Unavailable while simulating.

> **Caution — live mode is read-only until Task 9.3 lands.** Live-write arming (`docs/pending/plan.md` Task 9.3: read/write token separation + an explicit arming flow) is not yet built. Today, the single PAT saved above is used for both reads and writes, and the Controls apply path issues **real GitHub mutations** the moment mode is live — there is no arming gate stopping it. Until 9.3 ships, treat live mode strictly as read-only: validate → tenant config → live read smoke → browse dashboards. Do not exercise Controls' apply/grant actions against a live tenant.

**Stale seam:** the in-app persisted simulation toggle originally slated for Task 1.7 was never built — `COPILOT_BUDGET_FORCE_SIMULATION` is currently the *only* switch between simulation and live, and it's an env var, not a Settings-screen control. Replacing it with a real in-app toggle (with the write-token separation and arming flow above) is tracked under the Task 9.x work in `docs/pending/plan.md`.
