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

// One report fetch: envelope -> follow the first download link -> sniff+parse.
// The download-link fetch is a NEW hand-wrapped, non-Octokit HTTP call (§6.9):
// the link points at an opaque results host (GitHub's docs describe it as a
// short-lived signed URL), so a plain `fetch` is correct and Octokit's typed
// surface does not apply. It is added to the §6.9 validation inventory (the
// validator folds it into docs/api-surface-validation.md).
export async function fetchUsersReport(
  octokit: Octokit,
  enterprise: string,
  report: UsersReport,
  params: { day?: string } = {},
): Promise<FetchedUsersReport> {
  const path =
    report === 'users-28-day'
      ? '/enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest'
      : '/enterprises/{enterprise}/copilot/metrics/reports/users-1-day';
  const requestParams: Record<string, string> = { enterprise };
  if (params.day) requestParams.day = params.day;

  const response = await octokit.request(`GET ${path}`, requestParams);
  const envelope = response.data as UsersReportEnvelope;
  const links = Array.isArray(envelope.download_links) ? envelope.download_links : [];
  if (links.length === 0) {
    return { envelope: { ...envelope, download_links: links }, records: [], format: 'empty' };
  }

  const fileResponse = await fetch(links[0]!);
  const text = await fileResponse.text();
  const { records, format } = parseUsersReportFile(text);
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
  const byDay = new Map<string, DatedUsersReportRecord[]>();
  for (let i = 0; i < days.length; i += concurrency) {
    const chunk = days.slice(i, i + concurrency);
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
