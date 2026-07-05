import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../msw/server.js';
import { ENTERPRISE_SLUG } from '../msw/fixtures/index.js';
import { createTenantConfigStore } from '../tenant/store.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { createGitHubApiClient } from './github-impl.js';

// Task 9.1/9.2-prep: the four new bridge methods, proven against the SAME MSW
// server every other consumer uses (the /rate_limit twin + the read surface).
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('9.1/9.2 bridge methods', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-tenant-smoke-'));
    db = createDb(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeClient(overrides: Partial<Parameters<typeof createGitHubApiClient>[0]> = {}) {
    return createGitHubApiClient({ enterprise: ENTERPRISE_SLUG, db, source: 'msw', ...overrides });
  }

  describe('validatePat', () => {
    it('classifies a classic PAT carrying manage_billing:enterprise as ok', async () => {
      const client = makeClient({ getPat: async () => 'ghp_classicWithScope' });
      const result = await client.validatePat();
      expect(result).toMatchObject({ ok: true, tokenKind: 'classic', hasManageBillingEnterprise: true });
      expect(result.scopes).toContain('manage_billing:enterprise');
    });

    it('flags a classic PAT missing the scope (not ok)', async () => {
      const client = makeClient({ getPat: async () => 'ghp_noscopeClassic' });
      const result = await client.validatePat();
      expect(result).toMatchObject({ ok: false, tokenKind: 'classic', hasManageBillingEnterprise: false });
      expect(result.scopes).not.toContain('manage_billing:enterprise');
    });

    it('classifies a fine-grained token (github_pat_ prefix, no X-OAuth-Scopes header)', async () => {
      const client = makeClient({ getPat: async () => 'github_pat_11ABC' });
      const result = await client.validatePat();
      expect(result).toMatchObject({ ok: false, tokenKind: 'fine_grained', hasManageBillingEnterprise: false });
      expect(result.scopes).toEqual([]);
    });

    it('reports an invalid token on 401', async () => {
      const client = makeClient({ getPat: async () => 'ghp_invalidToken' });
      const result = await client.validatePat();
      expect(result).toMatchObject({ ok: false, tokenKind: 'invalid' });
      expect(result.message).toMatch(/401/);
    });

    it('reports no token when none is stored', async () => {
      const client = makeClient({ getPat: async () => null });
      const result = await client.validatePat();
      expect(result).toMatchObject({ ok: false, tokenKind: 'invalid' });
      expect(result.message).toMatch(/no token/i);
    });
  });

  describe('runLiveReadSmoke', () => {
    it('refuses in simulation mode and never contacts GitHub', async () => {
      const client = makeClient();
      expect(await client.runLiveReadSmoke()).toEqual({ refused: true, reason: 'simulation mode' });
    });

    it('runs the read surface in live (github) mode and returns per-endpoint results', async () => {
      // A 'github'-source client still hits MSW here (MSW intercepts
      // api.github.com), which is how we prove the runner plumbing pre-PAT.
      const client = makeClient({ source: 'github' });
      const result = await client.runLiveReadSmoke();
      expect(result.refused).toBe(false);
      if (result.refused) return; // narrow
      expect(result.results.map((r) => r.docRef)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
      for (const r of result.results) {
        expect(r.status, `${r.docRef}: ${r.details}`).toBe('ok');
      }
    });
  });

  describe('getTenantConfig/setTenantConfig', () => {
    it('round-trips through an injected store', async () => {
      const store = createTenantConfigStore(path.join(tmpDir, 'tenant.json'));
      const client = makeClient({ tenantConfig: store });
      expect(await client.getTenantConfig()).toBeNull();
      await client.setTenantConfig({ hostKind: 'ghe.com', gheSubdomain: 'acme', enterpriseSlug: 'my-ent' });
      expect(await client.getTenantConfig()).toEqual({ hostKind: 'ghe.com', gheSubdomain: 'acme', enterpriseSlug: 'my-ent' });
    });

    it('reports null and refuses to persist when no store is configured', async () => {
      const client = makeClient();
      expect(await client.getTenantConfig()).toBeNull();
      await expect(client.setTenantConfig({ hostKind: 'github.com', enterpriseSlug: 'e' })).rejects.toThrow(/not available/i);
    });

    it('rejects an invalid tenant config before touching the store', async () => {
      const store = createTenantConfigStore(path.join(tmpDir, 'tenant.json'));
      const client = makeClient({ tenantConfig: store });
      await expect(client.setTenantConfig({ hostKind: 'ghe.com', enterpriseSlug: 'e' })).rejects.toThrow(/subdomain/i);
    });
  });

  describe('clock seam (live path)', () => {
    it('anchors cycleAsOfDate to an injected live nowDate', async () => {
      const client = makeClient({ source: 'github', nowDate: '2026-06-20' });
      const summary = await client.getUsageSummary();
      expect(summary.cycleAsOfDate).toBe('2026-06-20');
    });
  });
});
