import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPatStore, type EncryptionCodec } from './storage';

// A deliberately non-identity fake codec: real assertions about "never plaintext
// on disk" would be meaningless against a passthrough fake, so this reverses and
// tags the string, proving the store persists codec output, not the raw input.
function fakeCodec(available = true): EncryptionCodec {
  return {
    isEncryptionAvailable: () => available,
    encrypt: (plainText: string) => Buffer.from(`enc:${[...plainText].reverse().join('')}`, 'utf8'),
    decrypt: (encrypted: Buffer) => {
      const tagged = encrypted.toString('utf8');
      if (!tagged.startsWith('enc:')) throw new Error('corrupt blob');
      return [...tagged.slice(4)].reverse().join('');
    },
  };
}

describe('createPatStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pat-store-test-'));
    filePath = join(dir, 'pat.enc');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when nothing has ever been stored', async () => {
    const store = createPatStore(filePath, fakeCodec());
    await expect(store.get()).resolves.toBeNull();
  });

  it('round-trips a PAT through set/get', async () => {
    const store = createPatStore(filePath, fakeCodec());
    await store.set('ghp_sentinelToken123');
    await expect(store.get()).resolves.toBe('ghp_sentinelToken123');
  });

  it('never writes the plaintext PAT to disk', async () => {
    const store = createPatStore(filePath, fakeCodec());
    await store.set('ghp_sentinelToken123');
    const onDisk = readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain('ghp_sentinelToken123');
  });

  it('clear() removes the stored PAT', async () => {
    const store = createPatStore(filePath, fakeCodec());
    await store.set('ghp_sentinelToken123');
    await store.clear();
    await expect(store.get()).resolves.toBeNull();
  });

  it('clear() on an already-empty store does not throw', async () => {
    const store = createPatStore(filePath, fakeCodec());
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('set() throws when the codec reports encryption unavailable', async () => {
    const store = createPatStore(filePath, fakeCodec(false));
    await expect(store.set('ghp_sentinelToken123')).rejects.toThrow(/encryption/i);
  });

  it('treats a corrupt/undecryptable blob as no usable PAT rather than throwing', async () => {
    const store = createPatStore(filePath, fakeCodec());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, 'not-a-valid-blob');
    await expect(store.get()).resolves.toBeNull();
  });
});
