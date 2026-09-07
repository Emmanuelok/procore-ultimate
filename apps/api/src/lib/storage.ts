import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

/**
 * Content-addressed local-disk storage. Objects are stored under
 * <root>/<companyId>/<first2ofsha>/<sha256> so identical payloads dedupe and
 * the address itself attests to content integrity (spec Domain S #862).
 *
 * The interface is deliberately narrow so an S3/GCS/Azure driver can replace
 * it without touching call sites.
 */
export interface SavedObject {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

export interface StorageService {
  saveBuffer(companyId: string, data: Buffer): Promise<SavedObject>;
  saveStream(companyId: string, stream: Readable): Promise<SavedObject>;
  readStream(storageKey: string): Readable;
  filePath(storageKey: string): string;
  remove(storageKey: string): Promise<void>;
  /**
   * Cheapest round trip that proves the backing store is reachable and the
   * credentials work. A missing key answers `false`; anything that stops the
   * question being answered at all — a bad bucket, a wrong secret, a
   * disconnected volume — throws, which is what readiness needs to see.
   * Never use it as a "does this object exist" test in a hot path.
   */
  probe(storageKey: string): Promise<boolean>;
}

export function createLocalStorage(rootDir: string): StorageService {
  const root = path.resolve(rootDir);

  function keyToPath(storageKey: string): string {
    const abs = path.resolve(root, storageKey);
    if (!abs.startsWith(root + path.sep)) {
      throw new Error("Invalid storage key");
    }
    return abs;
  }

  async function persist(companyId: string, data: Buffer): Promise<SavedObject> {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const storageKey = path.join(companyId, sha256.slice(0, 2), sha256);
    const abs = keyToPath(storageKey);
    await mkdir(path.dirname(abs), { recursive: true });
    try {
      await stat(abs); // already stored (content-addressed dedupe)
    } catch {
      await writeFile(abs, data);
    }
    return { storageKey, sha256, sizeBytes: data.length };
  }

  return {
    saveBuffer: persist,
    async saveStream(companyId, stream) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return persist(companyId, Buffer.concat(chunks));
    },
    readStream(storageKey) {
      return createReadStream(keyToPath(storageKey));
    },
    filePath(storageKey) {
      return keyToPath(storageKey);
    },
    async remove(storageKey) {
      await rm(keyToPath(storageKey), { force: true });
    },
    async probe(storageKey) {
      // ENOENT is the healthy answer for a key nobody wrote. Anything else —
      // the mount gone, the directory unreadable — is a real fault and is
      // rethrown so readiness reports it.
      try {
        await stat(keyToPath(storageKey));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },
  };
}
