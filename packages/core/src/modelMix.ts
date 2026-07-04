// Best-effort per-model attribution for a user's cycle-to-date credits. PRD
// §2.3: no single GitHub API gives per-user x per-model in one report (it's
// entity-model OR user-total, never both), so some fraction of a user's
// credits can't be confidently attributed to a model -- `model: null` marks
// those rows. The Users screen's model-mix bar must show that remainder
// explicitly (design/README.md: "never imply false precision"), never fold it
// silently into a named model's share.
export interface ModelUsageRow {
  model: string | null;
  creditsUsed: number;
}

export interface ModelMixSegment {
  model: string;
  pct: number; // integer 0-100
}

export interface ModelMix {
  segments: ModelMixSegment[]; // named-model segments only, descending by share
  unattributablePct: number; // integer 0-100, the explicit "can't attribute" remainder
}

// Rounds a set of shares that should sum to 100 so the rounded results sum to
// exactly 100: floor each, then hand out the leftover whole points to the
// largest fractional remainders first (the standard "largest remainder"
// apportionment method) -- avoids a stacked bar whose segments visibly don't
// add up because of independent per-segment rounding.
function largestRemainderRound(shares: readonly number[]): number[] {
  const floors = shares.map((s) => Math.floor(s));
  const remainder = 100 - floors.reduce((sum, f) => sum + f, 0);
  const byFractionDesc = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac);

  const result = [...floors];
  for (let k = 0; k < remainder; k++) {
    result[byFractionDesc[k]!.i]! += 1;
  }
  return result;
}

export function computeModelMix(rows: readonly ModelUsageRow[]): ModelMix {
  const total = rows.reduce((sum, row) => sum + row.creditsUsed, 0);
  if (total <= 0) return { segments: [], unattributablePct: 0 };

  const creditsByModel = new Map<string, number>();
  let unattributableCredits = 0;
  for (const row of rows) {
    if (row.model === null) {
      unattributableCredits += row.creditsUsed;
    } else {
      creditsByModel.set(row.model, (creditsByModel.get(row.model) ?? 0) + row.creditsUsed);
    }
  }

  const models = [...creditsByModel.keys()];
  const shares = models.map((model) => (creditsByModel.get(model)! / total) * 100);
  shares.push((unattributableCredits / total) * 100);

  const rounded = largestRemainderRound(shares);
  const unattributablePct = rounded[rounded.length - 1]!;

  const segments = models
    .map((model, i) => ({ model, pct: rounded[i]! }))
    .sort((a, b) => b.pct - a.pct);

  return { segments, unattributablePct };
}
