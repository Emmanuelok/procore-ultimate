import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { parseRange, sliceTransform } from "./stream.js";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

describe("byte ranges (#278)", () => {
  it("parses explicit, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("returns null with no header and 'invalid' for unsatisfiable or malformed ranges", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("", 10)).toBeNull();
    expect(parseRange("bytes=", 10)).toBe("invalid");
    expect(parseRange("bytes=5-2", 10)).toBe("invalid");
    expect(parseRange("bytes=10-", 10)).toBe("invalid");
    expect(parseRange("items=0-1", 10)).toBe("invalid");
    expect(parseRange("bytes=0-1,3-4", 10)).toBe("invalid");
  });

  it("slices exactly the requested bytes out of a chunked stream", async () => {
    const source = Readable.from([Buffer.from("hello "), Buffer.from("wor"), Buffer.from("ld!")]);
    const out = await collect(source.pipe(sliceTransform(2, 8)));
    expect(out.toString()).toBe("llo wor");
  });

  it("stops emitting once the range is satisfied", async () => {
    const source = Readable.from([Buffer.from("abcdef"), Buffer.from("ghijkl")]);
    const out = await collect(source.pipe(sliceTransform(0, 2)));
    expect(out.toString()).toBe("abc");
  });
});
