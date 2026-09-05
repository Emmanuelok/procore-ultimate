import { createHash } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config.js";
import type { SavedObject, StorageService } from "./storage.js";

/**
 * S3-compatible storage driver. Works against Railway Buckets
 * (https://storage.railway.app), AWS S3, Cloudflare R2, or MinIO — anything
 * speaking the S3 API. Objects stay content-addressed exactly like the local
 * driver (<companyId>/<sha2>/<sha256>), so switching drivers never changes a
 * stored `storageKey` and identical payloads dedupe.
 */
export function createS3Storage(cfg: Config): StorageService {
  const bucket = cfg.S3_BUCKET;
  if (!bucket || !cfg.S3_ENDPOINT || !cfg.S3_ACCESS_KEY_ID || !cfg.S3_SECRET_ACCESS_KEY) {
    throw new Error(
      "STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
    );
  }
  const client = new S3Client({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: cfg.S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
    },
  });

  async function exists(key: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async function persist(companyId: string, data: Buffer): Promise<SavedObject> {
    const sha256 = createHash("sha256").update(data).digest("hex");
    // Forward-slash keys regardless of host OS — S3 keys are not paths.
    const storageKey = `${companyId}/${sha256.slice(0, 2)}/${sha256}`;
    if (!(await exists(storageKey))) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: data,
          ContentLength: data.length,
          // The key embeds the sha256; also record it as metadata so the
          // object attests to its own integrity independently of our DB.
          Metadata: { sha256 },
        }),
      );
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
      // The interface is synchronous; bridge the async GetObject through a
      // PassThrough so callers can pipe immediately.
      const out = new PassThrough();
      void (async () => {
        try {
          // Local driver keys used path.join — normalize any legacy
          // backslash keys to S3 forward-slash form.
          const key = storageKey.replaceAll("\\", "/");
          const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          const body = res.Body as Readable | undefined;
          if (!body) {
            out.destroy(new Error(`Empty body for object ${key}`));
            return;
          }
          body.on("error", (err) => out.destroy(err));
          body.pipe(out);
        } catch (err) {
          out.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      })();
      return out;
    },
    filePath() {
      throw new Error("filePath is not supported by the s3 storage driver");
    },
    async remove(storageKey) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: storageKey.replaceAll("\\", "/") }),
      );
    },
    async probe(storageKey) {
      // A 404/NotFound means the bucket answered and the key is simply not
      // there — healthy. A 403, a bad endpoint or a signature failure throws,
      // which is exactly the case readiness exists to catch.
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: storageKey.replaceAll("\\", "/") }),
        );
        return true;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        const name = (err as { name?: string }).name;
        if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
        throw err;
      }
    },
  };
}
