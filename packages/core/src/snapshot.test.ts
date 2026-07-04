import { describe, expect, it } from 'vitest';
import { diffSnapshot } from './snapshot';

describe('diffSnapshot', () => {
  it('treats every value as a positive delta from zero when there is no previous snapshot', () => {
    const diff = diffSnapshot(null, {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      values: { creditsUsed: 100 },
    });
    expect(diff.deltas).toEqual({ creditsUsed: 100 });
  });

  it('computes the delta between two snapshots', () => {
    const previous = {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      values: { creditsUsed: 100 },
    };
    const next = {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      values: { creditsUsed: 150 },
    };
    const diff = diffSnapshot(previous, next);
    expect(diff.deltas).toEqual({ creditsUsed: 50 });
    expect(diff.capturedAt).toBe(next.capturedAt);
  });

  it('treats a key missing from the next snapshot as dropping to 0', () => {
    const previous = {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      values: { creditsUsed: 100, actionsMinutes: 20 },
    };
    const next = {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      values: { creditsUsed: 150 },
    };
    const diff = diffSnapshot(previous, next);
    expect(diff.deltas).toEqual({ creditsUsed: 50, actionsMinutes: -20 });
  });

  it('enforces the append-only invariant: next must be strictly after previous', () => {
    const previous = {
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
      values: { creditsUsed: 150 },
    };
    const next = {
      capturedAt: new Date('2026-06-01T00:00:00.000Z'),
      values: { creditsUsed: 100 },
    };
    expect(() => diffSnapshot(previous, next)).toThrow(/append-only/i);
  });

  it('rejects two snapshots captured at the exact same instant', () => {
    const capturedAt = new Date('2026-06-01T00:00:00.000Z');
    expect(() =>
      diffSnapshot({ capturedAt, values: { creditsUsed: 100 } }, { capturedAt, values: { creditsUsed: 100 } }),
    ).toThrow(/append-only/i);
  });

  it('handles an empty values map on both sides', () => {
    const diff = diffSnapshot(
      { capturedAt: new Date('2026-06-01T00:00:00.000Z'), values: {} },
      { capturedAt: new Date('2026-06-02T00:00:00.000Z'), values: {} },
    );
    expect(diff.deltas).toEqual({});
  });
});
