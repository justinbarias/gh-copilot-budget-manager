// Task 9.3-lite: live-write arming. Main-process memory ONLY -- deliberately
// never persisted, so relaunch disarms. Module-level singleton so it is shared
// across ApiClient rebuilds within one process (a credential/tenant change
// disarms it explicitly via ipc.ts's rebuildClient, see that file).
let armed = false;
export function isWriteArmed(): boolean {
  return armed;
}
export function setWriteArmed(value: boolean): void {
  armed = value;
}
