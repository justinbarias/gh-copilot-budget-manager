import { describe, expect, it } from 'vitest';
import { SIM_CURRENT_DATE } from '../msw/fixtures/constants.js';
import { resolveClockDate } from './clock.js';

describe('resolveClockDate', () => {
  it('returns the deterministic fixture date in simulation (msw source)', () => {
    // Byte-identical to the old hardcoded SIM_CURRENT_DATE -- every e2e pin
    // depends on this staying constant.
    expect(resolveClockDate('msw')).toBe(SIM_CURRENT_DATE);
    // The injected `now` is IGNORED for msw (never a wall clock in simulation).
    expect(resolveClockDate('msw', () => new Date('2030-01-01T00:00:00.000Z'))).toBe(SIM_CURRENT_DATE);
  });

  it('returns the real wall-clock date (UTC YYYY-MM-DD) in live (github source)', () => {
    expect(resolveClockDate('github', () => new Date('2026-09-15T13:45:00.000Z'))).toBe('2026-09-15');
  });
});
