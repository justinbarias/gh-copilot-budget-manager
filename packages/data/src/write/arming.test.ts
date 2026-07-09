import { afterEach, describe, expect, it } from 'vitest';
import { isWriteArmed, setWriteArmed } from './arming';
// A SECOND import of the same module path -- the module is a singleton, so this
// binding must observe the exact same flag (proves it's shared across
// ApiClient rebuilds within one process).
import * as armingAgain from './arming.js';

afterEach(() => {
  // Reset the process-memory singleton so tests never leak state into each
  // other (mirrors the real relaunch-disarms guarantee).
  setWriteArmed(false);
});

describe('write arming singleton', () => {
  it('defaults to disarmed', () => {
    expect(isWriteArmed()).toBe(false);
  });

  it('arms and disarms via setWriteArmed', () => {
    setWriteArmed(true);
    expect(isWriteArmed()).toBe(true);
    setWriteArmed(false);
    expect(isWriteArmed()).toBe(false);
  });

  it('is a singleton: a second import sees the same value', () => {
    setWriteArmed(true);
    expect(armingAgain.isWriteArmed()).toBe(true);
    armingAgain.setWriteArmed(false);
    expect(isWriteArmed()).toBe(false);
  });
});
