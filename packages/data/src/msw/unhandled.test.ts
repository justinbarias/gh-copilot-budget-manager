import { describe, expect, it, vi } from 'vitest';
import { failLoudForGitHub, isGitHubApiHost } from './unhandled.js';

describe('isGitHubApiHost', () => {
  it('matches api.github.com', () => {
    expect(isGitHubApiHost('api.github.com')).toBe(true);
  });

  it('matches any *.ghe.com host (GHE.com data residency, spec §2)', () => {
    expect(isGitHubApiHost('api.acme.ghe.com')).toBe(true);
    expect(isGitHubApiHost('acme.ghe.com')).toBe(true);
  });

  it('does not match non-GitHub hosts', () => {
    expect(isGitHubApiHost('localhost')).toBe(false);
    expect(isGitHubApiHost('example.com')).toBe(false);
    // A look-alike that merely CONTAINS github must not match.
    expect(isGitHubApiHost('api.github.com.evil.example')).toBe(false);
  });
});

describe('failLoudForGitHub', () => {
  function print() {
    return { warning: vi.fn(), error: vi.fn() };
  }

  it('throws (print.error) for an unmocked GitHub API request', () => {
    const p = print();
    failLoudForGitHub(new Request('https://api.github.com/user'), p);
    expect(p.error).toHaveBeenCalledOnce();
    expect(p.warning).not.toHaveBeenCalled();
  });

  it('throws for a GHE.com host', () => {
    const p = print();
    failLoudForGitHub(new Request('https://api.acme.ghe.com/enterprises/x/settings/billing/budgets'), p);
    expect(p.error).toHaveBeenCalledOnce();
  });

  it('bypasses (does nothing) for non-GitHub traffic', () => {
    const p = print();
    failLoudForGitHub(new Request('http://localhost:5173/index.html'), p);
    expect(p.error).not.toHaveBeenCalled();
    expect(p.warning).not.toHaveBeenCalled();
  });
});
