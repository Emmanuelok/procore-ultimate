import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createS3Storage } from "./storage-s3.js";
import type { StorageService } from "./storage.js";

const BUCKET = "test";

/**
 * Minimal in-process S3 fake speaking just enough of the REST API for the
 * driver: path-style PUT/GET/HEAD/DELETE on /<bucket>/<key...>. Auth headers
 * are ignored (the SDK signs; we don't validate). Requests are counted so
 * tests can assert on wire behavior (e.g. content-addressed dedupe).
 */
interface FakeS3 {
  server: http.Server;
  port: number;
  objects: Map<string, Buffer>;
  counts: { put: number; get: number; head: number; delete: number };
  putKeys: string[];
  getKeys: string[];
}

async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const counts = { put: 0, get: 0, head: 0, delete: 0 };
  const putKeys: string[] = [];
  const getKeys: string[] = [];

  const server = http.createServer((req, res) => {
    // The SDK appends query params (?x-id=GetObject) — route on pathname only.
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const pathname = decodeURIComponent(url.pathname);
    const prefix = `/${BUCKET}/`;
    if (!pathname.startsWith(prefix)) {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><Error><Code>NoSuchBucket</Code></Error>`);
      return;
    }
    const key = pathname.slice(prefix.length);

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      switch (req.method) {
        case "PUT": {
          counts.put += 1;
          putKeys.push(key);
          const body = Buffer.concat(chunks);
          objects.set(key, body);
          res.writeHead(200, {
            etag: `"${createHash("md5").update(body).digest("hex")}"`,
          });
          res.end();
          return;
        }
        case "GET": {
          counts.get += 1;
          getKeys.push(key);
          const body = objects.get(key);
          if (!body) {
            res.writeHead(404, { "content-type": "application/xml" });
            res.end(
              `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code>` +
                `<Message>The specified key does not exist.</Message><Key>${key}</Key></Error>`,
            );
            return;
          }
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(body.length),
          });
          res.end(body);
          return;
        }
        case "HEAD": {
          counts.head += 1;
          const body = objects.get(key);
          if (!body) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(body.length),
          });
          res.end();
          return;
        }
        case "DELETE": {
          counts.delete += 1;
          objects.delete(key);
          res.writeHead(204);
          res.end();
          return;
        }
        default: {
          res.writeHead(405);
          res.end();
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, objects, counts, putKeys, getKeys };
}

/** Drain a readable fully into a single buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** A writable that discards everything — pipeline target for error tests. */
function devnull(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe("s3 storage driver", () => {
  let fake: FakeS3;
  let storage: StorageService;

  beforeAll(async () => {
    fake = await startFakeS3();
    storage = createS3Storage(
      loadConfig({
        NODE_ENV: "test",
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: `http://127.0.0.1:${fake.port}`,
        S3_BUCKET: BUCKET,
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
        S3_FORCE_PATH_STYLE: "true",
      }),
    );
  });

  afterAll(async () => {
    fake.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      fake.server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("round-trips a buffer through saveBuffer and readStream byte-identically", async () => {
    const data = randomBytes(64 * 1024);
    const saved = await storage.saveBuffer("company-rt", data);
    expect(saved.sizeBytes).toBe(data.length);

    const back = await collect(storage.readStream(saved.storageKey));
    expect(back.length).toBe(data.length);
    expect(back.equals(data)).toBe(true);
  });

  it("returns a sha256 matching an independent hash and <companyId>/<2>/<sha> key layout", async () => {
    const data = Buffer.from("content-addressed storage attests to itself");
    const expectedSha = createHash("sha256").update(data).digest("hex");

    const saved = await storage.saveBuffer("company-hash", data);
    expect(saved.sha256).toBe(expectedSha);
    expect(saved.storageKey).toBe(`company-hash/${expectedSha.slice(0, 2)}/${expectedSha}`);
    expect(saved.storageKey).toMatch(/^company-hash\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(saved.sizeBytes).toBe(data.length);
  });

  it("dedupes identical bytes: a second saveBuffer issues no second PUT", async () => {
    const data = randomBytes(1024);
    const putsBefore = fake.counts.put;
    const headsBefore = fake.counts.head;

    const first = await storage.saveBuffer("company-dedupe", data);
    expect(fake.counts.put).toBe(putsBefore + 1);

    const second = await storage.saveBuffer("company-dedupe", data);
    // HEAD found the object, so the PUT was short-circuited.
    expect(fake.counts.put).toBe(putsBefore + 1);
    expect(fake.counts.head).toBe(headsBefore + 2);
    expect(second).toEqual(first);
  });

  it("gives different companies distinct keys for identical bytes", async () => {
    const data = randomBytes(512);
    const sha = createHash("sha256").update(data).digest("hex");

    const a = await storage.saveBuffer("company-a", data);
    const b = await storage.saveBuffer("company-b", data);

    expect(a.storageKey).not.toBe(b.storageKey);
    expect(a.storageKey).toBe(`company-a/${sha.slice(0, 2)}/${sha}`);
    expect(b.storageKey).toBe(`company-b/${sha.slice(0, 2)}/${sha}`);
    expect(fake.objects.has(a.storageKey)).toBe(true);
    expect(fake.objects.has(b.storageKey)).toBe(true);
  });

  it("emits an error for a missing key instead of hanging", async () => {
    const missing = "company-none/ab/" + "0".repeat(64);
    await expect(pipeline(storage.readStream(missing), devnull())).rejects.toThrow();
  });

  it("remove() deletes the object so a subsequent read 404s", async () => {
    const data = randomBytes(256);
    const saved = await storage.saveBuffer("company-rm", data);
    expect(fake.objects.has(saved.storageKey)).toBe(true);

    const deletesBefore = fake.counts.delete;
    await storage.remove(saved.storageKey);
    expect(fake.counts.delete).toBe(deletesBefore + 1);
    expect(fake.objects.has(saved.storageKey)).toBe(false);

    await expect(pipeline(storage.readStream(saved.storageKey), devnull())).rejects.toThrow();
  });

  it("normalizes legacy backslash keys to forward slashes on read", async () => {
    const data = Buffer.from("windows-era key survives the driver swap");
    fake.objects.set("a/bc/key", data);

    const back = await collect(storage.readStream("a\\bc\\key"));
    expect(back.equals(data)).toBe(true);
    // The wire request must have hit the forward-slash path, not a literal "\".
    expect(fake.getKeys.at(-1)).toBe("a/bc/key");
  });

  it("saveStream buffers a chunked Readable into one identical object", async () => {
    const chunks = [randomBytes(1000), randomBytes(1000), randomBytes(37)];
    const data = Buffer.concat(chunks);
    const expectedSha = createHash("sha256").update(data).digest("hex");

    const saved = await storage.saveStream("company-stream", Readable.from(chunks));
    expect(saved.sha256).toBe(expectedSha);
    expect(saved.sizeBytes).toBe(data.length);

    const back = await collect(storage.readStream(saved.storageKey));
    expect(back.equals(data)).toBe(true);
  });

  it("filePath() throws — s3 objects have no local path", () => {
    expect(() => storage.filePath("company-x/ab/" + "0".repeat(64))).toThrow(
      /not supported by the s3 storage driver/,
    );
  });
});
