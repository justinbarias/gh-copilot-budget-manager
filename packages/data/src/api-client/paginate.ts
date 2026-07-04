import type { Octokit } from 'octokit';

// Follows the Link `rel="next"` header rather than Octokit's paginate plugin:
// these enterprise billing routes aren't in Octokit's typed endpoint catalog
// (they're 2026-dated per the PRD), so paginate's route-based overloads don't
// apply — a plain request loop keeps this correct without fighting generics.
//
// Lives in its own module (not inlined in github-impl.ts) so the Task 4.8
// write engine's live-read (write/live-state.ts) can import it directly
// instead of importing FROM github-impl.ts, which would create a module
// cycle: github-impl.ts calls into write/engine.ts (for getControls/
// dryRunPlan/applyPlan), and write/engine.ts calls into write/live-state.ts
// -- so live-state.ts importing back from github-impl.ts would close the
// loop. This module has no dependents inside that cycle, so both sides can
// depend on it safely.
export async function paginateAll<T>(
  octokit: Octokit,
  url: string,
  params: Record<string, string | number | undefined>,
  extract: (data: unknown) => T[],
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  const perPage = 100;

  for (;;) {
    const response = await octokit.request(`GET ${url}`, { ...params, page, per_page: perPage });
    results.push(...extract(response.data));

    const link = response.headers.link;
    if (!link || !link.includes('rel="next"')) break;
    page += 1;
  }

  return results;
}
