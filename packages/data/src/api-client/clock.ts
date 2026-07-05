import { SIM_CURRENT_DATE } from '../msw/fixtures/constants.js';

// Live-mode-hardening clock seam. Every cycle-relative derivation in the data
// layer (github-impl.ts's usage/heavy-user/cost-center rollups, the Task 5.4
// forecast fetches, live-state.ts's cycle filter) historically read
// SIM_CURRENT_DATE directly -- a hardcoded fixture "now". That is exactly
// right for simulation mode (every Playwright pin and vitest expectation
// depends on the deterministic 2026-06-14 anchor), but wrong the moment a real
// tenant is reached: live mode must anchor to the real wall clock.
//
// This is the ONE place that decision is made, keyed off the client's data
// source (the same 'msw' | 'github' flag that already routes MSW vs live
// GitHub): 'msw' -> the byte-identical fixture date; 'github' -> today (UTC,
// YYYY-MM-DD). Core stays asOfDate-explicit -- it never reads a clock; callers
// thread the resolved string in. `now` is injectable so the live branch is
// unit-testable deterministically.
export function resolveClockDate(source: 'msw' | 'github', now: () => Date = () => new Date()): string {
  if (source === 'msw') return SIM_CURRENT_DATE;
  return now().toISOString().slice(0, 10);
}
