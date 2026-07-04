import './SimBanner.css';

// Persistent and unmistakable, by design: CLAUDE.md §6.8 requires simulation
// to never look live, and PLAN.md Task 1.7 specifies this stays visible
// "whenever not in a verified live+PAT state -- i.e., always, for MVP" (no
// build in this repo has reached a verified live state yet). Once a real
// verified-live concept exists (later phase), this can become conditional.
export function SimBanner() {
  return (
    <div className="sim-banner" role="status">
      <span className="sim-banner__glyph" aria-hidden="true">
        ◆
      </span>
      <span className="sim-banner__text">
        <strong>SIMULATION MODE</strong> — no live GitHub data. Every action here is simulated;
        nothing is written to a real budget or cap.
      </span>
    </div>
  );
}
