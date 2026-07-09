import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/api-client-context';
import type { PatValidation, ReadSmokeResult, SyncStatus, TenantConfig, WriteArmingState } from '@copilot-budget/data';
import './TokenHealth.css';

// Task 9.3-lite: App lifts the arming state (one source of truth shared with
// the app-level banner) and hands this screen a refresh callback -- the arming
// card calls it after every arm/disarm so the banner updates promptly.
interface TokenHealthProps {
  armingState: WriteArmingState | null;
  onArmingRefresh: () => void;
}

function formatSyncStatus(status: SyncStatus | null): string {
  if (!status) return 'Loading…';
  if (status.inProgress) return 'Syncing…';
  if (!status.lastSyncedAt) return 'Never synced';
  // Trailing-gap surface (SyncStatus.perUserDataThroughDay): live, a Sync run
  // before GitHub generates today's per-user report legitimately covers only
  // through an earlier day — say so instead of implying full coverage. Absent
  // (undefined) before the first sync of this process; omitted then.
  const coverage = status.perUserDataThroughDay ? ` — per-user data through ${status.perUserDataThroughDay}` : '';
  return `Last synced: ${new Date(status.lastSyncedAt).toLocaleString()}${coverage}`;
}

type HostKind = TenantConfig['hostKind'];

function readSmokeToText(result: ReadSmokeResult): string {
  if (result.refused) {
    return `Live read smoke refused: ${result.reason}`;
  }
  const header = `Live read smoke — ${result.ranAt}`;
  const rows = result.results.map((r) => `[${r.docRef}] ${r.status.toUpperCase().padEnd(14)} ${r.endpoint}\n    ${r.details}`);
  return [header, ...rows].join('\n');
}

export function TokenHealth({ armingState, onArmingRefresh }: TokenHealthProps) {
  const api = useApiClient();

  const [mode, setMode] = useState<'simulation' | 'live' | null>(null);
  const [hasPat, setHasPat] = useState<boolean | null>(null);
  const [patInput, setPatInput] = useState('');
  const [patBusy, setPatBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Task 9.3-lite: the PERSISTED mode selection (app_settings 'app_mode') --
  // distinct from `mode`, which is the RESOLVED mode of the running process.
  // Changing the selection does not re-resolve the process (restart required).
  const [modeSelection, setModeSelection] = useState<'simulation' | 'live' | null>(null);
  const [modeSaving, setModeSaving] = useState(false);

  // Task 9.3-lite: live-write arming card local state.
  const [armInput, setArmInput] = useState('');
  const [armBusy, setArmBusy] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);

  // Task 9.1 tenant config
  const [hostKind, setHostKind] = useState<HostKind>('github.com');
  const [gheSubdomain, setGheSubdomain] = useState('');
  const [enterpriseSlug, setEnterpriseSlug] = useState('');
  const [tenantBusy, setTenantBusy] = useState(false);
  const [tenantMessage, setTenantMessage] = useState<string | null>(null);

  // Task 9.1 PAT validation
  const [validation, setValidation] = useState<PatValidation | null>(null);
  const [validating, setValidating] = useState(false);

  // Task 9.2-prep live read smoke
  const [smoke, setSmoke] = useState<ReadSmokeResult | null>(null);
  const [smokeRunning, setSmokeRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getMode(), api.hasPat(), api.getSyncStatus(), api.getTenantConfig(), api.getAppModeSetting()]).then(
      ([m, pat, status, tenant, selection]) => {
        if (cancelled) return;
        setMode(m);
        setHasPat(pat);
        setSyncStatus(status);
        setModeSelection(selection);
        if (tenant) {
          setHostKind(tenant.hostKind);
          setGheSubdomain(tenant.gheSubdomain ?? '');
          setEnterpriseSlug(tenant.enterpriseSlug);
        }
      },
    );
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
      setValidation(null);
    } finally {
      setPatBusy(false);
    }
  }

  async function handleSelectMode(next: 'simulation' | 'live') {
    if (next === modeSelection || modeSaving) return;
    setModeSaving(true);
    try {
      await api.setAppModeSetting(next);
      setModeSelection(next);
    } finally {
      setModeSaving(false);
    }
  }

  async function handleArm() {
    setArmBusy(true);
    setArmError(null);
    try {
      await api.setWriteArming({ action: 'arm', confirmation: armInput });
      setArmInput('');
      onArmingRefresh();
    } catch (err) {
      // Mismatch (or any main-side rejection): surface inline and leave the
      // card looking DISARMED -- never let a failed arm read as armed.
      setArmError(err instanceof Error ? err.message : 'Confirmation does not match the enterprise slug.');
    } finally {
      setArmBusy(false);
    }
  }

  async function handleDisarm() {
    setArmBusy(true);
    setArmError(null);
    try {
      await api.setWriteArming({ action: 'disarm' });
      setArmInput('');
      onArmingRefresh();
    } finally {
      setArmBusy(false);
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

  async function handleSaveTenant() {
    setTenantBusy(true);
    setTenantMessage(null);
    try {
      const config: TenantConfig =
        hostKind === 'ghe.com'
          ? { hostKind, gheSubdomain: gheSubdomain.trim(), enterpriseSlug: enterpriseSlug.trim() }
          : { hostKind, enterpriseSlug: enterpriseSlug.trim() };
      await api.setTenantConfig(config);
      setTenantMessage('Tenant configuration saved.');
    } catch (err) {
      setTenantMessage(err instanceof Error ? err.message : 'Failed to save tenant configuration.');
    } finally {
      setTenantBusy(false);
    }
  }

  async function handleValidate() {
    setValidating(true);
    try {
      setValidation(await api.validatePat());
    } finally {
      setValidating(false);
    }
  }

  async function handleRunSmoke() {
    setSmokeRunning(true);
    setCopied(false);
    try {
      setSmoke(await api.runLiveReadSmoke());
    } finally {
      setSmokeRunning(false);
    }
  }

  async function handleCopySmoke() {
    if (!smoke) return;
    await navigator.clipboard.writeText(readSmokeToText(smoke));
    setCopied(true);
  }

  const isSimulation = mode === 'simulation';

  return (
    <section className="token-health">
      <div className="token-health__card" data-testid="mode-card">
        <h2 className="token-health__title">Mode</h2>
        <p className="token-health__hint">
          Choose whether this app runs against the simulation (offline demo/train) or live GitHub. The selection is
          persisted; the running app keeps its current mode until you restart.
        </p>

        <div className="token-health__row">
          <span className="token-health__label">Resolved mode (now)</span>
          <span className="mono" data-testid="mode-resolved">
            {mode ?? 'Loading…'}
          </span>
        </div>

        <div className="token-health__row">
          <span className="token-health__label">Selection (on next start)</span>
          <div className="token-health__segmented" role="group" aria-label="Mode selection">
            <button
              type="button"
              className={`token-health__segment${modeSelection === 'simulation' ? ' token-health__segment--active' : ''}`}
              aria-pressed={modeSelection === 'simulation'}
              onClick={() => handleSelectMode('simulation')}
              disabled={modeSaving || modeSelection === null}
              data-testid="mode-select-simulation"
            >
              Simulation
            </button>
            <button
              type="button"
              className={`token-health__segment${modeSelection === 'live' ? ' token-health__segment--active' : ''}`}
              aria-pressed={modeSelection === 'live'}
              onClick={() => handleSelectMode('live')}
              disabled={modeSaving || modeSelection === null}
              data-testid="mode-select-live"
            >
              Live
            </button>
          </div>
        </div>

        <p className="token-health__hint token-health__hint--warn" data-testid="mode-restart-note">
          Restart the app to apply a mode change.
        </p>

        {modeSelection === 'live' && hasPat === false && (
          <p className="token-health__hint" data-testid="mode-live-no-pat-note">
            Live is selected, but no PAT is stored — the app will still resolve to simulation until you save a token
            below and restart.
          </p>
        )}
      </div>

      <div className="token-health__card" data-testid="arming-card">
        <h2 className="token-health__title">Live-write arming</h2>
        {armingState === null ? (
          <p className="token-health__hint">Loading…</p>
        ) : armingState.mode === 'simulation' ? (
          <p className="token-health__hint" data-testid="arming-sim-note">
            Live-write arming applies only in live mode; simulation writes are always simulated.
          </p>
        ) : (
          <>
            <p className="token-health__hint">
              Live writes are gated: budget/cap mutations are refused on apply until you arm them. Arming lives in memory
              only — restarting the app disarms it.
            </p>
            <div className="token-health__row">
              <span className="token-health__label">Status</span>
              <span className="mono" data-testid="arming-status">
                {armingState.armed ? 'ARMED — live writes enabled' : 'Disarmed — live writes refused'}
              </span>
            </div>

            {armingState.armed ? (
              <div className="token-health__pat-actions">
                <button type="button" onClick={handleDisarm} disabled={armBusy} data-testid="arming-disarm">
                  {armBusy ? 'Disarming…' : 'Disarm live writes'}
                </button>
              </div>
            ) : (
              <div className="token-health__pat-form">
                <label className="token-health__pat-label" htmlFor="arm-input">
                  Type the enterprise slug to confirm: <span className="mono">{armingState.enterpriseSlug}</span>
                </label>
                <input
                  id="arm-input"
                  type="text"
                  value={armInput}
                  onChange={(event) => {
                    setArmInput(event.target.value);
                    setArmError(null);
                  }}
                  placeholder={armingState.enterpriseSlug ?? ''}
                  disabled={armBusy}
                  data-testid="arming-input"
                />
                <div className="token-health__pat-actions">
                  <button type="button" onClick={handleArm} disabled={armBusy || !armInput} data-testid="arming-arm">
                    {armBusy ? 'Arming…' : 'Arm live writes'}
                  </button>
                </div>
                {armError && (
                  <p className="token-health__hint token-health__hint--warn" data-testid="arming-error">
                    {armError}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

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
            <button type="button" onClick={handleValidate} disabled={validating || !hasPat}>
              {validating ? 'Validating…' : 'Validate token'}
            </button>
          </div>
          {validation && (
            <div
              className={`token-health__validation token-health__validation--${validation.ok ? 'ok' : 'warn'}`}
              data-testid="pat-validation"
            >
              <div className="token-health__row">
                <span className="token-health__label">Token kind</span>
                <span className="mono">{validation.tokenKind}</span>
              </div>
              <div className="token-health__row">
                <span className="token-health__label">manage_billing:enterprise</span>
                <span className="mono">{validation.hasManageBillingEnterprise ? 'present' : 'absent'}</span>
              </div>
              <div className="token-health__row">
                <span className="token-health__label">Scopes</span>
                <span className="mono">{validation.scopes.length > 0 ? validation.scopes.join(', ') : '—'}</span>
              </div>
              <p className="token-health__validation-message">{validation.message}</p>
            </div>
          )}
        </div>
      </div>

      <div className="token-health__card">
        <h2 className="token-health__title">Tenant configuration</h2>
        <p className="token-health__hint">
          Where this app points in live mode. Not a secret — stored as plain JSON, never in the token store.
        </p>

        <div className="token-health__pat-form">
          <label className="token-health__pat-label" htmlFor="host-kind">
            Host
          </label>
          <select
            id="host-kind"
            className="token-health__select"
            value={hostKind}
            onChange={(event) => setHostKind(event.target.value as HostKind)}
            disabled={tenantBusy}
          >
            <option value="github.com">github.com (api.github.com)</option>
            <option value="ghe.com">GHE.com (api.SUBDOMAIN.ghe.com)</option>
          </select>

          {hostKind === 'ghe.com' && (
            <>
              <label className="token-health__pat-label" htmlFor="ghe-subdomain">
                GHE.com subdomain
              </label>
              <input
                id="ghe-subdomain"
                type="text"
                value={gheSubdomain}
                onChange={(event) => setGheSubdomain(event.target.value)}
                placeholder="acme"
                disabled={tenantBusy}
              />
            </>
          )}

          <label className="token-health__pat-label" htmlFor="enterprise-slug">
            Enterprise slug
          </label>
          <input
            id="enterprise-slug"
            type="text"
            value={enterpriseSlug}
            onChange={(event) => setEnterpriseSlug(event.target.value)}
            placeholder="my-enterprise"
            disabled={tenantBusy}
          />

          <div className="token-health__pat-actions">
            <button type="button" onClick={handleSaveTenant} disabled={tenantBusy || !enterpriseSlug.trim()}>
              {tenantBusy ? 'Saving…' : 'Save tenant'}
            </button>
          </div>
          {tenantMessage && (
            <p className="token-health__hint" data-testid="tenant-message">
              {tenantMessage}
            </p>
          )}
        </div>
      </div>

      <div className="token-health__card">
        <h2 className="token-health__title">Live read smoke</h2>
        <p className="token-health__hint">
          Reads every enterprise billing/budget endpoint once and reconciles each response shape against what the app
          parses.
        </p>
        {isSimulation && (
          <p className="token-health__hint token-health__hint--warn" data-testid="smoke-sim-note">
            Unavailable while simulating — it never contacts GitHub. Enter a PAT and point at a live enterprise first.
          </p>
        )}
        <div className="token-health__pat-actions">
          <button type="button" onClick={handleRunSmoke} disabled={smokeRunning || isSimulation}>
            {smokeRunning ? 'Running…' : 'Run live read smoke'}
          </button>
          {smoke && !smoke.refused && (
            <button type="button" onClick={handleCopySmoke}>
              {copied ? 'Copied' : 'Copy report'}
            </button>
          )}
        </div>

        {smoke && smoke.refused && (
          <p className="token-health__hint token-health__hint--warn" data-testid="smoke-refused">
            Refused: {smoke.reason}
          </p>
        )}

        {smoke && !smoke.refused && (
          <table className="token-health__smoke-table" data-testid="smoke-results">
            <thead>
              <tr>
                <th>Row</th>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {smoke.results.map((r) => (
                <tr key={r.docRef} className={`token-health__smoke-row token-health__smoke-row--${r.status}`}>
                  <td className="mono">{r.docRef}</td>
                  <td className="mono">{r.endpoint}</td>
                  <td className="mono">{r.status}</td>
                  <td>{r.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
