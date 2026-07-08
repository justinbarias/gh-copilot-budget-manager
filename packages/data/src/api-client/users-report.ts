import type { Octokit } from 'octokit';

// R6 reconciliation (wire-contract-r3-r5-r6.md, 2026-07-08 live smoke): the
// per-user Copilot metrics reports are NOT row arrays. The real endpoints are
//   GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day?day=YYYY-MM-DD
//   GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest   (note the /latest suffix)
// and each returns an ASYNC REPORT ENVELOPE:
//   { download_links: string[], report_start_day, report_end_day }
// The per-user records (user_id, user_login, ai_credits_used [added 2026-06-19
// per the GitHub changelog], ...) live in the FILE behind download_links. That
// file's format (JSON array / JSONL / CSV) is NOT documented anywhere we could
// reach, so we sniff it defensively and the read-smoke reports the real format
// + first-record keys back for the maintainer to pin on the next live run.
//
// Cycle-accuracy (money-affecting, decided in the contract): users-28-day is a
// TRAILING-28-day aggregate that crosses the billing-cycle boundary, so it can
// NOT be the cycle-total source (ULBs bind on the CYCLE total). Cycle-accurate
// per-user totals come from users-1-day fanned out over the elapsed cycle days
// and summed. That fan-out runs only inside the explicit "Sync now" job, so the
// call count is acceptable (contract ruling).

const DAY_MS = 24 * 60 * 60 * 1000;

export type UsersReport = 'users-1-day' | 'users-28-day';

export type ReportFormat = 'json' | 'jsonl' | 'csv' | 'empty';

export interface UsersReportRecord {
  user_id: string;
  user_login: string;
  ai_credits_used: number;
  // Simulation-only enrichment (never a documented field on this report) --
  // rides the per-day fixture files so the Users screen's model-mix bar keeps
  // working in sim; always absent against real GitHub. Parsed optionally.
  model?: string;
}

export interface DatedUsersReportRecord extends UsersReportRecord {
  date: string; // the users-1-day `day` this record was fetched for
}

export interface UsersReportEnvelope {
  download_links: string[];
  report_start_day?: string;
  report_end_day?: string;
}

export interface FetchedUsersReport {
  envelope: UsersReportEnvelope;
  records: UsersReportRecord[];
  format: ReportFormat;
}

// Sniff JSON-array vs JSONL vs CSV from the file's leading non-whitespace.
// A leading `[` is a JSON array; a leading `{` is treated as newline-delimited
// JSON objects (JSONL); anything else is assumed CSV-with-header. Exported so
// the read-smoke can report the real live format verbatim.
export function sniffReportFormat(text: string): ReportFormat {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('{')) return 'jsonl';
  return 'csv';
}

function coerceRecord(raw: Record<string, unknown>): UsersReportRecord {
  const record: UsersReportRecord = {
    user_id: String(raw.user_id ?? ''),
    user_login: String(raw.user_login ?? ''),
    ai_credits_used: Number(raw.ai_credits_used ?? 0),
  };
  if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
    record.model = String(raw.model);
  }
  return record;
}

function parseCsv(text: string): UsersReportRecord[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const raw: Record<string, unknown> = {};
    header.forEach((key, i) => {
      raw[key] = cols[i]?.trim();
    });
    return coerceRecord(raw);
  });
}

// Defensive parse of the downloaded report file. Returns both the parsed
// records and the sniffed format (the read-smoke surfaces the format).
export function parseUsersReportFile(text: string): { records: UsersReportRecord[]; format: ReportFormat } {
  const format = sniffReportFormat(text);
  if (format === 'empty') return { records: [], format };
  if (format === 'json') {
    const parsed = JSON.parse(text.trim());
    const rows = Array.isArray(parsed) ? parsed : [];
    return { records: rows.map((r) => coerceRecord(r as Record<string, unknown>)), format };
  }
  if (format === 'jsonl') {
    const rows = text
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => coerceRecord(JSON.parse(l) as Record<string, unknown>));
    return { records: rows, format };
  }
  return { records: parseCsv(text), format };
}

// ---------------------------------------------------------------------------
// Endpoint-variant fallback (2026-07-08 second live smoke). The maintainer's
// real tenant 400'd on the DOCUMENTED `users-28-day/latest` route with a
// day-parse error ("Invalid day parameter...") -- i.e. its router serves
// `/users-28-day/{day}` (a PATH param) and has no literal `/latest` route, a
// genuine docs-vs-deployment divergence (docs.github.com enterprise-cloud@
// latest still documents `/latest` and a REQUIRED `?day=` QUERY param on
// users-1-day). Each report therefore has two wire variants:
//   users-28-day: 'latest'    -> .../users-28-day/latest        (documented)
//                 'day-path'  -> .../users-28-day/{day}         (observed tenant)
//   users-1-day:  'day-query' -> .../users-1-day?day=YYYY-MM-DD (documented)
//                 'day-path'  -> .../users-1-day/{day}          (inferred same-router)
// The documented form is ALWAYS tried first; ONLY an HTTP 400/404 on it
// triggers the fallback (any other status propagates unmasked -- a 401/403/500
// is a real error, not a routing divergence). If both variants fail, the
// SECOND variant's error is thrown (it is the more specific signal once the
// documented route is known-absent). Whichever variant succeeds is memoised
// PER OCTOKIT INSTANCE (WeakMap -- one ApiClient owns one Octokit), so a
// 106-day Sync backfill pays at most ONE failed probe, not 106.
// ---------------------------------------------------------------------------

type Users28Variant = 'latest' | 'day-path';
type Users1Variant = 'day-query' | 'day-path';

interface VariantMemo {
  users28?: Users28Variant;
  users1?: Users1Variant;
}

const variantMemoByClient = new WeakMap<Octokit, VariantMemo>();

function memoFor(octokit: Octokit): VariantMemo {
  let memo = variantMemoByClient.get(octokit);
  if (!memo) {
    memo = {};
    variantMemoByClient.set(octokit, memo);
  }
  return memo;
}

// Only these two statuses mean "this route shape doesn't exist on this
// tenant": 404 = no route matched; 400 = the router matched a {day} segment
// and rejected our literal/missing value as a date (the exact live failure).
function isVariantMissSignal(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 400 || status === 404;
}

// The "latest-equivalent" day used when the users-28-day PATH-param variant
// needs a day and the caller supplied none: YESTERDAY (UTC) -- the most recent
// day whose report can be expected to exist and be complete (today's report
// may not be generated yet, and the tenant's own error text says the day may
// not be in the future). Callers with a clock seam (the smoke, Sync) pass an
// explicit day instead, so this wall-clock default only serves a bare live
// invocation.
function utcYesterday(): string {
  return new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
}

async function requestEnvelope(
  octokit: Octokit,
  enterprise: string,
  report: UsersReport,
  variant: Users28Variant | Users1Variant,
  day: string,
): Promise<UsersReportEnvelope> {
  if (report === 'users-28-day') {
    if (variant === 'latest') {
      const r = await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest', { enterprise });
      return r.data as UsersReportEnvelope;
    }
    const r = await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/{day}', { enterprise, day });
    return r.data as UsersReportEnvelope;
  }
  if (variant === 'day-query') {
    const r = await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day', { enterprise, day });
    return r.data as UsersReportEnvelope;
  }
  const r = await octokit.request('GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day/{day}', { enterprise, day });
  return r.data as UsersReportEnvelope;
}

// Follow a report envelope's first download link and sniff+parse the file.
// The download-link fetch is a hand-wrapped, non-Octokit HTTP call (§6.9): the
// link points at an opaque results host (a short-lived signed URL), so a plain
// `fetch` is correct and Octokit's typed surface does not apply. Exported so
// the read-smoke's multi-variant probe can reuse it verbatim.
export async function downloadReportRecords(
  envelope: UsersReportEnvelope,
): Promise<{ records: UsersReportRecord[]; format: ReportFormat }> {
  const links = Array.isArray(envelope.download_links) ? envelope.download_links : [];
  if (links.length === 0) return { records: [], format: 'empty' };
  const fileResponse = await fetch(links[0]!);
  const text = await fileResponse.text();
  return parseUsersReportFile(text);
}

// One report fetch: envelope (with variant fallback, above) -> follow the
// first download link -> sniff+parse.
export async function fetchUsersReport(
  octokit: Octokit,
  enterprise: string,
  report: UsersReport,
  params: { day?: string } = {},
): Promise<FetchedUsersReport> {
  const memo = memoFor(octokit);
  const day = params.day ?? utcYesterday();

  // A memoised variant is used exclusively (no re-probing, and a failure on it
  // propagates as-is -- once a variant has succeeded on this tenant, a later
  // error on it is a real error, not a routing divergence).
  const known = report === 'users-28-day' ? memo.users28 : memo.users1;
  const variants: Array<Users28Variant | Users1Variant> = known
    ? [known]
    : report === 'users-28-day'
      ? ['latest', 'day-path']
      : ['day-query', 'day-path'];

  let envelope: UsersReportEnvelope;
  let used = variants[0]!;
  try {
    envelope = await requestEnvelope(octokit, enterprise, report, used, day);
  } catch (err) {
    if (variants.length < 2 || !isVariantMissSignal(err)) throw err;
    // Documented form is absent on this tenant -- retry the path-param form.
    // If this one ALSO fails, its error propagates (the more specific signal).
    used = variants[1]!;
    envelope = await requestEnvelope(octokit, enterprise, report, used, day);
  }
  if (report === 'users-28-day') memo.users28 = used as Users28Variant;
  else memo.users1 = used as Users1Variant;

  const links = Array.isArray(envelope.download_links) ? envelope.download_links : [];
  const { records, format } = await downloadReportRecords(envelope);
  return { envelope: { ...envelope, download_links: links }, records, format };
}

// Sync-only fan-out concurrency: each users-1-day call is an envelope request
// + a file download, and the historical backfill (below) covers ~90-106 days
// per Sync -- fully sequential would make "Sync now" crawl, while an unbounded
// Promise.all over 100+ days risks tripping secondary rate limits live. 10 in
// flight is the middle ground (~11 waves for a 106-day sync).
const USERS_REPORT_CONCURRENCY = 10;

// Fan users-1-day out over an arbitrary list of days (chunked, see above),
// tagging each record with the day it was fetched for. Results are keyed by
// day (ordering-independent within a chunk); the returned array follows the
// caller's day order. A valid day with no usage returns an empty file -- a
// cheap no-op, so sparse historical windows cost little beyond the round-trip.
export async function fetchUserCreditsForDays(
  octokit: Octokit,
  enterprise: string,
  days: readonly string[],
  concurrency: number = USERS_REPORT_CONCURRENCY,
): Promise<DatedUsersReportRecord[]> {
  if (days.length === 0) return [];
  const byDay = new Map<string, DatedUsersReportRecord[]>();

  // Resolve the endpoint variant on the FIRST day alone, before any concurrent
  // wave: fetchUsersReport memoises the working variant per Octokit instance,
  // so a divergent tenant costs exactly ONE failed probe for the whole fan-out
  // -- not one per call in the first concurrent chunk (which would all start
  // before any of them had populated the memo).
  {
    const firstDay = days[0]!;
    const { records } = await fetchUsersReport(octokit, enterprise, 'users-1-day', { day: firstDay });
    byDay.set(
      firstDay,
      records.map((r) => ({ ...r, date: firstDay })),
    );
  }

  const rest = days.slice(1);
  for (let i = 0; i < rest.length; i += concurrency) {
    const chunk = rest.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (day) => {
        const { records } = await fetchUsersReport(octokit, enterprise, 'users-1-day', { day });
        byDay.set(
          day,
          records.map((r) => ({ ...r, date: day })),
        );
      }),
    );
  }
  return days.flatMap((day) => byDay.get(day) ?? []);
}

// Cycle-accurate per-user credits: fan users-1-day out over every elapsed cycle
// day (dates from the caller's cycleBounds/clock seam -- NEVER wall-clock in
// sim) and tag each record with its day. Summing these per user gives the
// cross-phase cycle total a ULB binds on. Replaces the old bare users-28-day
// array read (which returned a trailing-28-day aggregate that could not be
// cycle-scoped).
export async function fetchCycleUserCredits(
  octokit: Octokit,
  enterprise: string,
  cycleStart: Date,
  daysElapsed: number,
): Promise<DatedUsersReportRecord[]> {
  const days: string[] = [];
  for (let i = 0; i <= daysElapsed; i++) {
    days.push(new Date(cycleStart.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  }
  return fetchUserCreditsForDays(octokit, enterprise, days);
}
