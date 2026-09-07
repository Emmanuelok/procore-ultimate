/**
 * Test-only fixtures shared by the field module's unit and integration
 * tests: a JPEG with a real EXIF APP1 segment (date, GPS, orientation,
 * make) and a multipart body builder for `app.inject`.
 */

/**
 * Build a JPEG with an EXIF APP1 (little-endian) carrying date, GPS,
 * orientation and, when `thumbnail` is given, a JPEG-compressed rendition in
 * IFD1 exactly as a camera writes it (tags 0x0201/0x0202/0x0103).
 */
export function jpegWithExif(options: { thumbnail?: Buffer } = {}): Buffer {
  const IFD0_COUNT = 4;
  const ifd0Start = 8;
  const ifd0Size = 2 + IFD0_COUNT * 12 + 4;
  const short = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const long = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const rational = (n: number, d: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(n, 0);
    b.writeUInt32LE(d, 4);
    return b;
  };
  const make = Buffer.from("Canon\0", "latin1");
  const exifIfdSize = 2 + 1 * 12 + 4;
  const gpsIfdSize = 2 + 4 * 12 + 4;
  // Layout: ifd0 | make | exifIfd | dateTime | gpsIfd | lat | lng
  const makeOffset = ifd0Start + ifd0Size;
  const exifIfdOffset = makeOffset + make.length;
  const dateTime = Buffer.from("2026:08:12 14:30:15\0", "latin1");
  const dateOffset = exifIfdOffset + exifIfdSize;
  const gpsIfdOffset = dateOffset + dateTime.length;
  const latOffset = gpsIfdOffset + gpsIfdSize;
  const lat = Buffer.concat([rational(51, 1), rational(30, 1), rational(0, 1)]);
  const lng = Buffer.concat([rational(0, 1), rational(7, 1), rational(3960, 100)]);
  const lngOffset = latOffset + lat.length;
  // IFD1 (the thumbnail directory) sits after every IFD0 value block.
  const thumbnail = options.thumbnail ?? null;
  const ifd1Size = 2 + 3 * 12 + 4;
  const ifd1Offset = lngOffset + lng.length;
  const thumbDataOffset = ifd1Offset + ifd1Size;

  const e = (tag: number, type: number, count: number, inline: Buffer, offset?: number): Buffer => {
    const b = Buffer.alloc(12);
    b.writeUInt16LE(tag, 0);
    b.writeUInt16LE(type, 2);
    b.writeUInt32LE(count, 4);
    if (offset !== undefined) b.writeUInt32LE(offset, 8);
    else inline.copy(b, 8);
    return b;
  };
  const ifd0 = Buffer.concat([
    short(IFD0_COUNT),
    e(0x010f, 2, make.length, Buffer.alloc(0), makeOffset),
    e(0x0112, 3, 1, short(6)),
    e(0x8769, 4, 1, long(exifIfdOffset)),
    e(0x8825, 4, 1, long(gpsIfdOffset)),
    long(thumbnail ? ifd1Offset : 0),
  ]);
  const exifIfd = Buffer.concat([short(1), e(0x9003, 2, dateTime.length, Buffer.alloc(0), dateOffset), long(0)]);
  const gpsIfd = Buffer.concat([
    short(4),
    e(0x0001, 2, 2, Buffer.from("N\0\0\0", "latin1")),
    e(0x0002, 5, 3, Buffer.alloc(0), latOffset),
    e(0x0003, 2, 2, Buffer.from("W\0\0\0", "latin1")),
    e(0x0004, 5, 3, Buffer.alloc(0), lngOffset),
    long(0),
  ]);
  const ifd1 = thumbnail
    ? Buffer.concat([
        short(3),
        e(0x0103, 3, 1, short(6)), // compression: JPEG
        e(0x0201, 4, 1, long(thumbDataOffset)),
        e(0x0202, 4, 1, long(thumbnail.length)),
        long(0),
      ])
    : Buffer.alloc(0);
  const tiffHeader = Buffer.concat([Buffer.from("II", "latin1"), short(0x2a), long(ifd0Start)]);
  const tiff = Buffer.concat([
    tiffHeader, ifd0, make, exifIfd, dateTime, gpsIfd, lat, lng,
    ...(thumbnail ? [ifd1, thumbnail] : []),
  ]);
  const app1Body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), short(app1Body.length + 2).reverse(), app1Body]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

/** A tiny but structurally valid JPEG, used as an embedded EXIF thumbnail. */
export function tinyJpeg(marker = 0x2a): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, marker, 0x00, 0xff, 0xd9]);
}

/** A minimal valid PNG header + IEND — enough for the magic-byte sniffer. */
export function tinyPng(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
}

export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Build a multipart/form-data body for app.inject. */
export function multipartBody(
  fields: Record<string, string>,
  files: MultipartFile[],
  boundary = "----constructosfieldboundary",
): { body: Buffer; contentType: string } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\ncontent-type: ${f.contentType}\r\n\r\n`,
      ),
      f.data,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
