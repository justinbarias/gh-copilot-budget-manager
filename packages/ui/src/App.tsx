import { ApiClientProvider } from './lib/api-client-context';
import { SimBanner } from './components/SimBanner';
import { TokenHealth } from './screens/Settings/TokenHealth';

export function App() {
  return (
    <ApiClientProvider>
      <SimBanner />
      <TokenHealth />
    </ApiClientProvider>
  );
}
