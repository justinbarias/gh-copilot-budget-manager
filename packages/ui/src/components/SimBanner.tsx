import './SimBanner.css';

// Unmistakable, by design: CLAUDE.md §6.8 requires simulation to never look
// live. Task 9.3-lite made this CONDITIONAL (App.tsx): it renders ONLY when the
// resolved mode is 'simulation'. In live mode App.tsx renders <LiveBanner />
// instead, so this simulation banner (and the word "SIMULATION") can never
// appear in live mode -- and the live/armed banner can never appear in
// simulation. Exactly one banner is on screen at all times.
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
