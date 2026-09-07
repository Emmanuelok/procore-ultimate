/**
 * Photo engine — pure media rules for spec Vol I §2.10:
 *   #428 magic-byte media-type sniffing (the client's content-type is a claim,
 *        not evidence) and a photo-specific size cap,
 *   #428 EXIF extraction from JPEG APP1 (DateTimeOriginal, GPS, orientation,
 *        make/model) without a native dependency,
 *   #433 pin validation, and a haversine distance for geofence checks.
 *
 * Deliberately does NOT resize or transcode: there is no image library in
 * the runtime, and pretending to make thumbnails would be a lie the UI
 * would then tell. What it CAN do without one is take the thumbnail the
 * camera already wrote into the file: `extractExifThumbnail` lifts the
 * JPEG-compressed rendition out of EXIF IFD1 (#428/PhotosPage.tsx:73). That
 * covers phone and camera captures — a gallery tile then costs ~10 KB
 * instead of ~4 MB — and honestly returns null for anything else (PNG
 * screenshots, stripped JPEGs, video), which the variant route reports as a
 * fallback to the original rather than hiding.
 */

export const PHOTO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Ceiling on one bulk-download selection (#438). The archive is streamed, so
 * this bounds transfer and storage read time rather than memory; it stays as
 * a guard against a single request pulling the whole project's media.
 */
export const BULK_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

export const PHOTO_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "video/mp4",
] as const;
export type PhotoMediaType = (typeof PHOTO_MEDIA_TYPES)[number];

/** Media type from the first bytes; null when the payload is not one we accept. */
export function sniffMediaType(buf: Buffer): PhotoMediaType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a") {
    return "image/gif";
  }
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "M4A ", "mp4v"].includes(brand)) return "video/mp4";
  }
  return null;
}

export function isPhotoMediaType(value: string): value is PhotoMediaType {
  return (PHOTO_MEDIA_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* EXIF                                                                */
/* ------------------------------------------------------------------ */

export interface ExifSummary {
  takenAt?: string;
  latitude?: number;
  longitude?: number;
  orientation?: number;
  make?: string;
  model?: string;
}

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface TiffReader {
  u16(off: number): number;
  u32(off: number): number;
  ascii(off: number, len: number): string;
  /** raw bytes at a TIFF-relative offset (used for the embedded thumbnail) */
  bytes(off: number, len: number): Buffer;
  rational(off: number): number;
  length: number;
}

function makeReader(buf: Buffer, tiffStart: number, littleEndian: boolean): TiffReader {
  const slice = buf.subarray(tiffStart);
  return {
    length: slice.length,
    u16: (off) => (littleEndian ? slice.readUInt16LE(off) : slice.readUInt16BE(off)),
    u32: (off) => (littleEndian ? slice.readUInt32LE(off) : slice.readUInt32BE(off)),
    ascii: (off, len) => slice.subarray(off, off + len).toString("latin1").replace(/\0+$/, ""),
    bytes: (off, len) => slice.subarray(off, off + len),
    rational: (off) => {
      const n = littleEndian ? slice.readUInt32LE(off) : slice.readUInt32BE(off);
      const d = littleEndian ? slice.readUInt32LE(off + 4) : slice.readUInt32BE(off + 4);
      return d === 0 ? 0 : n / d;
    },
  };
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** offset (into the TIFF block) of the value bytes */
  valueOffset: number;
}

function readIfd(r: TiffReader, offset: number): IfdEntry[] {
  if (offset + 2 > r.length) return [];
  const n = r.u16(offset);
  const entries: IfdEntry[] = [];
  for (let i = 0; i < n && i < 512; i += 1) {
    const base = offset + 2 + i * 12;
    if (base + 12 > r.length) break;
    const tag = r.u16(base);
    const type = r.u16(base + 2);
    const count = r.u32(base + 4);
    const size = (TYPE_SIZES[type] ?? 1) * count;
    const valueOffset = size <= 4 ? base + 8 : r.u32(base + 8);
    entries.push({ tag, type, count, valueOffset });
  }
  return entries;
}

function readShort(r: TiffReader, e: IfdEntry): number | undefined {
  if (e.valueOffset + 2 > r.length) return undefined;
  return e.type === 3 ? r.u16(e.valueOffset) : e.type === 4 ? r.u32(e.valueOffset) : undefined;
}

function readAscii(r: TiffReader, e: IfdEntry): string | undefined {
  if (e.type !== 2 || e.valueOffset + e.count > r.length) return undefined;
  const s = r.ascii(e.valueOffset, e.count).trim();
  return s === "" ? undefined : s;
}

function readCoordinate(r: TiffReader, e: IfdEntry): number | undefined {
  if (e.type !== 5 || e.count < 3 || e.valueOffset + 24 > r.length) return undefined;
  const deg = r.rational(e.valueOffset);
  const min = r.rational(e.valueOffset + 8);
  const sec = r.rational(e.valueOffset + 16);
  return deg + min / 60 + sec / 3600;
}

/** "YYYY:MM:DD HH:MM:SS" (EXIF) → ISO-8601 UTC; undefined when malformed. */
export function exifDateToIso(value: string | undefined, offset?: string): string | undefined {
  if (!value) return undefined;
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "Z"}`;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  // Reject the "0000:00:00" placeholder some cameras write.
  if (m[1] === "0000") return undefined;
  return new Date(t).toISOString();
}

/**
 * Locate the APP1/Exif segment of a JPEG and return a bounds-checked reader
 * over its TIFF block plus the offset of IFD0. Null for non-JPEGs, for JPEGs
 * with no APP1/Exif segment and for a malformed TIFF header.
 */
function findExifBlock(buf: Buffer): { r: TiffReader; ifd0Offset: number } | null {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1]!;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS: no EXIF before image data
    const segLen = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.subarray(off + 4, off + 10).toString("latin1") === "Exif\0\0") {
      const tiffStart = off + 10;
      if (tiffStart + 8 > buf.length) return null;
      const bom = buf.subarray(tiffStart, tiffStart + 2).toString("latin1");
      const littleEndian = bom === "II";
      if (!littleEndian && bom !== "MM") return null;
      // Clamp to the segment: everything EXIF addresses, thumbnail included,
      // lives inside APP1, so a hostile offset cannot read the image data.
      const r = makeReader(buf.subarray(0, Math.min(buf.length, off + 2 + segLen)), tiffStart, littleEndian);
      if (r.u16(2) !== 0x2a) return null;
      return { r, ifd0Offset: r.u32(4) };
    }
    off += 2 + segLen;
  }
  return null;
}

/**
 * Extract the EXIF fields the field record cares about from a JPEG. Returns
 * null for non-JPEGs and for JPEGs with no APP1/Exif segment. Never throws on
 * a truncated or hostile file — every read is bounds-checked.
 */
export function extractExif(buf: Buffer): ExifSummary | null {
  try {
    const block = findExifBlock(buf);
    if (!block) return null;
    const r = block.r;
    const ifd0 = readIfd(r, block.ifd0Offset);
    const out: ExifSummary = {};
    let exifIfdOffset: number | undefined;
    let gpsIfdOffset: number | undefined;
    for (const e of ifd0) {
      if (e.tag === 0x0112) {
        const v = readShort(r, e);
        if (v !== undefined) out.orientation = v;
      } else if (e.tag === 0x010f) {
        const v = readAscii(r, e);
        if (v !== undefined) out.make = v;
      } else if (e.tag === 0x0110) {
        const v = readAscii(r, e);
        if (v !== undefined) out.model = v;
      } else if (e.tag === 0x8769) exifIfdOffset = readShort(r, e);
      else if (e.tag === 0x8825) gpsIfdOffset = readShort(r, e);
    }
    if (exifIfdOffset !== undefined) {
      let dateTime: string | undefined;
      let offsetTime: string | undefined;
      for (const e of readIfd(r, exifIfdOffset)) {
        if (e.tag === 0x9003) dateTime = readAscii(r, e);
        else if (e.tag === 0x9011) offsetTime = readAscii(r, e);
      }
      const iso = exifDateToIso(dateTime, offsetTime);
      if (iso) out.takenAt = iso;
    }
    if (gpsIfdOffset !== undefined) {
      let latRef: string | undefined;
      let lngRef: string | undefined;
      let lat: number | undefined;
      let lng: number | undefined;
      for (const e of readIfd(r, gpsIfdOffset)) {
        if (e.tag === 0x0001) latRef = readAscii(r, e);
        else if (e.tag === 0x0002) lat = readCoordinate(r, e);
        else if (e.tag === 0x0003) lngRef = readAscii(r, e);
        else if (e.tag === 0x0004) lng = readCoordinate(r, e);
      }
      if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
        const latitude = latRef === "S" ? -lat : lat;
        const longitude = lngRef === "W" ? -lng : lng;
        if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0)) {
          out.latitude = Math.round(latitude * 1e6) / 1e6;
          out.longitude = Math.round(longitude * 1e6) / 1e6;
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Ceiling on an embedded thumbnail; real ones are 5–30 KB. */
export const EXIF_THUMBNAIL_MAX_BYTES = 256 * 1024;

/**
 * The camera's own thumbnail, lifted out of EXIF IFD1 (JPEGInterchangeFormat
 * 0x0201 / …Length 0x0202). It is a derivative of the very bytes that were
 * uploaded — not something a client supplied separately — so serving it as a
 * gallery tile shows the same evidence as the original, only smaller.
 * Returns null unless the file really carries one as JPEG-compressed data.
 */
export function extractExifThumbnail(buf: Buffer): Buffer | null {
  try {
    const block = findExifBlock(buf);
    if (!block) return null;
    const { r, ifd0Offset } = block;
    if (ifd0Offset + 2 > r.length) return null;
    const entryCount = r.u16(ifd0Offset);
    const nextPointer = ifd0Offset + 2 + entryCount * 12;
    if (nextPointer + 4 > r.length) return null;
    const ifd1Offset = r.u32(nextPointer);
    if (ifd1Offset === 0 || ifd1Offset >= r.length) return null;
    let start: number | undefined;
    let length: number | undefined;
    let compression: number | undefined;
    for (const e of readIfd(r, ifd1Offset)) {
      if (e.tag === 0x0201) start = readShort(r, e);
      else if (e.tag === 0x0202) length = readShort(r, e);
      else if (e.tag === 0x0103) compression = readShort(r, e);
    }
    if (start === undefined || length === undefined) return null;
    // 6 = JPEG (old-style), 7 = JPEG. Anything else is an uncompressed or
    // TIFF-tiled thumbnail we would have to transcode, which we will not fake.
    if (compression !== undefined && compression !== 6 && compression !== 7) return null;
    if (length <= 0 || length > EXIF_THUMBNAIL_MAX_BYTES) return null;
    if (start + length > r.length) return null;
    const thumb = r.bytes(start, length);
    if (thumb.length !== length) return null;
    if (!(thumb[0] === 0xff && thumb[1] === 0xd8 && thumb[2] === 0xff)) return null;
    return Buffer.from(thumb);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** Great-circle distance in kilometres. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A drawing pin lives in normalised sheet space. */
export function isValidPin(pin: unknown): pin is { sheetId: string; x: number; y: number } {
  if (!pin || typeof pin !== "object") return false;
  const p = pin as Record<string, unknown>;
  return (
    typeof p["sheetId"] === "string" &&
    p["sheetId"] !== "" &&
    typeof p["x"] === "number" &&
    typeof p["y"] === "number" &&
    p["x"] >= 0 && p["x"] <= 1 && p["y"] >= 0 && p["y"] <= 1
  );
}
