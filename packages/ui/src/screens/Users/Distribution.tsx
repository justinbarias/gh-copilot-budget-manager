import { useEffect, useMemo, useState } from 'react';
import { computeUsageDistribution, countAbove, type ControlState, type UserCreditUsage } from '@copilot-budget/core';
import type { UsageDistributionWindow, UserMonthObservationsResult } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { DistributionChart, fmtCredits, fmtDollars } from './DistributionChart';
import './Distribution.css';

type Months = 1 | 3 | 9;
// The Distribution view's two lenses: per-user WINDOW TOTALS (default) vs per
// (user, complete-calendar-month) observations -- the latter reads directly
// against the monthly universal ULB.
type Mode = 'totals' | 'permonth';

const WINDOWS: ReadonlyArray<{ months: Months; button: string; label: string; phrase: string }> = [
  { months: 1, button: '1 month', label: '1 month', phrase: 'last month' },
  { months: 3, button: '3 months', label: '3 months', phrase: 'last 3 months' },
  { months: 9, button: '9 months', label: '9 months', phrase: 'last 9 months' },
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

// "13 May – 12 Jun 2026" (year once when both ends share a year, else on both);
// UTC-fixed, no leading zero -- same date discipline as UsersTable's
// BLOCK_DATE_FORMATTER. Truncation is appended visibly (brief), never a tooltip.
function formatDateRange(fromDate: string, toDate: string, truncated: boolean): string {
  if (!fromDate || !toDate) return '';
  const parse = (iso: string) => {
    const d = new Date(`${iso}T00:00:00.000Z`);
    return { day: d.getUTCDate(), mon: MONTH_NAMES[d.getUTCMonth()], year: d.getUTCFullYear() };
  };
  const a = parse(fromDate);
  const b = parse(toDate);
  const left = a.year === b.year ? `${a.day} ${a.mon}` : `${a.day} ${a.mon} ${a.year}`;
  const right = `${b.day} ${b.mon} ${b.year}`;
  const base = `${left} – ${right}`;
  return truncated ? `${base} · truncated to available history` : base;
}

// Per-month caption: "Mar–May 2026 · 243 user-months · current month excluded
// (partial)" (+ " · truncated to available history" when truncated). Months are
// 'YYYY-MM' ascending; year shown once when both ends share it.
function formatMonthCaption(months: readonly string[], observationCount: number, truncated: boolean): string {
  if (months.length === 0) return '';
  const fmt = (ym: string) => {
    const [y, m] = ym.split('-').map(Number) as [number, number];
    return { mon: MONTH_NAMES[m - 1], year: y };
  };
  const a = fmt(months[0] as string);
  const b = fmt(months[months.length - 1] as string);
  const range =
    months.length === 1
      ? `${a.mon} ${a.year}`
      : a.year === b.year
        ? `${a.mon}–${b.mon} ${b.year}`
        : `${a.mon} ${a.year}–${b.mon} ${b.year}`;
  const base = `${range} · ${observationCount} user-months · current month excluded (partial)`;
  return truncated ? `${base} · truncated to available history` : base;
}

// Monthly-backfill only: appends "+ N unattributed credits in <Mon YYYY>
// (departed users)" per month carrying a nonzero remainder (getUserMonthObserva-
// tions' unattributedCredits; live-github only, absent in sim). Empty string
// when there is nothing to surface, so the caption is unchanged in every other
// case. Months ascending 'YYYY-MM'.
function formatUnattributedNote(unattributed: Record<string, number> | undefined): string {
  if (!unattributed) return '';
  const entries = Object.entries(unattributed)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries
    .map(([ym, n]) => {
      const [y, m] = ym.split('-').map(Number) as [number, number];
      return ` · + ${n.toLocaleString()} unattributed credits in ${MONTH_NAMES[m - 1]} ${y} (departed users)`;
    })
    .join('');
}

// The universal ULB's monthly credit cap, resolved from getControls() the same
// way the Controls screen identifies it (a budget control at scope
// 'universal'); null when no universal ULB exists (state, not silence).
function universalUlbMonthly(controls: readonly ControlState[]): number | null {
  const c = controls.find((x) => x.kind === 'budget' && x.scope === 'universal');
  return c && c.kind === 'budget' ? c.amountCredits : null;
}

const PREFERS_REDUCED_MOTION =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

export function Distribution() {
  const api = useApiClient();
  const [mode, setMode] = useState<Mode>('totals');
  const [months, setMonths] = useState<Months>(1);
  const [windowsCache, setWindowsCache] = useState<ReadonlyMap<Months, UsageDistributionWindow>>(new Map());
  const [obsCache, setObsCache] = useState<ReadonlyMap<Months, UserMonthObservationsResult>>(new Map());
  const [controls, setControls] = useState<ControlState[] | null>(null);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getControls().then((list) => {
      if (!cancelled) setControls(list);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Totals lens: fetch (once) per window, caching by month count so re-selecting
  // a window is instant and never re-hits the bridge. Every launch/scenario-
  // switch remounts this screen, so a stale cache never survives a data change.
  useEffect(() => {
    if (mode !== 'totals') return;
    if (windowsCache.has(months)) return;
    let cancelled = false;
    api.getUsageDistribution({ months }).then((w) => {
      if (cancelled) return;
      setWindowsCache((prev) => {
        const next = new Map(prev);
        next.set(months, w);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, mode, months, windowsCache]);

  // Per-month lens: the parallel per-(window,mode) cache -- keyed by month count
  // in its own map, so switching lens or window never re-hits a cached fetch.
  useEffect(() => {
    if (mode !== 'permonth') return;
    if (obsCache.has(months)) return;
    let cancelled = false;
    api.getUserMonthObservations({ months }).then((r) => {
      if (cancelled) return;
      setObsCache((prev) => {
        const next = new Map(prev);
        next.set(months, r);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, mode, months, obsCache]);

  const totalsData = windowsCache.get(months) ?? null;
  const obsData = obsCache.get(months) ?? null;
  const activeLoaded = mode === 'totals' ? totalsData !== null : obsData !== null;

  // Clear the fade once the newly-selected view's data is present.
  useEffect(() => {
    if (activeLoaded && fading) {
      const id = window.setTimeout(() => setFading(false), 150);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [activeLoaded, fading]);

  function selectWindow(next: Months) {
    if (next === months) return;
    if (!PREFERS_REDUCED_MOTION) setFading(true);
    setMonths(next);
  }

  function selectMode(next: Mode) {
    if (next === mode) return;
    if (!PREFERS_REDUCED_MOTION) setFading(true);
    setMode(next);
  }

  const monthlyUlb = controls ? universalUlbMonthly(controls) : null;
  const conf = WINDOWS.find((w) => w.months === months)!;

  // The histogram's inputs: window-total users (totals) or user-month
  // observations mapped to a synthetic per-observation id (per-month). core is
  // unchanged either way -- it only reads creditsUsed.
  const rawUsers: UserCreditUsage[] = useMemo(() => {
    if (mode === 'totals') {
      return totalsData ? totalsData.users.map((u) => ({ userId: u.userLogin, creditsUsed: u.creditsUsed })) : [];
    }
    return obsData ? obsData.observations.map((o) => ({ userId: `${o.userLogin}:${o.month}`, creditsUsed: o.creditsUsed })) : [];
  }, [mode, totalsData, obsData]);

  const distribution = useMemo(() => (activeLoaded ? computeUsageDistribution(rawUsers) : null), [activeLoaded, rawUsers]);

  // ---- loading ----
  if (controls === null || !activeLoaded || distribution === null) {
    return (
      <div className="distribution" data-testid="distribution">
        <p className="distribution__loading">Loading…</p>
      </div>
    );
  }

  // ---- sentinel / empty (mode-specific copy) ----
  if (rawUsers.length === 0) {
    const permonth = mode === 'permonth';
    return (
      <div className="distribution" data-testid="distribution">
        <DistributionHeader
          userCount={0}
          conf={conf}
          months={months}
          mode={mode}
          dateCaption=""
          onSelect={selectWindow}
          onSelectMode={selectMode}
        />
        <div className="distribution__empty-card" data-testid="distribution-empty-state">
          <div className="distribution__empty-title">{permonth ? 'No complete month yet' : 'No usage history yet'}</div>
          <p className="distribution__empty-body">
            {permonth
              ? 'No complete calendar month in synced history yet — sync again after month end.'
              : 'No per-user credit history has been synced. Run a sync from the Overview screen to populate the distribution.'}
          </p>
        </div>
      </div>
    );
  }

  const n = rawUsers.length;
  const { p30, p50, p95, mean, spread, usersAboveP95, tailSharePct } = distribution;

  // ULB overlay: totals scales the monthly cap by the window's month count;
  // per-month reads the plain monthly amount directly (its whole point).
  const ulbValue = monthlyUlb === null ? null : mode === 'permonth' ? monthlyUlb : monthlyUlb * months;
  const ulbUsersAbove = ulbValue !== null ? countAbove(rawUsers, ulbValue) : null;

  const dateCaption =
    mode === 'permonth' && obsData
      ? formatMonthCaption(obsData.months, obsData.observations.length, obsData.truncated) +
        formatUnattributedNote(obsData.unattributedCredits)
      : totalsData
        ? formatDateRange(totalsData.fromDate, totalsData.toDate, totalsData.truncated)
        : '';

  const noun = mode === 'permonth' ? 'user-month' : 'user';
  const xAxisTitle =
    mode === 'permonth' ? 'credits per user-month (1 cr = $0.01)' : 'total credits per user (1 cr = $0.01)';

  // ---- insight copy (mockup template, live numbers) ----
  const insight = (() => {
    if (mode === 'permonth') {
      const tail = `${usersAboveP95} user-month${usersAboveP95 === 1 ? '' : 's'} sit${usersAboveP95 === 1 ? 's' : ''} above P95; together they account for ${tailSharePct.toFixed(1)}% of total consumption. Consider individual-ULB overrides for the tail rather than raising the shared ceiling.`;
      const head = `The P95 user-month is ${fmtCredits(p95)} cr (${fmtDollars(p95)})`;
      if (ulbValue === null || monthlyUlb === null) {
        return `${head}; no universal ULB is set. ${tail}`;
      }
      return `${head} against the ${fmtDollars(monthlyUlb)} monthly ULB. ${tail}`;
    }
    const head = `In the ${conf.phrase} the median user consumed ${fmtCredits(p50)} credits (${fmtDollars(p50)})`;
    const tail = `${usersAboveP95} user${usersAboveP95 === 1 ? '' : 's'} sit${usersAboveP95 === 1 ? 's' : ''} above P95; together they account for ${tailSharePct.toFixed(1)}% of total consumption. Consider individual-ULB overrides for the tail rather than raising the shared ceiling.`;
    if (ulbValue === null || monthlyUlb === null) {
      return `${head}; no universal ULB is set. ${tail}`;
    }
    const ulbPhrase =
      months > 1
        ? `${fmtDollars(ulbValue)} universal ULB (×${months} the ${fmtDollars(monthlyUlb)} monthly cap)`
        : `${fmtDollars(monthlyUlb)} universal ULB`;
    const relation = p50 < ulbValue ? 'well under' : 'above';
    return `${head} — ${relation} the ${ulbPhrase}. ${tail}`;
  })();

  // Chart-footer caption: totals speaks in "users", per-month in "user-months".
  const footerCaption =
    mode === 'permonth'
      ? `Each observation is one user's spend in one complete calendar month, read against the monthly ULB. N = ${n} user-months · window: ${conf.label}.`
      : `Right-skewed, as expected — a long tail of heavy users pulls the mean above the median. N = ${n} users · window: ${conf.label}.`;

  return (
    <div className="distribution" data-testid="distribution">
      <DistributionHeader
        userCount={n}
        conf={conf}
        months={months}
        mode={mode}
        dateCaption={dateCaption}
        onSelect={selectWindow}
        onSelectMode={selectMode}
      />

      <div className="distribution__card">
        <div className={`distribution__chart-fade${fading ? ' distribution__chart-fade--fading' : ''}`}>
          <DistributionChart
            distribution={distribution}
            ulbValue={ulbValue}
            ulbUsersAbove={ulbUsersAbove}
            xAxisTitle={xAxisTitle}
            aboveNoun={noun}
          />
        </div>
        <div className="distribution__chart-footer">
          <span data-testid="distribution-chart-caption">{footerCaption}</span>
          {ulbValue === null ? (
            <span className="distribution__footer-note mono" data-testid="distribution-ulb-note">
              No universal ULB set — no per-user ceiling to overlay.
            </span>
          ) : mode === 'totals' && months > 1 ? (
            <span className="distribution__footer-note mono" data-testid="distribution-ulb-note">
              ULB line shown ×{months} for multi-month windows (the ULB is a monthly cap).
            </span>
          ) : null}
        </div>
      </div>

      <div className="distribution__tiles">
        <Tile
          label="P30 — light users"
          value={`${fmtCredits(p30)} cr`}
          color="var(--blue)"
          sub={`${fmtDollars(p30)} · 30% of ${noun}s at or below · license-review candidates`}
          testid="distribution-tile-p30"
        />
        <Tile
          label="P50 — typical user"
          value={`${fmtCredits(p50)} cr`}
          color="var(--green)"
          sub={mode === 'permonth' ? `${fmtDollars(p50)} · the median user-month` : `${fmtDollars(p50)} · the median user's spend`}
          testid="distribution-tile-p50"
        />
        <Tile
          label="P95 — heavy-user threshold"
          value={`${fmtCredits(p95)} cr`}
          color="var(--amber)"
          sub={`${fmtDollars(p95)} · informs ULB sizing — ${usersAboveP95} ${noun}${usersAboveP95 === 1 ? '' : 's'} above`}
          testid="distribution-tile-p95"
        />
        <Tile
          label="Spread"
          value={`${spread.toFixed(2)}×`}
          color="#ffffff"
          sub={`P95-to-median ratio · mean ${fmtCredits(mean)} cr vs median ${fmtCredits(p50)} cr`}
          testid="distribution-tile-spread"
        />
      </div>

      <div className="distribution__insight">
        <div className="distribution__insight-glyph" aria-hidden="true">
          ⓘ
        </div>
        <p className="distribution__insight-text" data-testid="distribution-insight">
          {insight}
        </p>
      </div>
    </div>
  );
}

interface HeaderProps {
  userCount: number;
  conf: { months: Months; label: string };
  months: Months;
  mode: Mode;
  dateCaption: string;
  onSelect: (m: Months) => void;
  onSelectMode: (m: Mode) => void;
}

const MODES: ReadonlyArray<{ mode: Mode; label: string }> = [
  { mode: 'totals', label: 'Totals' },
  { mode: 'permonth', label: 'Per month' },
];

function DistributionHeader({ userCount, months, mode, dateCaption, onSelect, onSelectMode }: HeaderProps) {
  return (
    <div className="distribution__header">
      <div>
        <div className="distribution__title">Per-user credit consumption</div>
        <div className="distribution__sub">
          How total AI-credit spend is distributed across the {userCount} licensed user{userCount === 1 ? '' : 's'} in
          the selected window.
        </div>
      </div>
      <div className="distribution__header-right">
        <div className="distribution__controls">
          <div className="distribution__mode" role="tablist" aria-label="Lens">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                role="tab"
                aria-selected={mode === m.mode}
                className={`distribution__window-btn${mode === m.mode ? ' distribution__window-btn--active' : ''}`}
                data-testid={`distribution-mode-${m.mode}`}
                onClick={() => onSelectMode(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="distribution__window" role="tablist" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.months}
                type="button"
                role="tab"
                aria-selected={months === w.months}
                className={`distribution__window-btn${months === w.months ? ' distribution__window-btn--active' : ''}`}
                onClick={() => onSelect(w.months)}
              >
                {w.button}
              </button>
            ))}
          </div>
        </div>
        {dateCaption && (
          <div className="distribution__date-caption mono" data-testid="distribution-date-caption">
            {dateCaption}
          </div>
        )}
      </div>
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  color: string;
  sub: string;
  testid: string;
}

function Tile({ label, value, color, sub, testid }: TileProps) {
  return (
    <div className="distribution__tile" data-testid={testid}>
      <div className="distribution__tile-label">{label}</div>
      <div className="distribution__tile-value" style={{ color }} data-testid={`${testid}-value`}>
        {value}
      </div>
      <div className="distribution__tile-sub">{sub}</div>
    </div>
  );
}
