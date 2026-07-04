import { describe, expect, it } from 'vitest';
import { buildLinkHeader, paginate } from './pagination';

describe('paginate', () => {
  it('slices the requested page at the requested size', () => {
    const items = Array.from({ length: 35 }, (_, i) => i);
    expect(paginate(items, 1, 30)).toEqual(items.slice(0, 30));
    expect(paginate(items, 2, 30)).toEqual(items.slice(30, 35));
  });

  it('returns an empty page past the end of the collection', () => {
    const items = [1, 2, 3];
    expect(paginate(items, 5, 30)).toEqual([]);
  });
});

describe('buildLinkHeader', () => {
  const url = 'https://api.github.com/enterprises/acme/copilot/billing/seats?page=1&per_page=30';

  it('omits Link entirely when everything fits on one page', () => {
    expect(buildLinkHeader(url, 1, 30, 10)).toBeUndefined();
  });

  it('includes rel="next" and rel="last" on the first of several pages', () => {
    const header = buildLinkHeader(url, 1, 30, 65);
    expect(header).toContain('rel="next"');
    expect(header).toContain('page=2');
    expect(header).toContain('rel="last"');
    expect(header).toContain('page=3');
    expect(header).not.toContain('rel="prev"');
  });

  it('includes rel="prev" and rel="first" on a middle page, and rel="next"/"last" toward the end', () => {
    const header = buildLinkHeader(url, 2, 30, 65);
    expect(header).toContain('rel="prev"');
    expect(header).toContain('rel="first"');
    expect(header).toContain('rel="next"');
    expect(header).toContain('rel="last"');
  });

  it('omits rel="next"/"last" on the final page', () => {
    const header = buildLinkHeader(url, 3, 30, 65);
    expect(header).toContain('rel="prev"');
    expect(header).not.toContain('rel="next"');
    expect(header).not.toContain('rel="last"');
  });
});
