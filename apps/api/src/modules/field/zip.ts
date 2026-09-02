/**
 * Minimal ZIP writer (STORE method, no compression) for photo bulk download
 * (spec #438). Photos are already compressed; DEFLATE would spend CPU to
 * save nothing. Produces a standards-conformant archive: local headers,
 * central directory, end-of-central-directory, CRC-32 per entry, UTF-8
 * names. No external dependency.
 *
 * Limits: classic (non-ZIP64) format — entries and totals under 4 GiB and
 * fewer than 65,535 entries, which the route caps well below.
 */
import { crc32 } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
  mtime?: Date;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const d = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: d };
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
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  });
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
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
