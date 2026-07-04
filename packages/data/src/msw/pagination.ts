export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

export function buildLinkHeader(
  requestUrl: string,
  page: number,
  perPage: number,
  totalCount: number,
): string | undefined {
  const lastPage = Math.max(1, Math.ceil(totalCount / perPage));
  if (lastPage <= 1) return undefined;

  const pageUrl = (targetPage: number) => {
    const url = new URL(requestUrl);
    url.searchParams.set('page', String(targetPage));
    url.searchParams.set('per_page', String(perPage));
    return url.toString();
  };

  const links: Array<[number, string]> = [];
  if (page > 1) {
    links.push([page - 1, 'prev']);
    links.push([1, 'first']);
  }
  if (page < lastPage) {
    links.push([page + 1, 'next']);
    links.push([lastPage, 'last']);
  }

  return links.map(([targetPage, rel]) => `<${pageUrl(targetPage)}>; rel="${rel}"`).join(', ');
}
