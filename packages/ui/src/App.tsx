import { ApiClientProvider } from './lib/api-client-context';
import { SimBanner } from './components/SimBanner';
import { Overview } from './screens/Overview/Overview';
import { TokenHealth } from './screens/Settings/TokenHealth';

// Minimal wiring, no nav shell yet -- Task 2.5 owns routing between screens.
// Both screens render in sequence so each task's own e2e spec (settings.spec.ts,
// overview.spec.ts) keeps driving the same page it always has.
export function App() {
  return (
    <ApiClientProvider>
      <SimBanner />
      <Overview />
      <TokenHealth />
    </ApiClientProvider>
  );
}
