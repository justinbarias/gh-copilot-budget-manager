import { describe, expect, it } from 'vitest';
import { rankHeavyUsers } from './ranking';

describe('rankHeavyUsers', () => {
  it('returns an empty list unchanged', () => {
    expect(rankHeavyUsers([])).toEqual([]);
  });

  it('sorts descending by credits used', () => {
    const ranked = rankHeavyUsers([
      { userId: 'alice', creditsUsed: 100 },
      { userId: 'bob', creditsUsed: 900 },
      { userId: 'carol', creditsUsed: 400 },
    ]);
    expect(ranked.map((u) => u.userId)).toEqual(['bob', 'carol', 'alice']);
  });

  it('breaks ties deterministically by ascending userId', () => {
    const ranked = rankHeavyUsers([
      { userId: 'zeta', creditsUsed: 500 },
      { userId: 'alpha', creditsUsed: 500 },
      { userId: 'mu', creditsUsed: 500 },
    ]);
    expect(ranked.map((u) => u.userId)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('does not mutate the input array', () => {
    const input = [
      { userId: 'a', creditsUsed: 1 },
      { userId: 'b', creditsUsed: 2 },
    ];
    const inputCopy = [...input];
    rankHeavyUsers(input);
    expect(input).toEqual(inputCopy);
  });

  it('handles a single-user list', () => {
    const ranked = rankHeavyUsers([{ userId: 'solo', creditsUsed: 42 }]);
    expect(ranked).toEqual([{ userId: 'solo', creditsUsed: 42 }]);
  });
});
