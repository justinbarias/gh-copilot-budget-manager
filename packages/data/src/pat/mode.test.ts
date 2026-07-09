import { describe, expect, it } from 'vitest';
import { resolveMode } from './mode';

// Task 9.3-lite: resolveMode now takes the persisted in-app mode SELECTION
// (`appModeSetting`) instead of the retired `simulationForced` env seam. Live
// resolves ONLY when the selection is 'live' AND a PAT is stored.
describe('resolveMode', () => {
  it('resolves to simulation when the selection is simulation, regardless of PAT presence', async () => {
    const mode = await resolveMode({
      patStore: { get: async () => 'ghp_sentinelToken123' },
      appModeSetting: () => 'simulation',
    });
    expect(mode).toBe('simulation');
  });

  it('resolves to live when the selection is live and a PAT is present', async () => {
    const mode = await resolveMode({
      patStore: { get: async () => 'ghp_sentinelToken123' },
      // Promise-returning form: the type allows both sync and async; exercise
      // the async branch here. `as const` keeps the async return as
      // Promise<'live'> (an async arrow otherwise widens the literal to
      // Promise<string>, which is not assignable to Promise<AppMode>).
      appModeSetting: async () => 'live' as const,
    });
    expect(mode).toBe('live');
  });

  it('resolves to simulation when no PAT is stored, even if the selection is live', async () => {
    const mode = await resolveMode({
      patStore: { get: async () => null },
      appModeSetting: () => 'live',
    });
    expect(mode).toBe('simulation');
  });

  it('resolves to simulation when the selection is live but the PAT is null (sync appModeSetting form)', async () => {
    const mode = await resolveMode({
      patStore: { get: async () => null },
      appModeSetting: () => 'live',
    });
    expect(mode).toBe('simulation');
  });
});
