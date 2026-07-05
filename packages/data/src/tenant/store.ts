import { readFile, writeFile } from 'node:fs/promises';
import { validateTenantConfig, type TenantConfig } from './types.js';

// Task 9.1: persistence for the non-secret tenant pointer. Deliberately mirrors
// pat/storage.ts's shape (a factory over an injected file path, behind an
// interface) so the Electron main process owns *where* the file lives
// (app.getPath('userData')) while this package stays free of any Electron
// dependency (CLAUDE.md §2 portability rule). Unlike PatStore, there is NO
// encryption codec injected: tenant config carries no secret (host + slug), so
// it is stored as plain JSON, NOT through safeStorage -- the ratified
// ask-first decision ("NOT secret -> NOT safeStorage").
export interface TenantConfigStore {
  get(): Promise<TenantConfig | null>;
  set(config: TenantConfig): Promise<void>;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'ENOENT';
}

function isTenantConfig(value: unknown): value is TenantConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.hostKind === 'github.com' || v.hostKind === 'ghe.com') &&
    typeof v.enterpriseSlug === 'string' &&
    (v.gheSubdomain === undefined || typeof v.gheSubdomain === 'string')
  );
}

export function createTenantConfigStore(filePath: string): TenantConfigStore {
  return {
    async get() {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        // Treat a corrupt/hand-edited file as "not configured" rather than
        // crashing or handing the client a malformed pointer it would build
        // broken enterprise paths from.
        return isTenantConfig(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async set(config: TenantConfig) {
      const error = validateTenantConfig(config);
      if (error) {
        throw new Error(error);
      }
      // Normalize: drop gheSubdomain for github.com so a stale subdomain can't
      // linger and confuse a later host switch.
      const normalized: TenantConfig =
        config.hostKind === 'ghe.com'
          ? { hostKind: 'ghe.com', gheSubdomain: config.gheSubdomain?.trim(), enterpriseSlug: config.enterpriseSlug.trim() }
          : { hostKind: 'github.com', enterpriseSlug: config.enterpriseSlug.trim() };
      await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    },
  };
}
