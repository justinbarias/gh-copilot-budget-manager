export interface Snapshot {
  capturedAt: Date;
  values: Record<string, number>;
}

export interface SnapshotDiff {
  capturedAt: Date;
  deltas: Record<string, number>;
}

// Snapshot rows are append-only (CLAUDE.md §6): diffing never looks backward in time.
export function diffSnapshot(previous: Snapshot | null, next: Snapshot): SnapshotDiff {
  if (previous && next.capturedAt.getTime() <= previous.capturedAt.getTime()) {
    throw new Error('Snapshots are append-only: next.capturedAt must be strictly after previous.capturedAt');
  }

  const keys = new Set([...Object.keys(previous?.values ?? {}), ...Object.keys(next.values)]);
  const deltas: Record<string, number> = {};
  for (const key of keys) {
    const previousValue = previous?.values[key] ?? 0;
    const nextValue = next.values[key] ?? 0;
    deltas[key] = nextValue - previousValue;
  }

  return { capturedAt: next.capturedAt, deltas };
}
