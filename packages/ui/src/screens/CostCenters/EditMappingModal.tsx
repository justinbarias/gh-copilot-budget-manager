import { useEffect, useState } from 'react';
import type { CostCenterSummary } from '@copilot-budget/data';
import { useApiClient } from '../../lib/api-client-context';
import './CostCenterLifecycleModal.css';

// Edit an existing cost center's DEWR mapping (maintainer decision, 2026-07-09
// Cost Centers live-correctness round): the mapping is an APP-LOCAL construct
// -- live cost centers created outside this app carry none, so this modal is
// how they get one. Saving writes ONLY the local DB columns via
// api.updateCostCenterMapping (never a GitHub request -- no dry-run/apply
// pipeline involved, unlike every other modal on this screen, because there is
// no wire mutation to preview). Reuses the New-cost-center modal's DEWR form
// section idiom (same classes/labels) rather than inventing a second look.
export function EditMappingModal({
  costCenter,
  onClose,
  onSaved,
}: {
  costCenter: CostCenterSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApiClient();
  const [dewrDivision, setDewrDivision] = useState(costCenter.dewrDivision ?? '');
  const [dewrBranch, setDewrBranch] = useState(costCenter.dewrBranch ?? '');
  const [dewrProject, setDewrProject] = useState(costCenter.dewrProject ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    try {
      // Empty fields clear the column (null) -- "no value" stays honest
      // rather than persisting an empty string.
      await api.updateCostCenterMapping(costCenter.id, {
        dewrDivision: dewrDivision.trim() || null,
        dewrBranch: dewrBranch.trim() || null,
        dewrProject: dewrProject.trim() || null,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="new-ulb-modal__backdrop" onClick={onClose}>
      <div
        className="new-ulb-modal cc-lifecycle-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit DEWR mapping — ${costCenter.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="new-ulb-modal__header">
          <div className="new-ulb-modal__title">Edit DEWR mapping — {costCenter.name}</div>
          <button type="button" className="new-ulb-modal__close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="new-ulb-modal__body">
          <p className="cc-lifecycle-modal__hint">
            App-local metadata only — saving never contacts GitHub.
          </p>
          <div className="cc-lifecycle-modal__dewr-grid">
            <div>
              <label className="new-ulb-modal__label" htmlFor="edit-cc-division">
                DEWR division
              </label>
              <input
                id="edit-cc-division"
                className="new-ulb-modal__input"
                aria-label="DEWR division"
                value={dewrDivision}
                onChange={(event) => setDewrDivision(event.target.value)}
              />
            </div>
            <div>
              <label className="new-ulb-modal__label" htmlFor="edit-cc-branch">
                DEWR branch
              </label>
              <input
                id="edit-cc-branch"
                className="new-ulb-modal__input"
                aria-label="DEWR branch"
                value={dewrBranch}
                onChange={(event) => setDewrBranch(event.target.value)}
              />
            </div>
            <div>
              <label className="new-ulb-modal__label" htmlFor="edit-cc-project">
                DEWR project
              </label>
              <input
                id="edit-cc-project"
                className="new-ulb-modal__input"
                aria-label="DEWR project"
                value={dewrProject}
                onChange={(event) => setDewrProject(event.target.value)}
              />
            </div>
          </div>

          <div className="cc-lifecycle-modal__actions">
            <button type="button" className="new-ulb-modal__cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="new-ulb-modal__create" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save mapping'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
