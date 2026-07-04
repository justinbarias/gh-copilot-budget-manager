import type { ApiClient } from '@copilot-budget/data';

export interface WindowApi extends ApiClient {
  setPat(pat: string): Promise<void>;
  clearPat(): Promise<void>;
  hasPat(): Promise<boolean>;
  getMode(): Promise<'simulation' | 'live'>;
}

declare global {
  interface Window {
    api: WindowApi;
  }
}
