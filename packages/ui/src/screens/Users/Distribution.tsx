import { useEffect, useMemo, useState } from 'react';
import { computeUsageDistribution, countAbove, type ControlState, type UserCreditUsage } from '@copilot-budget/core';
import type { UsageDistributionWindow } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import { DistributionChart, fmtCredits, fmtDollars } from './DistributionChart';
import './Distribution.css';

type Months = 1 | 3 | 9;

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
  const [months, setMonths] = useState<Months>(1);
  const [windowsCache, setWindowsCache] = useState<ReadonlyMap<Months, UsageDistributionWindow>>(new Map());
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

  // Fetch (once) per window, caching by month count so re-selecting a window is
  // instant and never re-hits the bridge. Every launch/scenario-switch remounts
  // this screen, so a stale cache never survives a data-world change.
  useEffect(() => {
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
  }, [api, months, windowsCache]);

  const data = windowsCache.get(months) ?? null;

  // Clear the fade once the newly-selected window's data is present.
  useEffect(() => {
    if (data && fading) {
      const id = window.setTimeout(() => setFading(false), 150);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [data, fading]);

  function selectWindow(next: Months) {
    if (next === months) return;
    if (!PREFERS_REDUCED_MOTION) setFading(true);
    setMonths(next);
  }

  const monthlyUlb = controls ? universalUlbMonthly(controls) : null;
  const conf = WINDOWS.find((w) => w.months === months)!;

  const distribution = useMemo(() => {
    if (!data) return null;
    const users: UserCreditUsage[] = data.users.map((u) => ({ userId: u.userLogin, creditsUsed: u.creditsUsed }));
    return computeUsageDistribution(users);
  }, [data]);

  // ---- loading ----
  if (controls === null || data === null || distribution === null) {
    return (
      <div className="distribution" data-testid="distribution">
        <p className="distribution__loading">Loading…</p>
      </div>
    );
  }

  // ---- sentinel / empty ----
  if (data.users.length === 0) {
    return (
      <div className="distribution" data-testid="distribution">
        <DistributionHeader
          userCount={0}
          conf={conf}
          months={months}
          dateCaption=""
          onSelect={selectWindow}
        />
        <div className="distribution__empty-card" data-testid="distribution-empty-state">
          <div className="distribution__empty-title">No usage history yet</div>
          <p className="distribution__empty-body">
            No per-user credit history has been synced. Run a sync from the Overview screen to populate the
            distribution.
          </p>
        </div>
      </div>
    );
  }

  const n = data.users.length;
  const { p30, p50, p95, mean, spread, usersAboveP95, tailSharePct } = distribution;
  const ulbValue = monthlyUlb !== null ? monthlyUlb * months : null;
  const ulbUsersAbove =
    ulbValue !== null
      ? countAbove(
          data.users.map((u) => ({ userId: u.userLogin, creditsUsed: u.creditsUsed })),
          ulbValue,
        )
      : null;

  const dateCaption = formatDateRange(data.fromDate, data.toDate, data.truncated);

  // ---- insight copy (mockup template, live numbers) ----
  const insight = (() => {
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

  return (
    <div className="distribution" data-testid="distribution">
      <DistributionHeader userCount={n} conf={conf} months={months} dateCaption={dateCaption} onSelect={selectWindow} />

      <div className="distribution__card">
        <div className={`distribution__chart-fade${fading ? ' distribution__chart-fade--fading' : ''}`}>
          <DistributionChart distribution={distribution} ulbValue={ulbValue} ulbUsersAbove={ulbUsersAbove} />
        </div>
        <div className="distribution__chart-footer">
          <span data-testid="distribution-chart-caption">
            Right-skewed, as expected — a long tail of heavy users pulls the mean above the median. N = {n} users ·
            window: {conf.label}.
          </span>
          {ulbValue === null ? (
            <span className="distribution__footer-note mono" data-testid="distribution-ulb-note">
              No universal ULB set — no per-user ceiling to overlay.
            </span>
          ) : months > 1 ? (
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
          sub={`${fmtDollars(p30)} · 30% of users at or below · license-review candidates`}
          testid="distribution-tile-p30"
        />
        <Tile
          label="P50 — typical user"
          value={`${fmtCredits(p50)} cr`}
          color="var(--green)"
          sub={`${fmtDollars(p50)} · the median user's spend`}
          testid="distribution-tile-p50"
        />
        <Tile
          label="P95 — heavy-user threshold"
          value={`${fmtCredits(p95)} cr`}
          color="var(--amber)"
          sub={`${fmtDollars(p95)} · informs ULB sizing — ${usersAboveP95} user${usersAboveP95 === 1 ? '' : 's'} above`}
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
  dateCaption: string;
  onSelect: (m: Months) => void;
}

function DistributionHeader({ userCount, months, dateCaption, onSelect }: HeaderProps) {
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
