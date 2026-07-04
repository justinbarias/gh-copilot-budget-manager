import { describe, expect, it } from 'vitest';
import { computeModelMix } from './modelMix';

describe('computeModelMix', () => {
  it('returns an empty mix for no usage at all', () => {
    expect(computeModelMix([])).toEqual({ segments: [], unattributablePct: 0 });
  });

  it('attributes 100% to a single model with no unattributable rows', () => {
    expect(computeModelMix([{ model: 'GPT-5.4', creditsUsed: 100 }])).toEqual({
      segments: [{ model: 'GPT-5.4', pct: 100 }],
      unattributablePct: 0,
    });
  });

  it('is entirely unattributable when every row has a null model', () => {
    expect(computeModelMix([{ model: null, creditsUsed: 42 }])).toEqual({
      segments: [],
      unattributablePct: 100,
    });
  });

  // user-01's fixture decomposition (packages/data/src/msw/fixtures/usage.ts):
  // 80+90 GPT-5.4, 70 Sonnet 4.6, 60 GPT-5 mini, 120 unattributable = 420 total.
  // Exact shares: 170/420=40.476.., 70/420=16.666.., 60/420=14.285.., 120/420=28.571..
  // Floors: 40,16,14,28 (sum 98) -> 2 leftover points go to the largest fractional
  // remainders (Sonnet 4.6 .667, unattributable .571) -> 40,17,14,29.
  it('rounds shares via largest-remainder so segments + unattributable sum to exactly 100', () => {
    const mix = computeModelMix([
      { model: 'GPT-5.4', creditsUsed: 80 },
      { model: 'GPT-5.4', creditsUsed: 90 },
      { model: 'Sonnet 4.6', creditsUsed: 70 },
      { model: 'GPT-5 mini', creditsUsed: 60 },
      { model: null, creditsUsed: 120 },
    ]);
    expect(mix).toEqual({
      segments: [
        { model: 'GPT-5.4', pct: 40 },
        { model: 'Sonnet 4.6', pct: 17 },
        { model: 'GPT-5 mini', pct: 14 },
      ],
      unattributablePct: 29,
    });
    const total = mix.segments.reduce((sum, s) => sum + s.pct, 0) + mix.unattributablePct;
    expect(total).toBe(100);
  });

  it('sorts segments descending by share', () => {
    const mix = computeModelMix([
      { model: 'A', creditsUsed: 10 },
      { model: 'B', creditsUsed: 80 },
      { model: 'C', creditsUsed: 10 },
    ]);
    expect(mix.segments.map((s) => s.model)).toEqual(['B', 'A', 'C']);
  });
});
