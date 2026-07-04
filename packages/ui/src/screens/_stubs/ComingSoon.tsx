import './ComingSoon.css';

interface ComingSoonProps {
  screenName: string;
  /**
   * Optional flavor line. Defaults to the whole-screen stub copy; the
   * Controls screen reuses this same treatment for its not-yet-built family
   * tabs (Task 4.9) with an "arrives with Task 4.10/4.12" message, so a
   * placeholder tab reads visibly consistent with placeholder screens.
   */
  message?: string;
}

// One consistent placeholder for all not-yet-built screens (Forecast,
// Auto-balance, Chargeback, Audit, Help -- PLAN.md Task 2.5 / SPEC.md
// Assumption 5) and for not-yet-built within-screen tabs: visibly stubbed,
// never a blank/broken route, and never fabricating visual design the
// handoff hasn't specified for these surfaces yet (CLAUDE.md §0).
export function ComingSoon({ screenName, message }: ComingSoonProps) {
  return (
    <section className="coming-soon" aria-label={screenName}>
      <div className="coming-soon__card">
        <span className="coming-soon__glyph" aria-hidden="true">
          ⧗
        </span>
        <h2 className="coming-soon__title">{screenName}</h2>
        <p className="coming-soon__body">{message ?? "Coming soon — this screen isn't built yet."}</p>
      </div>
    </section>
  );
}
