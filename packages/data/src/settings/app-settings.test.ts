import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../db/client.js';
import { APP_MODE_SETTING_KEY, getAppModeSetting, getAppSetting, setAppModeSetting, setAppSetting } from './app-settings.js';

// Task 9.3-lite: the app_settings KV store (migration 0004), first consumer the
// persisted mode selection. Real DB (temp sqlite) + migrations so the
// app_settings table genuinely exists.
let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'copilot-budget-app-settings-test-'));
  db = createDb(path.join(tmpDir, 'test.sqlite'));
  runMigrations(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('app settings KV', () => {
  it('roundtrips a raw key/value (unset key reads null)', () => {
    expect(getAppSetting(db, 'some_key')).toBeNull();
    setAppSetting(db, 'some_key', 'some_value');
    expect(getAppSetting(db, 'some_key')).toBe('some_value');
    // Upsert: a second set overwrites rather than duplicating.
    setAppSetting(db, 'some_key', 'other_value');
    expect(getAppSetting(db, 'some_key')).toBe('other_value');
  });
});

describe('getAppModeSetting / setAppModeSetting', () => {
  it('defaults to simulation when unset', () => {
    expect(getAppModeSetting(db)).toBe('simulation');
  });

  it('defaults to simulation when the stored value is unrecognized', () => {
    setAppSetting(db, APP_MODE_SETTING_KEY, 'garbage');
    expect(getAppModeSetting(db)).toBe('simulation');
  });

  it('roundtrips live', () => {
    setAppModeSetting(db, 'live');
    expect(getAppModeSetting(db)).toBe('live');
  });

  it('roundtrips back to simulation', () => {
    setAppModeSetting(db, 'live');
    setAppModeSetting(db, 'simulation');
    expect(getAppModeSetting(db)).toBe('simulation');
  });
});
