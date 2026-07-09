export * from './types.js';
export * from './github-impl.js';
// Task 9.3-lite: the live-write arming singleton (write/arming.ts) is exposed
// here so apps/desktop's ipc.ts can force-disarm on a credential/tenant
// rebuild (defense in depth). Process-memory only; never persisted.
export { isWriteArmed, setWriteArmed } from '../write/arming.js';
