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
