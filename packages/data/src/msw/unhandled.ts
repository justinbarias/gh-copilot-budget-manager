// Live-mode-hardening: the runtime simulation consumer (apps/desktop/src/main/
// index.ts) used `onUnhandledRequest: 'bypass'`, which silently lets ANY
// unmocked request through to the real network. For a GitHub API host that is
// a genuine safety bug (CLAUDE.md §6.8/§8): in simulation mode NO request may
// reach real GitHub, so an unmocked GitHub call must SCREAM, not leak. But we
// must not break legitimate non-GitHub traffic (dev-server assets, telemetry,
// etc.), so those keep bypassing.
//
// This is MSW's function-form `onUnhandledRequest` callback: `print.error()`
// throws (failing the request loudly); doing nothing bypasses.

export function isGitHubApiHost(hostname: string): boolean {
  // api.github.com (public) and api.SUBDOMAIN.ghe.com (GHE.com data residency,
  // spec §2). `.ghe.com` suffix match covers every subdomain host.
  return hostname === 'api.github.com' || hostname.endsWith('.ghe.com');
}

export interface UnhandledPrint {
  warning(): void;
  error(): void;
}

export function failLoudForGitHub(request: Request, print: UnhandledPrint): void {
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return; // unparseable URL -- not a GitHub host we can identify; leave it alone
  }
  if (isGitHubApiHost(hostname)) {
    // An unmocked GitHub API request in simulation mode is a bug (a missing
    // handler, or a real network leak) -- throw so it is impossible to miss.
    print.error();
  }
  // Everything else: bypass (no-op), same as the previous 'bypass' behavior.
}
