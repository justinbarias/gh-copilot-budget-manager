import { describe, expect, it } from 'vitest';
import { resolveMode } from './mode';

describe('resolveMode', () => {
  it('resolves to simulation when simulation is forced, regardless of PAT presence', async () => {
    const mode = await resolveMode({
      patStore: { get: async () => 'ghp_sentinelToken123' },
      simulationForced: () => true,
    });
    expect(mode).toBe('simulation');
  });

  it('resolves to live when a PAT is present and simulation is not forced', async () => {
    const mode = await resolveMode({
      patStore: { get: async () => 'ghp_sentinelToken123' },
      simulationForced: () => false,
    });
    expect(mode).toBe('live');
  });

  it('resolves to simulation when no PAT is stored, even if simulation is not forced', async () => {
    const mode = await resolveMode({
      patStore: { get: async () => null },
      simulationForced: () => false,
    });
    expect(mode).toBe('simulation');
  });
});
