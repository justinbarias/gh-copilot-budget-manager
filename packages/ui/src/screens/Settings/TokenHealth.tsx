import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/api-client-context';
import type { SyncStatus } from '@copilot-budget/data';
import './TokenHealth.css';

function formatSyncStatus(status: SyncStatus | null): string {
  if (!status) return 'Loading…';
  if (status.inProgress) return 'Syncing…';
  if (!status.lastSyncedAt) return 'Never synced';
  return `Last synced: ${new Date(status.lastSyncedAt).toLocaleString()}`;
}

export function TokenHealth() {
  const api = useApiClient();

  const [mode, setMode] = useState<'simulation' | 'live' | null>(null);
  const [hasPat, setHasPat] = useState<boolean | null>(null);
  const [patInput, setPatInput] = useState('');
  const [patBusy, setPatBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getMode(), api.hasPat(), api.getSyncStatus()]).then(([m, pat, status]) => {
      if (cancelled) return;
      setMode(m);
      setHasPat(pat);
      setSyncStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function handleSave() {
    if (!patInput) return;
    setPatBusy(true);
    try {
      await api.setPat(patInput);
      setPatInput('');
      setHasPat(await api.hasPat());
    } finally {
      setPatBusy(false);
    }
  }

  async function handleClear() {
    setPatBusy(true);
    try {
      await api.clearPat();
      setHasPat(await api.hasPat());
    } finally {
      setPatBusy(false);
    }
  }

  async function handleSyncNow() {
    setSyncing(true);
    try {
      const result = await api.syncNow();
      setSyncStatus(result);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="token-health">
      <div className="token-health__card">
        <h2 className="token-health__title">Token &amp; permission health</h2>

        <div className="token-health__row">
          <span className="token-health__label">Mode</span>
          <span className="mono">{mode ?? 'Loading…'}</span>
        </div>

        <div className="token-health__row">
          <span className="token-health__label">Personal access token</span>
          <span className="mono">
            {hasPat === null ? 'Loading…' : hasPat ? 'PAT stored' : 'No PAT stored yet'}
          </span>
        </div>

        <div className="token-health__pat-form">
          <label className="token-health__pat-label" htmlFor="pat-input">
            GitHub personal access token
          </label>
          <input
            id="pat-input"
            type="password"
            value={patInput}
            onChange={(event) => setPatInput(event.target.value)}
            placeholder="ghp_…"
            disabled={patBusy}
          />
          <div className="token-health__pat-actions">
            <button type="button" onClick={handleSave} disabled={patBusy || !patInput}>
              Save token
            </button>
            <button type="button" onClick={handleClear} disabled={patBusy || !hasPat}>
              Clear token
            </button>
          </div>
        </div>
      </div>

      <div className="token-health__card">
        <h2 className="token-health__title">Sync</h2>
        <div className="token-health__row">
          <span className="token-health__label">Status</span>
          <span className="mono">{formatSyncStatus(syncStatus)}</span>
        </div>
        <button type="button" onClick={handleSyncNow} disabled={syncing || syncStatus?.inProgress}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    </section>
  );
}
