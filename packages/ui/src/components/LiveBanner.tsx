import './LiveBanner.css';

// Task 9.3-lite §6.8: the LIVE-mode counterpart to SimBanner. Rendered ONLY
// when the resolved mode is 'live' -- so the word "SIMULATION" can never appear
// in live mode, and this banner can never appear in simulation (App.tsx picks
// exactly one). Two states, deliberately distinct:
//   armed=true  -> a PROMINENT danger banner: real GitHub mutations WILL be
//                  issued on apply. This is the loudest surface in the app.
//   armed=false -> a neutral live indicator: live reads only, writes disarmed.
// A separate component from SimBanner (not a restyle) so the two can never be
// confused for one another.
export function LiveBanner({ armed }: { armed: boolean }) {
  if (armed) {
    return (
      <div className="live-banner live-banner--armed" role="alert">
        <span className="live-banner__glyph" aria-hidden="true">
          ⬤
        </span>
        <span className="live-banner__text">
          <strong>LIVE — writes ARMED.</strong> Real GitHub budget/cap mutations will be issued on apply.
        </span>
      </div>
    );
  }
  return (
    <div className="live-banner live-banner--readonly" role="status">
      <span className="live-banner__glyph" aria-hidden="true">
        ○
      </span>
      <span className="live-banner__text">
        <strong>LIVE — read-only</strong> (writes disarmed). Arm in Settings to enable apply.
      </span>
    </div>
  );
}
