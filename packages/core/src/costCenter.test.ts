import { describe, expect, it } from 'vitest';
import {
  classifyHeadroom,
  costCenterStatus,
  includedCapHeadroom,
  LOW_HEADROOM_THRESHOLD_CREDITS,
} from './costCenter';

describe('includedCapHeadroom', () => {
  it('is the computed cap minus MTD burn', () => {
    expect(includedCapHeadroom(105_000, 420)).toBe(104_580);
  });

  it('goes negative when a team burns past its cap (the over-cap edge fixture)', () => {
    expect(includedCapHeadroom(70_000, 70_500)).toBe(-500);
  });

  it('is exactly zero when the cap is fully consumed', () => {
    expect(includedCapHeadroom(70_000, 70_000)).toBe(0);
  });

  it('handles a zero cap (no attributed licenses) with any burn as fully negative', () => {
    expect(includedCapHeadroom(0, 500)).toBe(-500);
  });
});

describe('classifyHeadroom', () => {
  it('classifies negative headroom as negative (red), regardless of threshold', () => {
    expect(classifyHeadroom(-500, LOW_HEADROOM_THRESHOLD_CREDITS)).toBe('negative');
    expect(classifyHeadroom(-1, 0)).toBe('negative');
  });

  it('classifies zero headroom as low (amber), matching the prototype (over cap needs < 0)', () => {
    expect(classifyHeadroom(0, LOW_HEADROOM_THRESHOLD_CREDITS)).toBe('low');
  });

  it('classifies headroom under the threshold as low (amber)', () => {
    expect(classifyHeadroom(7_999, 8_000)).toBe('low');
    expect(classifyHeadroom(6_100, LOW_HEADROOM_THRESHOLD_CREDITS)).toBe('low');
  });

  it('classifies headroom at or above the threshold as ok (strict less-than, per the prototype)', () => {
    expect(classifyHeadroom(8_000, 8_000)).toBe('ok');
    expect(classifyHeadroom(104_580, LOW_HEADROOM_THRESHOLD_CREDITS)).toBe('ok');
  });
});

describe('costCenterStatus', () => {
  it('is within when headroom is non-negative and the CC is not excluded', () => {
    expect(costCenterStatus(false, 104_580)).toBe('within');
  });

  it('treats exactly-zero headroom as within (prototype: over cap requires < 0)', () => {
    expect(costCenterStatus(false, 0)).toBe('within');
  });

  it('is over-cap when headroom is negative', () => {
    expect(costCenterStatus(false, -500)).toBe('over-cap');
  });

  it('excluded wins over everything, even negative headroom (prototype precedence)', () => {
    expect(costCenterStatus(true, -500)).toBe('excluded');
    expect(costCenterStatus(true, 9_800)).toBe('excluded');
  });
});
