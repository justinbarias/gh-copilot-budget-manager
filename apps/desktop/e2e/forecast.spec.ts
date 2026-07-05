import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, _electron as electron } from '@playwright/test';

// Task 5.4: forecast persistence + compute-on-sync + the getForecast bridge
// method, driven through the app's own IPC surface (preload -> main ->
// MSW -> SQLite -> back) -- the CLAUDE.md §6.7 gate's automated half. Deep
// assembler/window-picking/wiring correctness is already covered exhaustively
// by packages/data's vitest suite (forecast/compute.test.ts +
// github-impl.test.ts's DEWR-world integration tests, which pin the exact
// enterprise exhaustion date/runway) -- this confirms the SAME behaviour
// survives the real Electron boundary, not a re-derivation of it.
test('getForecast is null pre-sync, then resolves a real forecast for enterprise/cost-center/user scopes after Sync Now', async () => {
  const appDir = path.join(__dirname, '..');
  const dbDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-e2e-forecast-'));
  const app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    // Isolated per-run DB path (CLAUDE.md §7) -- a fresh, never-synced DB.
    env: { ...process.env, COPILOT_BUDGET_DB_PATH: path.join(dbDir, 'test.sqlite') },
  });

  try {
    const window = await app.firstWindow();

    interface StoredForecastLike {
      scope: string;
      entityId: string | null;
      computedAt: string;
      mape: number | null;
      result: {
        exhaustionDate: string | null;
        exhaustionDateP90: string | null;
        runwayDays: number | null;
        dailySeries: unknown[];
      };
    }
    interface WindowWithApi {
      api: {
        getForecast(scope: string, entityId?: string): Promise<StoredForecastLike | null>;
        syncNow(): Promise<{ lastSyncedAt: string | null }>;
      };
    }

    // Pre-sync: nothing has ever been computed for any scope.
    const preSyncEnterprise = await window.evaluate(() => (window as unknown as WindowWithApi).api.getForecast('enterprise'));
    expect(preSyncEnterprise).toBeNull();
    const preSyncCc = await window.evaluate(() =>
      (window as unknown as WindowWithApi).api.getForecast('cost_center', 'cc-payments-integrity'),
    );
    expect(preSyncCc).toBeNull();

    const status = await window.evaluate(() => (window as unknown as WindowWithApi).api.syncNow());
    expect(status.lastSyncedAt).not.toBeNull();

    // Enterprise scope: a real, present, plausible forecast.
    const enterprise = await window.evaluate(() => (window as unknown as WindowWithApi).api.getForecast('enterprise'));
    expect(enterprise).not.toBeNull();
    expect(enterprise!.entityId).toBeNull();
    expect(enterprise!.computedAt).toBe('2026-06-14');
    expect(enterprise!.result.exhaustionDate).toBe('2026-06-29');
    expect(enterprise!.result.runwayDays).toBe(15);
    expect(enterprise!.result.dailySeries.length).toBeGreaterThan(0);

    // Cost-center scope: the cap-bound Payments Integrity CC.
    const cc = await window.evaluate(() =>
      (window as unknown as WindowWithApi).api.getForecast('cost_center', 'cc-payments-integrity'),
    );
    expect(cc).not.toBeNull();
    expect(cc!.entityId).toBe('cc-payments-integrity');

    // User scope: emily-zhao (github user id 5182), one of the personas with
    // 3 prior closed cycles of history -- so this scope's mape should be
    // computed (non-null), unlike most of the 81-user roster.
    const user = await window.evaluate(() => (window as unknown as WindowWithApi).api.getForecast('user', '5182'));
    expect(user).not.toBeNull();
    expect(user!.entityId).toBe('5182');
    expect(user!.mape).not.toBeNull();

    // Unknown entity: never computed, resolves null, not an error.
    const unknown = await window.evaluate(() =>
      (window as unknown as WindowWithApi).api.getForecast('cost_center', 'cc-does-not-exist'),
    );
    expect(unknown).toBeNull();
  } finally {
    await app.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
});
