// Tenant configuration (Task 9.1): the non-secret "where is this enterprise"
// pointer -- host (github.com vs a GHE.com subdomain) + enterprise slug --
// that the GitHub client derives its baseUrl and enterprise paths from in live
// mode. Unlike the PAT (§6.6, safeStorage-only), this carries no secret, so it
// is persisted as plain JSON (see store.ts), NOT through safeStorage.
//
// Pure, I/O-free module so the API-boundary type (re-exported onto the
// ApiClient interface via api-client/types.ts) can be named by a browser-side
// consumer (packages/ui) without pulling node:fs (which store.ts uses).
export interface TenantConfig {
  /** github.com (api.github.com) vs a GHE.com data-residency subdomain. */
  hostKind: 'github.com' | 'ghe.com';
  /** Required iff hostKind is 'ghe.com' -- the SUBDOMAIN in api.SUBDOMAIN.ghe.com (spec §2). Ignored for github.com. */
  gheSubdomain?: string;
  /** The enterprise slug used in every `/enterprises/{enterprise}/...` path. */
  enterpriseSlug: string;
}

// Spec §2: github.com uses api.github.com; GHE.com swaps the host to
// api.SUBDOMAIN.ghe.com. Pure so it can be unit-tested and reused by both the
// data client (baseUrl) and any future host-aware consumer.
export function resolveBaseUrl(config: TenantConfig): string {
  if (config.hostKind === 'ghe.com') {
    const sub = config.gheSubdomain?.trim();
    if (!sub) {
      throw new Error('GHE.com tenant config requires a gheSubdomain');
    }
    return `https://api.${sub}.ghe.com`;
  }
  return 'https://api.github.com';
}

// Request-routing charset allowlists. `gheSubdomain` lands in the request HOST
// (resolveBaseUrl -> https://api.<sub>.ghe.com) and `enterpriseSlug` lands in
// every `/enterprises/{enterprise}/...` path, so both are untrusted input that
// steers where a live request actually goes. A subdomain like `evil.com/api`
// (the `/` truncates the host to `api.evil.com`) or a slug like `x/../../other`
// must be rejected BEFORE it is persisted or used to build a baseUrl. This is
// defence-in-depth: Octokit URL-encodes path params (so the slug is doubly
// contained), but the baseUrl host is interpolated raw, so the subdomain guard
// is load-bearing. Both patterns are a single DNS-label / slug: an
// alphanumeric-bounded run of the allowed characters (no slashes, dots, colons,
// @, or whitespace).
const ENTERPRISE_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const GHE_SUBDOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

// Minimal structural + charset validation shared by setTenantConfig (data
// client), the ApiClient bridge, and the persistence layer -- rejects any state
// that would produce a broken OR attacker-steerable baseUrl / enterprise path.
// Returns an error message, or null when valid. Trims first so surrounding
// whitespace (the store normalizes it away on write) is not itself a rejection.
export function validateTenantConfig(config: TenantConfig): string | null {
  const slug = config.enterpriseSlug?.trim() ?? '';
  if (slug === '') {
    return 'Enterprise slug is required.';
  }
  if (!ENTERPRISE_SLUG_RE.test(slug)) {
    return 'Enterprise slug may contain only letters, digits, hyphens, and underscores (no slashes, dots, or spaces).';
  }
  if (config.hostKind === 'ghe.com') {
    const sub = config.gheSubdomain?.trim() ?? '';
    if (sub === '') {
      return 'A GHE.com subdomain is required when the host is ghe.com.';
    }
    if (!GHE_SUBDOMAIN_RE.test(sub)) {
      return 'The GHE.com subdomain must be a single hostname label (letters, digits, and hyphens only).';
    }
  }
  return null;
}
