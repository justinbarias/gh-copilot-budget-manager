import { createContext, useContext, type PropsWithChildren } from 'react';
import type { WindowApi } from './window-api';

const ApiClientContext = createContext<WindowApi | null>(null);

// The UI reaches native capabilities only through window.api (the preload
// bridge) -- this context is the one place that reads it, so screens/
// components consume an interface rather than the global directly
// (CLAUDE.md §2 portability rule).
export function ApiClientProvider({ children }: PropsWithChildren) {
  return <ApiClientContext.Provider value={window.api}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): WindowApi {
  const client = useContext(ApiClientContext);
  if (!client) {
    throw new Error('useApiClient must be used within an ApiClientProvider');
  }
  return client;
}
