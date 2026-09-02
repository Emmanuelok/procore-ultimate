/**
 * Range-aware file streaming for the viewers (spec Vol I #278).
 *
 * pdf.js on the client opens a document with `disableAutoFetch` + range
 * requests when the first response advertises `Accept-Ranges: bytes` and a
 * `Content-Length`; it then fetches only the xref and the objects of the page
 * being shown. That is what turns "open one sheet of a 400 MB set" from a
 * 400 MB transfer into a few hundred kilobytes. The local storage driver
 * serves byte ranges straight off the file; an object store without
 * `filePath` support gets the range sliced out of the full stream — correct,
 * merely less efficient.
 */
import { createReadStream } from "node:fs";
import { Transform, type Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { StorageService } from "../../lib/storage.js";

export interface RangedObject {
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  filename: string;
  sha256: string;
}

export interface ParsedRange {
  start: number;
  end: number;
}

/** Parse a single-range `Range: bytes=a-b` header. Null = no/invalid header. */
export function parseRange(header: string | undefined, size: number): ParsedRange | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const a = m[1] ?? "";
  const b = m[2] ?? "";
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    // suffix range: last N bytes
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Number(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
    if (end >= size) end = size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** A Transform that emits only bytes [start, end] of what flows through it. */
export function sliceTransform(start: number, end: number): Transform {
  let offset = 0;
  const wanted = end - start + 1;
  let emitted = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const chunkStart = offset;
      const chunkEnd = offset + buf.length; // exclusive
      offset = chunkEnd;
      if (emitted >= wanted || chunkEnd <= start) return cb();
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(buf.length, end + 1 - chunkStart);
      if (to > from) {
        const piece = buf.subarray(from, to);
        emitted += piece.length;
        this.push(piece);
      }
      if (emitted >= wanted) this.push(null);
      cb();
    },
  });
}

function openRange(storage: StorageService, storageKey: string, range: ParsedRange | null): Readable {
  if (!range) return storage.readStream(storageKey);
  try {
    const path = storage.filePath(storageKey);
    return createReadStream(path, { start: range.start, end: range.end });
  } catch {
    const full = storage.readStream(storageKey);
    const slice = sliceTransform(range.start, range.end);
    full.on("error", (err) => slice.destroy(err));
    return full.pipe(slice);
  }
}

function dispositionValue(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Send a stored object honouring Range / If-None-Match. */
export function sendRanged(
  storage: StorageService,
  req: FastifyRequest,
  reply: FastifyReply,
  obj: RangedObject,
  options: { disposition?: "inline" | "attachment" } = {},
) {
  const etag = `"${obj.sha256}"`;
  const disposition = options.disposition ?? "inline";
  void reply
    .header("accept-ranges", "bytes")
    .header("etag", etag)
    .header("cache-control", "private, max-age=3600")
    .header("x-content-sha256", obj.sha256)
    .header("content-type", obj.contentType)
    .header("content-disposition", dispositionValue(disposition, obj.filename));

  if (req.headers["if-none-match"] === etag) {
    return reply.status(304).send();
  }
  const rangeHeader = req.headers.range;
  const parsed = parseRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, obj.sizeBytes);
  if (parsed === "invalid") {
    // The error body is JSON: override the media headers set above.
    return reply
      .status(416)
      .header("content-range", `bytes */${obj.sizeBytes}`)
      .header("content-type", "application/json; charset=utf-8")
      .removeHeader("content-disposition")
      .send({ statusCode: 416, error: "RangeNotSatisfiable", message: "Requested range is not satisfiable" });
  }
  if (parsed) {
    return reply
      .status(206)
      .header("content-range", `bytes ${parsed.start}-${parsed.end}/${obj.sizeBytes}`)
      .header("content-length", String(parsed.end - parsed.start + 1))
      .send(openRange(storage, obj.storageKey, parsed));
  }
  return reply
    .status(200)
    .header("content-length", String(obj.sizeBytes))
    .send(openRange(storage, obj.storageKey, null));
}
