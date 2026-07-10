import { useState } from 'react';
import { UsersTable } from './UsersTable';
import { Distribution } from './Distribution';
import './UsersScreen.css';

type View = 'table' | 'distribution';

// Distribution D3: a thin wrapper over the existing Users screen. A segmented
// "Table | Distribution" toggle makes the new per-user distribution view
// discoverable without changing anyone's landing page -- Table stays the
// default (the pre-existing behaviour). Table renders the UNCHANGED UsersTable;
// Distribution renders the new SVG histogram view.
export function UsersScreen() {
  const [view, setView] = useState<View>('table');

  return (
    <div className="users-screen">
      <div className="users-screen__toggle-row">
        <div className="users-screen__toggle" role="tablist" aria-label="Users view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'table'}
            className={`users-screen__toggle-btn${view === 'table' ? ' users-screen__toggle-btn--active' : ''}`}
            onClick={() => setView('table')}
          >
            Table
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'distribution'}
            className={`users-screen__toggle-btn${view === 'distribution' ? ' users-screen__toggle-btn--active' : ''}`}
            onClick={() => setView('distribution')}
          >
            Distribution
          </button>
        </div>
      </div>

      {view === 'table' ? <UsersTable /> : <Distribution />}
    </div>
  );
}
