import { describe, expect, it } from 'vitest';
import { formatModeLogLine } from './mode';

// Task 9.3-lite: the boot diagnostic's exact shape is unit-testable because it
// is composed in core (pat/mode.ts), not in the Electron main. The setting is
// quoted verbatim (JSON.stringify), so "simulation" vs the literal string
// "undefined" vs an empty string are all distinguishable in the log.
describe('formatModeLogLine', () => {
  it('produces the fresh-DB line: resolved simulation, setting "simulation", no PAT', () => {
    expect(formatModeLogLine('simulation', 'simulation', false)).toBe(
      '[mode] resolved=simulation app_mode_setting="simulation" pat_present=false',
    );
  });

  it('quotes the raw setting and reflects live + PAT present', () => {
    expect(formatModeLogLine('live', 'live', true)).toBe(
      '[mode] resolved=live app_mode_setting="live" pat_present=true',
    );
  });

  it('shows a live selection that still resolved simulation (no PAT)', () => {
    expect(formatModeLogLine('simulation', 'live', false)).toBe(
      '[mode] resolved=simulation app_mode_setting="live" pat_present=false',
    );
  });
});
