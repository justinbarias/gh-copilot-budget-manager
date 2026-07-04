import { http, HttpResponse } from 'msw';
import { buildLinkHeader, paginate } from './pagination';
import {
  BUDGETS,
  COST_CENTER_RESOURCES,
  COST_CENTERS,
  CREDITS_USED_ITEMS,
  GITHUB_API_BASE,
  SEATS,
  USAGE_ITEMS,
} from './fixtures';

const ENTERPRISE_BASE = `${GITHUB_API_BASE}/enterprises/:enterprise`;

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Number(url.searchParams.get('page') ?? '1');
  const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? '30'));
  return { page, perPage };
}

function linkHeaders(requestUrl: string, page: number, perPage: number, total: number): Record<string, string> | undefined {
  const link = buildLinkHeader(requestUrl, page, perPage, total);
  return link ? { Link: link } : undefined;
}

export const handlers = [
  http.get(`${ENTERPRISE_BASE}/copilot/billing/seats`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(
      { total_seats: SEATS.length, seats: paginate(SEATS, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, SEATS.length) },
    );
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/cost-centers`, () => {
    return HttpResponse.json({ costCenters: COST_CENTERS });
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/cost-centers/:costCenterId/resource`, ({ request, params }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    const all = COST_CENTER_RESOURCES[params.costCenterId as string] ?? [];
    return HttpResponse.json(
      { resources: paginate(all, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, all.length) },
    );
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/budgets`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(
      { budgets: paginate(BUDGETS, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, BUDGETS.length) },
    );
  }),

  http.get(`${ENTERPRISE_BASE}/settings/billing/usage`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    const costCenterId = url.searchParams.get('cost_center_id');
    const filtered = costCenterId ? USAGE_ITEMS.filter((item) => item.cost_center_id === costCenterId) : USAGE_ITEMS;
    return HttpResponse.json(
      { usageItems: paginate(filtered, page, perPage) },
      { headers: linkHeaders(request.url, page, perPage, filtered.length) },
    );
  }),

  http.get(`${ENTERPRISE_BASE}/copilot/metrics/reports/users-28-day`, ({ request }) => {
    const url = new URL(request.url);
    const { page, perPage } = pageParams(url);
    return HttpResponse.json(paginate(CREDITS_USED_ITEMS, page, perPage), {
      headers: linkHeaders(request.url, page, perPage, CREDITS_USED_ITEMS.length),
    });
  }),
];
