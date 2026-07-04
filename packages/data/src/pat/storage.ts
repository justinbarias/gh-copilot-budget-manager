import { readFile, rm, writeFile } from 'node:fs/promises';

// The encryption itself is the only Electron-specific part of PAT storage
// (Electron's safeStorage, OS keychain-backed). Everything else — where the
// encrypted blob lives on disk, how it's read/written/cleared — is plain Node
// I/O, so it's injected rather than imported here to keep this package free of
// an Electron dependency (CLAUDE.md §2 portability rule; the real
// implementation lives in apps/desktop/src/main).
export interface EncryptionCodec {
  isEncryptionAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export interface PatStore {
  get(): Promise<string | null>;
  set(pat: string): Promise<void>;
  clear(): Promise<void>;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'ENOENT';
}

export function createPatStore(filePath: string, codec: EncryptionCodec): PatStore {
  return {
    async get() {
      let encrypted: Buffer;
      try {
        encrypted = await readFile(filePath);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      try {
        return codec.decrypt(encrypted);
      } catch {
        // Corrupt blob, or the OS keychain backing the codec changed underneath
        // us — treat as "no usable PAT" rather than crashing or claiming live
        // mode on data we can't actually read.
        return null;
      }
    },

    async set(pat: string) {
      if (!codec.isEncryptionAvailable()) {
        throw new Error('OS-backed encryption is not available on this machine');
      }
      await writeFile(filePath, codec.encrypt(pat));
    },

    async clear() {
      try {
        await rm(filePath);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
}
