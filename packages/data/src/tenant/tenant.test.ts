import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBaseUrl, validateTenantConfig, type TenantConfig } from './types.js';
import { createTenantConfigStore } from './store.js';

describe('resolveBaseUrl', () => {
  it('uses api.github.com for github.com', () => {
    expect(resolveBaseUrl({ hostKind: 'github.com', enterpriseSlug: 'acme' })).toBe('https://api.github.com');
  });

  it('swaps to api.SUBDOMAIN.ghe.com for ghe.com (spec §2)', () => {
    expect(resolveBaseUrl({ hostKind: 'ghe.com', gheSubdomain: 'acme', enterpriseSlug: 'e' })).toBe('https://api.acme.ghe.com');
  });

  it('throws when ghe.com has no subdomain', () => {
    expect(() => resolveBaseUrl({ hostKind: 'ghe.com', enterpriseSlug: 'e' })).toThrow(/subdomain/i);
  });
});

describe('validateTenantConfig', () => {
  it('accepts a valid github.com config', () => {
    expect(validateTenantConfig({ hostKind: 'github.com', enterpriseSlug: 'acme' })).toBeNull();
  });

  it('rejects an empty enterprise slug', () => {
    expect(validateTenantConfig({ hostKind: 'github.com', enterpriseSlug: '  ' })).toMatch(/slug/i);
  });

  it('rejects ghe.com without a subdomain', () => {
    expect(validateTenantConfig({ hostKind: 'ghe.com', enterpriseSlug: 'acme' })).toMatch(/subdomain/i);
  });

  it('accepts a valid ghe.com config and a hyphenated slug', () => {
    expect(
      validateTenantConfig({ hostKind: 'ghe.com', gheSubdomain: 'acme', enterpriseSlug: 'acme-enterprise' }),
    ).toBeNull();
  });

  it('rejects an enterprise slug with path-traversal / slash characters (URL-injection guard)', () => {
    expect(validateTenantConfig({ hostKind: 'github.com', enterpriseSlug: 'x/../../other' })).toMatch(/slug/i);
    expect(validateTenantConfig({ hostKind: 'github.com', enterpriseSlug: 'a b' })).toMatch(/slug/i);
  });

  it('rejects a gheSubdomain that is not a bare hostname label (URL-injection guard)', () => {
    // `evil.com/api` would truncate the request host to api.evil.com.
    expect(validateTenantConfig({ hostKind: 'ghe.com', gheSubdomain: 'evil.com/api', enterpriseSlug: 'acme' })).toMatch(
      /subdomain|label/i,
    );
    expect(validateTenantConfig({ hostKind: 'ghe.com', gheSubdomain: 'a.b', enterpriseSlug: 'acme' })).toMatch(
      /subdomain|label/i,
    );
  });
});

describe('createTenantConfigStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tenant-store-'));
    filePath = path.join(dir, 'tenant-config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null before anything is written', async () => {
    const store = createTenantConfigStore(filePath);
    expect(await store.get()).toBeNull();
  });

  it('round-trips a github.com config', async () => {
    const store = createTenantConfigStore(filePath);
    const config: TenantConfig = { hostKind: 'github.com', enterpriseSlug: 'dewr' };
    await store.set(config);
    expect(await store.get()).toEqual(config);
  });

  it('round-trips a ghe.com config and trims fields', async () => {
    const store = createTenantConfigStore(filePath);
    await store.set({ hostKind: 'ghe.com', gheSubdomain: ' acme ', enterpriseSlug: ' my-ent ' });
    expect(await store.get()).toEqual({ hostKind: 'ghe.com', gheSubdomain: 'acme', enterpriseSlug: 'my-ent' });
  });

  it('drops a stale gheSubdomain when switching to github.com', async () => {
    const store = createTenantConfigStore(filePath);
    await store.set({ hostKind: 'ghe.com', gheSubdomain: 'acme', enterpriseSlug: 'e' });
    await store.set({ hostKind: 'github.com', gheSubdomain: 'acme', enterpriseSlug: 'e' });
    expect(await store.get()).toEqual({ hostKind: 'github.com', enterpriseSlug: 'e' });
  });

  it('rejects an invalid config on set', async () => {
    const store = createTenantConfigStore(filePath);
    await expect(store.set({ hostKind: 'ghe.com', enterpriseSlug: 'e' })).rejects.toThrow(/subdomain/i);
    expect(await store.get()).toBeNull();
  });

  it('refuses to persist a URL-injecting subdomain (charset guard enforced at the store)', async () => {
    const store = createTenantConfigStore(filePath);
    await expect(
      store.set({ hostKind: 'ghe.com', gheSubdomain: 'evil.com/api', enterpriseSlug: 'acme' }),
    ).rejects.toThrow(/subdomain|label/i);
    expect(await store.get()).toBeNull();
  });
});
