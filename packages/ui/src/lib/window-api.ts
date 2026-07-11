import type { ApiClient, SyncStatus } from '@copilot-budget/data';

export interface WindowApi extends ApiClient {
  setPat(pat: string): Promise<void>;
  clearPat(): Promise<void>;
  hasPat(): Promise<boolean>;
  getMode(): Promise<'simulation' | 'live'>;
  /**
   * Push-events extra (NOT part of the portable ApiClient interface -- a
   * WindowApi-only affordance, like setPat/getMode). Subscribes to main-process
   * sync progress/result broadcasts; returns an unsubscribe. Optional so
   * consumers must feature-detect it: an older preload bridge or a future web
   * host may not provide it (an HTTP host would poll/SSE at this layer instead).
   */
  onSyncStatusChanged?(listener: (status: SyncStatus) => void): () => void;
}

declare global {
  interface Window {
    api: WindowApi;
  }
}
