/**
 * Minimal ZIP writer (STORE method, no compression) for photo bulk download
 * (spec #438). Photos are already compressed; DEFLATE would spend CPU to
 * save nothing. Produces a standards-conformant archive: local headers,
 * central directory, end-of-central-directory, CRC-32 per entry, UTF-8
 * names. No external dependency.
 *
 * Two writers, one format:
 *  - `zipStream` is what the bulk-download route uses. It yields each local
 *    header, then pipes the entry's bytes straight through, then a data
 *    descriptor carrying the CRC and size it just measured. Nothing bigger
 *    than one read chunk is ever resident, so a 500 MB selection costs
 *    kilobytes of RSS instead of a gigabyte (verifier: photos.ts:662).
 *  - `buildZip` is the in-memory twin, kept for small archives and for the
 *    engine test that asserts the byte layout.
 *
 * Limits: classic (non-ZIP64) format — entries and totals under 4 GiB and
 * fewer than 65,535 entries, which the route caps well below.
 */
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
  mtime?: Date;
}

export interface ZipStreamEntry {
  name: string;
  mtime?: Date;
  /** Opens the entry's bytes. Called once, lazily, when the entry's turn comes. */
  open: () => Readable | AsyncIterable<Uint8Array>;
}

/** General-purpose bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
/** General-purpose bit 3: sizes and CRC follow the data in a descriptor. */
const FLAG_DATA_DESCRIPTOR = 0x0008;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const d = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: d };
}

function localHeader(
  name: Buffer,
  flags: number,
  time: number,
  date: number,
  crc: number,
  size: number,
): Buffer {
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(0, 8); // method: store
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  return local;
}

function centralHeader(
  name: Buffer,
  flags: number,
  time: number,
  date: number,
  crc: number,
  size: number,
  offset: number,
): Buffer {
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(offset, 42);
  name.copy(central, 46);
  return central;
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

/** De-duplicate names inside the archive: "a.jpg", "a (2).jpg", … */
export function uniqueZipNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const base = raw.split(/[\\/]+/).filter((s) => s !== "").pop() ?? "";
    const name = base.replace(/^\.+/, "") || "file";
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  });
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length >= 0xffff) throw new Error("Too many entries for a classic ZIP archive");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const names = uniqueZipNames(entries.map((e) => e.name));
  entries.forEach((entry, i) => {
    const name = Buffer.from(names[i]!, "utf8");
    const crc = crc32(entry.data) >>> 0;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const local = localHeader(name, FLAG_UTF8, time, date, crc, entry.data.length);
    locals.push(local, entry.data);
    centrals.push(centralHeader(name, FLAG_UTF8, time, date, crc, entry.data.length, offset));
    offset += local.length + entry.data.length;
  });
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  return Buffer.concat([...locals, ...centrals, endOfCentralDirectory(entries.length, cdSize, offset)]);
}

/**
 * The same archive, produced incrementally. The CRC and the true size of an
 * entry are only known once its bytes have gone past, so the local header
 * declares "descriptor follows" (bit 3) and the real numbers are written
 * after the data and again in the central directory. Every ZIP reader
 * understands this; it is how every streaming archiver works.
 */
async function* zipChunks(entries: readonly ZipStreamEntry[]): AsyncGenerator<Buffer> {
  if (entries.length >= 0xffff) throw new Error("Too many entries for a classic ZIP archive");
  const names = uniqueZipNames(entries.map((e) => e.name));
  const flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
  const centrals: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const name = Buffer.from(names[i]!, "utf8");
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const local = localHeader(name, flags, time, date, 0, 0);
    yield local;
    let crc = 0;
    let size = 0;
    for await (const chunk of entry.open()) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) continue;
      crc = crc32(buf, crc) >>> 0;
      size += buf.length;
      yield buf;
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    centrals.push(centralHeader(name, flags, time, date, crc, size, offset));
    offset += local.length + size + descriptor.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  yield Buffer.concat([...centrals, endOfCentralDirectory(entries.length, cdSize, offset)]);
}

export function zipStream(entries: readonly ZipStreamEntry[]): Readable {
  return Readable.from(zipChunks(entries));
}

/** Parse the central directory back out — used by tests and by nothing else. */
export function listZip(archive: Buffer): Array<{ name: string; size: number; crc: number; offset: number }> {
  const eocdSig = 0x06054b50;
  let eocdPos = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === eocdSig) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error("Not a ZIP archive");
  const count = archive.readUInt16LE(eocdPos + 10);
  let pos = archive.readUInt32LE(eocdPos + 16);
  const out: Array<{ name: string; size: number; crc: number; offset: number }> = [];
  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(pos) !== 0x02014b50) throw new Error("Bad central directory entry");
    const nameLen = archive.readUInt16LE(pos + 28);
    const extraLen = archive.readUInt16LE(pos + 30);
    const commentLen = archive.readUInt16LE(pos + 32);
    out.push({
      crc: archive.readUInt32LE(pos + 16),
      size: archive.readUInt32LE(pos + 24),
      offset: archive.readUInt32LE(pos + 42),
      name: archive.subarray(pos + 46, pos + 46 + nameLen).toString("utf8"),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
