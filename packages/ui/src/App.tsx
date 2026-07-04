import { ApiClientProvider } from './lib/api-client-context';
import { SimBanner } from './components/SimBanner';
import { CostCentersTable } from './screens/CostCenters/CostCentersTable';
import { Overview } from './screens/Overview/Overview';
import { TokenHealth } from './screens/Settings/TokenHealth';

// Minimal wiring, no nav shell yet -- Task 2.5 owns routing between screens.
// Screens render stacked in sequence so each task's own e2e spec
// (settings.spec.ts, overview.spec.ts, cost-centers.spec.ts) keeps driving
// the same page it always has.
export function App() {
  return (
    <ApiClientProvider>
      <SimBanner />
      <Overview />
      <CostCentersTable />
      <TokenHealth />
    </ApiClientProvider>
  );
}
