import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import type { SyncStatus } from '@copilot-budget/data';
import { useApiClient } from './api-client-context';

// Full "last synced" line -- moved verbatim from Settings/TokenHealth.tsx when
// Sync Now relocated to the global nav-footer affordance. The nav footer shows
// a compact form and carries THIS full text in the row's title attribute.
//
// Trailing-gap surface (SyncStatus.perUserDataThroughDay): live, a Sync run
// before GitHub generates today's per-user report legitimately covers only
// through an earlier day -- say so instead of implying full coverage. Absent
// (undefined) before the first sync of this process; omitted then.
export function formatSyncStatus(status: SyncStatus | null): string {
  if (!status) return 'Loading…';
  if (status.inProgress) return 'Syncing…';
  if (!status.lastSyncedAt) return 'Never synced';
  const coverage = status.perUserDataThroughDay ? ` — per-user data through ${status.perUserDataThroughDay}` : '';
  return `Last synced: ${new Date(status.lastSyncedAt).toLocaleString()}${coverage}`;
}

// Emitted once per sync COMPLETION (success or failure), so the app-shell toast
// can key off `seq` and show the right generic message. `seq` is monotonic;
// `ok` distinguishes the two toasts. Kept separate from `syncedVersion` because
// a FAILURE must fire a toast without bumping the remount version.
interface SyncCompletion {
  seq: number;
  ok: boolean;
}

interface SyncContextValue {
  /** Latest observed sync status (null until the first fetch resolves). */
  status: SyncStatus | null;
  /** THIS window has a Sync Now in flight (guards + disables the button). */
  syncing: boolean;
  /** THIS window's last Sync Now error message, or null. §6.6: never secret. */
  error: string | null;
  /** Trigger a Sync Now. Idempotent while one is already in flight. */
  syncNow: () => Promise<void>;
  /**
   * Monotonic (start 0), incremented ONLY on a successful sync completion.
   * Composed into App's content remount key so a successful sync remounts the
   * currently-viewed screen and it re-fetches. A FAILURE never bumps this (data
   * did not change -> no remount).
   */
  syncedVersion: number;
  /** The most recent completion (success or failure) for the app-shell toast. */
  lastCompletion: SyncCompletion | null;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new Error('useSync must be used within a SyncProvider');
  }
  return ctx;
}

// §6.6: this message only ever rides in the footer detail's title attribute
// (a plain Error message, never token/login material). The toast text is
// generic ("Sync failed") regardless.
function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Sync failed';
}

interface SyncProviderProps {
  /**
   * A scenario switch re-seeds MSW, so the provider re-reads status against the
   * new fixture world -- threaded in as an effect dep rather than remounting
   * the provider (it must survive nav AND scenario switches to keep its
   * subscription + in-flight state alive; see App.tsx).
   */
  scenarioVersion: number;
}

export function SyncProvider({ scenarioVersion, children }: PropsWithChildren<SyncProviderProps>) {
  const api = useApiClient();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedVersion, setSyncedVersion] = useState(0);
  const [lastCompletion, setLastCompletion] = useState<SyncCompletion | null>(null);

  // The most recent status observed -- the "previous known value" the
  // completion-discrimination rule compares against. A ref (not state) so the
  // broadcast callback reads the latest value synchronously without needing to
  // re-subscribe on every status change.
  const prevStatusRef = useRef<SyncStatus | null>(null);
  const completionSeqRef = useRef(0);
  const syncingRef = useRef(false);

  // Completion-discrimination rule (maintainer decision). A status transition
  // to inProgress:false is a completion; classify it by whether lastSyncedAt
  // advanced versus the previous known value:
  //   - CHANGED (incl. the first-ever null -> a date) => SUCCESS: data
  //     advanced. Bump syncedVersion (App's remount key) AND emit an ok
  //     completion (success toast).
  //   - UNCHANGED => FAILURE: the failure broadcast is {...lastKnown,
  //     inProgress:false}, so lastSyncedAt is untouched. Data did NOT change,
  //     so DO NOT bump syncedVersion (no remount) -- emit a not-ok completion
  //     (failure toast) only.
  // Every status (initial fetch, scenario re-read, broadcast) funnels through
  // here; non-completions (prev not in-flight) only update state, never toast.
  const ingestStatus = useCallback((next: SyncStatus) => {
    const prev = prevStatusRef.current;
    if (prev?.inProgress === true && next.inProgress === false) {
      const changed = next.lastSyncedAt !== prev.lastSyncedAt;
      if (changed) setSyncedVersion((v) => v + 1);
      completionSeqRef.current += 1;
      setLastCompletion({ seq: completionSeqRef.current, ok: changed });
    }
    prevStatusRef.current = next;
    setStatus(next);
  }, []);

  // Initial status read, re-run on a scenario switch (new fixture world).
  useEffect(() => {
    let cancelled = false;
    api.getSyncStatus().then((s) => {
      if (cancelled) return;
      ingestStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [api, scenarioVersion, ingestStatus]);

  // Subscribe to main-process sync progress/result broadcasts. Feature-detected
  // (onSyncStatusChanged is optional on WindowApi): a future web host or an
  // older preload bridge may not provide it -- syncNow's no-channel path below
  // then drives the transition locally instead.
  useEffect(() => {
    const subscribe = api.onSyncStatusChanged;
    if (typeof subscribe !== 'function') return;
    return subscribe((s) => ingestStatus(s));
  }, [api, ingestStatus]);

  const hasChannel = typeof api.onSyncStatusChanged === 'function';

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return; // one Sync Now per window at a time
    syncingRef.current = true;
    setSyncing(true);
    setError(null);
    try {
      if (hasChannel) {
        // Main broadcasts inProgress:true on start then the final|last-known
        // status on settle, to THIS and every other window -> ingestStatus.
        await api.syncNow();
      } else {
        // No broadcast channel: synthesize the same two-status transition
        // locally so the completion rule still runs (mirrors what the main
        // process would have broadcast).
        const baseline: SyncStatus = prevStatusRef.current ?? { lastSyncedAt: null, inProgress: false };
        ingestStatus({ ...baseline, inProgress: true });
        try {
          ingestStatus(await api.syncNow());
        } catch (err) {
          ingestStatus({ ...baseline, inProgress: false });
          throw err;
        }
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSyncing(false);
      syncingRef.current = false;
    }
  }, [api, hasChannel, ingestStatus]);

  const value = useMemo<SyncContextValue>(
    () => ({ status, syncing, error, syncNow, syncedVersion, lastCompletion }),
    [status, syncing, error, syncNow, syncedVersion, lastCompletion],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
