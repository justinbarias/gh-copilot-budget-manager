import './ComingSoon.css';

interface ComingSoonProps {
  screenName: string;
}

// One consistent placeholder for all 6 not-yet-built screens (Forecast,
// Controls, Auto-balance, Chargeback, Audit, Help -- PLAN.md Task 2.5 /
// SPEC.md Assumption 5): visibly stubbed, never a blank/broken route, and
// never fabricating visual design the handoff hasn't specified for these
// screens yet (CLAUDE.md §0).
export function ComingSoon({ screenName }: ComingSoonProps) {
  return (
    <section className="coming-soon" aria-label={screenName}>
      <div className="coming-soon__card">
        <span className="coming-soon__glyph" aria-hidden="true">
          ⧗
        </span>
        <h2 className="coming-soon__title">{screenName}</h2>
        <p className="coming-soon__body">Coming soon — this screen isn't built yet.</p>
      </div>
    </section>
  );
}
