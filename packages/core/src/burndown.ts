export function poolConsumedPct(consumed: number, poolSize: number): number {
  if (poolSize <= 0) return 0;
  return Math.min(1, consumed / poolSize);
}

export interface CycleBounds {
  cycleStart: Date;
  cycleEnd: Date;
  daysInCycle: number;
  daysElapsed: number;
}

// Billing cycles reset monthly at 00:00:00 UTC with no carryover (PRD §1.2).
export function cycleBounds(asOfDate: Date): CycleBounds {
  const year = asOfDate.getUTCFullYear();
  const month = asOfDate.getUTCMonth();

  const cycleStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const cycleEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const daysInCycle = Math.round((cycleEnd.getTime() - cycleStart.getTime()) / (24 * 60 * 60 * 1000));
  const daysElapsed = Math.floor((asOfDate.getTime() - cycleStart.getTime()) / (24 * 60 * 60 * 1000));

  return { cycleStart, cycleEnd, daysInCycle, daysElapsed };
}
