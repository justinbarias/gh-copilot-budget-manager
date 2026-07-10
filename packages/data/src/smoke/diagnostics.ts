// Task (2026-07-10): live per-month distribution renders all-zero diagnostics.
//
// The maintainer's live tenant (100 seats, cycle Jul, Day 9) shows the
// distribution "Per month -> 1 month" lens as "Jun 2026 * 100 user-months"
// with EVERY per-user observation 0 (P30/P50/P95/mean all 0, xMax fallback 1).
// For June to qualify as a COMPLETE calendar month, credits_used_fact coverage
// must reach back to <= Jun 1 -- yet every June per-user sum is 0. Three
// hypotheses to discriminate (brief Part B):
//   (H1) the live R6 historical per-user report returns NO (or zeroed) per-user
//        rows for prior cycles;
//   (H2) live rows are persisted with a different identity/shape than the
//        fixtures model (e.g. user_login absent / user_id shape);
//   (H3) a live-only date/aggregation mismatch.
//
// We cannot debug live from this Mac (live runs only on the maintainer's
// Windows box), so this ships DIAGNOSTICS into the existing live-read smoke
// surface (TokenHealth "Live read smoke" card, copied via readSmokeToText).
// Two sections, both cross-platform-safe plain text (no shell):
//   (1) Local credits coverage (DB) -- what got PERSISTED (source-scoped).
//   (2) Live wire R6 historical summary -- what the R6 backfill RETURNS,
//       WITHOUT persisting.
// Comparing the two discriminates H1 (wire section shows 0 items / 0 nonzero),
// H2 (DB has rows but null_login high / distinct users off; wire has_login
// low), and H3 (DB months present but the winning-rows month rollup is 0).
//
// This module is PURE (no I/O): computeLocalCreditsCoverage (DB read, reusing
// readDistributionFactBase -- NOT reimplemented) lives in github-impl.ts where
// the DB + fact base are; this file holds the section TYPES, the wire summary
// (fed an already-fetched item array), and the plain-text formatters.

export interface SnapshotCoverage {
  snapshotId: number;
  /** ISO timestamp of the snapshot's captured_at. */
  capturedAt: string;
  /** credits_used_fact row count for this snapshot (this source). */
  rowCount: number;
  distinctUserIds: number;
  /** Min/max date (YYYY-MM-DD) across this snapshot's rows; null when empty. */
  minDate: string | null;
  maxDate: string | null;
  /** Rows whose user_login is null (H2 signal: identity/shape divergence). */
  nullLoginCount: number;
}

export interface MonthCoverage {
  /** YYYY-MM. */
  month: string;
  /** Sum of credits over the winning (union/latest-wins) rows this month. */
  totalCredits: number;
  /** Distinct users with ANY winning row this month. */
  distinctUsers: number;
  /** Distinct users whose winning month sum is > 0 (H3/all-zero signal). */
  usersWithNonzero: number;
}

export interface LocalCreditsCoverage {
  source: string;
  /** False when there is NO per-user credits_used_fact history for this source. */
  hasData: boolean;
  /** Per snapshot (ascending id) raw stats. */
  snapshots: SnapshotCoverage[];
  /** Per covered month (ascending) rollup over the SAME union view the
   *  distribution reads (getUserMonthObservations) consume. */
  months: MonthCoverage[];
}

export interface WireR6MonthSummary {
  /** YYYY-MM, from the item dates. */
  month: string;
  itemCount: number;
  distinctUserIds: number;
  /** Items whose user_login is a non-empty string (H2 signal). */
  itemsWithLogin: number;
  /** Items whose ai_credits_used > 0 (H1/all-zero signal). */
  itemsWithNonzeroCredits: number;
  /** Sum of ai_credits_used across the month's items. */
  sumCredits: number;
}

export interface WireR6DaySummary {
  /** YYYY-MM-DD. */
  date: string;
  itemCount: number;
  /** Items whose ai_credits_used > 0 (per-day zero-fill footprint). */
  itemsWithNonzeroCredits: number;
  /** Sum of ai_credits_used across the day's items. */
  sumCredits: number;
}

export interface WireR6Summary {
  totalItems: number;
  /** Ascending months; capped to the LAST 12 (this is a copy-paste surface). */
  monthsShown: WireR6MonthSummary[];
  /** Count of earlier months omitted by the 12-month cap (0 when uncapped). */
  truncatedMonths: number;
  /**
   * Per-day breakdown (scope amendment, 2026-07-11): the trailing
   * WIRE_DAY_WINDOW (35) calendar days ENDING at the max item date, ascending,
   * ONE entry per day that HAS items -- days with no items are omitted. This
   * measures the wire's zero-fill footprint day by day, because the "retention
   * window" is an unverified hypothesis (GitHub docs document NO retention for
   * this report, and ai_credits_used only launched 2026-06-19, yet both older
   * and recent days came back zero-filled). Counts/dates/sums only (§6.6).
   */
  daysShown: WireR6DaySummary[];
  /** Count of days-WITH-items older than the trailing-35-day window (omitted). */
  truncatedDays: number;
}

/** The R6 historical item shape (users-report.ts DatedUsersReportRecord /
 *  github-impl.ts CreditsUsedItem) this summary reads. */
export interface WireR6Item {
  date: string;
  user_id: string;
  user_login?: string | null;
  ai_credits_used: number;
}

const MAX_WIRE_MONTHS = 12;
// Per-day breakdown window: the trailing 35 calendar days ending at the max
// item date (scope amendment 2026-07-11). Strictly capped at 35 lines.
const WIRE_DAY_WINDOW = 35;
const DAY_MS = 24 * 60 * 60 * 1000;

// Section 2: summarize the R6 historical per-user backfill WITHOUT persisting.
// Grouped by calendar month (from item.date); per month: item count, distinct
// user ids, # items carrying a non-empty user_login, # items with credits > 0,
// and the summed credits. Capped to the last 12 months (copy-paste surface).
export function summarizeWireR6Historical(items: ReadonlyArray<WireR6Item>): WireR6Summary {
  interface MonthAcc {
    itemCount: number;
    userIds: Set<string>;
    itemsWithLogin: number;
    itemsWithNonzeroCredits: number;
    sumCredits: number;
  }
  interface DayAcc {
    itemCount: number;
    itemsWithNonzeroCredits: number;
    sumCredits: number;
  }
  const byMonth = new Map<string, MonthAcc>();
  const byDay = new Map<string, DayAcc>();
  for (const item of items) {
    const month = item.date.slice(0, 7);
    let acc = byMonth.get(month);
    if (!acc) {
      acc = { itemCount: 0, userIds: new Set(), itemsWithLogin: 0, itemsWithNonzeroCredits: 0, sumCredits: 0 };
      byMonth.set(month, acc);
    }
    acc.itemCount += 1;
    acc.userIds.add(item.user_id);
    if (typeof item.user_login === 'string' && item.user_login.length > 0) acc.itemsWithLogin += 1;
    if (item.ai_credits_used > 0) acc.itemsWithNonzeroCredits += 1;
    acc.sumCredits += item.ai_credits_used;

    // Per-day accumulation (same single pass) -- one bucket per DATE that has
    // items (days with no items never get a bucket, so they are omitted).
    let day = byDay.get(item.date);
    if (!day) {
      day = { itemCount: 0, itemsWithNonzeroCredits: 0, sumCredits: 0 };
      byDay.set(item.date, day);
    }
    day.itemCount += 1;
    if (item.ai_credits_used > 0) day.itemsWithNonzeroCredits += 1;
    day.sumCredits += item.ai_credits_used;
  }

  const allMonths = [...byMonth.keys()].sort();
  const shownMonths = allMonths.length > MAX_WIRE_MONTHS ? allMonths.slice(-MAX_WIRE_MONTHS) : allMonths;
  const monthsShown: WireR6MonthSummary[] = shownMonths.map((month) => {
    const acc = byMonth.get(month)!;
    return {
      month,
      itemCount: acc.itemCount,
      distinctUserIds: acc.userIds.size,
      itemsWithLogin: acc.itemsWithLogin,
      itemsWithNonzeroCredits: acc.itemsWithNonzeroCredits,
      sumCredits: acc.sumCredits,
    };
  });

  // Per-day breakdown: the trailing WIRE_DAY_WINDOW calendar days ending at the
  // max item date (inclusive), ascending, days-with-items only, strictly capped
  // at WIRE_DAY_WINDOW lines. truncatedDays counts the days-with-items that fall
  // OLDER than that window (surfaced in the formatter header).
  const allDays = [...byDay.keys()].sort();
  let daysShown: WireR6DaySummary[] = [];
  if (allDays.length > 0) {
    const maxDate = allDays[allDays.length - 1]!;
    const thresholdMs = Date.parse(`${maxDate}T00:00:00.000Z`) - (WIRE_DAY_WINDOW - 1) * DAY_MS;
    const windowDays = allDays.filter((d) => Date.parse(`${d}T00:00:00.000Z`) >= thresholdMs);
    // Belt-and-suspenders strict cap (the 35-day window already bounds this to
    // <=35 distinct dates, but keep the last WIRE_DAY_WINDOW explicitly).
    const cappedDays = windowDays.length > WIRE_DAY_WINDOW ? windowDays.slice(-WIRE_DAY_WINDOW) : windowDays;
    daysShown = cappedDays.map((date) => {
      const d = byDay.get(date)!;
      return { date, itemCount: d.itemCount, itemsWithNonzeroCredits: d.itemsWithNonzeroCredits, sumCredits: d.sumCredits };
    });
  }
  const truncatedDays = allDays.length - daysShown.length;

  return {
    totalItems: items.length,
    monthsShown,
    truncatedMonths: allMonths.length - shownMonths.length,
    daysShown,
    truncatedDays,
  };
}

// Round for display only (credits are real; never mutate the underlying sum).
function fmtCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Section 1 formatter -- plain text, indented, ASCII only.
export function formatLocalCreditsCoverage(coverage: LocalCreditsCoverage): string {
  const lines: string[] = [`Local credits coverage (DB, source: ${coverage.source})`];
  if (!coverage.hasData || coverage.snapshots.length === 0) {
    lines.push('  (no per-user credits_used_fact rows for this source -- never synced in this mode?)');
    return lines.join('\n');
  }

  lines.push('  Snapshots (credits_used_fact, this source):');
  for (const s of coverage.snapshots) {
    lines.push(
      `    #${s.snapshotId} captured ${s.capturedAt}: rows=${s.rowCount} users=${s.distinctUserIds} ` +
        `dates=${s.minDate ?? '?'}..${s.maxDate ?? '?'} null_login=${s.nullLoginCount}`,
    );
  }

  lines.push('  Per-month (union/latest-wins winning rows -- exactly what getUserMonthObservations sees):');
  if (coverage.months.length === 0) {
    lines.push('    (no covered months)');
  } else {
    for (const m of coverage.months) {
      lines.push(
        `    ${m.month}: total=${fmtCredits(m.totalCredits)} users_with_rows=${m.distinctUsers} ` +
          `users_nonzero=${m.usersWithNonzero}`,
      );
    }
  }
  return lines.join('\n');
}

// Section 2 formatter -- plain text, indented, ASCII only.
export function formatWireR6Historical(summary: WireR6Summary): string {
  const lines: string[] = ['Live wire R6 historical (users-1-day backfill -- NOT persisted)'];
  const monthCount = summary.monthsShown.length + summary.truncatedMonths;
  const scope =
    summary.truncatedMonths > 0
      ? `  total items: ${summary.totalItems} (showing last ${summary.monthsShown.length} of ${monthCount} months)`
      : `  total items: ${summary.totalItems} (${monthCount} month${monthCount === 1 ? '' : 's'})`;
  lines.push(scope);
  if (summary.monthsShown.length === 0) {
    lines.push('    (no items returned)');
    return lines.join('\n');
  }
  for (const m of summary.monthsShown) {
    lines.push(
      `    ${m.month}: items=${m.itemCount} users=${m.distinctUserIds} with_login=${m.itemsWithLogin} ` +
        `nonzero_credits=${m.itemsWithNonzeroCredits} sum=${fmtCredits(m.sumCredits)}`,
    );
  }

  // Per-day breakdown (scope amendment 2026-07-11): one line per day-with-items
  // over the trailing 35-day window ending at the max item date. Days with no
  // items are omitted; older days-with-items beyond the window are counted in
  // the header. daysShown is non-empty whenever monthsShown is (both derive
  // from the same items), so this only renders when there is data above.
  if (summary.daysShown.length > 0) {
    const lastDay = summary.daysShown[summary.daysShown.length - 1]!.date;
    const dayHeader =
      summary.truncatedDays > 0
        ? `  Per-day (trailing ${WIRE_DAY_WINDOW} days ending ${lastDay}; ${summary.truncatedDays} earlier day${summary.truncatedDays === 1 ? '' : 's'} with items omitted; days with no items omitted):`
        : `  Per-day (trailing ${WIRE_DAY_WINDOW} days ending ${lastDay}; days with no items omitted):`;
    lines.push(dayHeader);
    for (const d of summary.daysShown) {
      lines.push(`    ${d.date}: items=${d.itemCount} nonzero_credits=${d.itemsWithNonzeroCredits} sum=${fmtCredits(d.sumCredits)}`);
    }
  }
  return lines.join('\n');
}

// Section 2 is a LIVE wire probe -- it runs against real GitHub only. When the
// smoke somehow runs with a non-github source, the section renders this note
// instead of issuing a request (defensive: runLiveReadSmoke already refuses in
// simulation, so this is not reached in practice, but keeps the branch honest
// and testable).
export const WIRE_R6_SIM_SKIP_NOTE =
  'Live wire R6 historical: skipped (simulation source -- this probe runs against live GitHub only).';
