/**
 * A QR encoder, because the API deliberately does not ship one.
 *
 * `POST /auth/mfa/enrol` returns the otpauth URI and the parameters needed to
 * draw it — and no bitmap. The reasoning is in the route's own comment: a QR
 * encoder on the server would be a dependency for a picture only a browser
 * looks at, and it would mean rendering the TOTP seed into an image the server
 * could cache or log. So the seed becomes a picture here, in the tab that asked
 * for it, and nowhere else.
 *
 * Byte mode, error-correction level M, versions 1–20 (up to 666 bytes — an
 * otpauth URI is ~150). Implements ISO/IEC 18004: Reed–Solomon over GF(2^8)
 * with the 0x11D primitive polynomial, the eight mask patterns and the four
 * penalty rules used to choose between them.
 */

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

/**
 * Level M, versions 1–20:
 * [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
 */
const ECC_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
];

/** Alignment-pattern centre coordinates per version (1-indexed). */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

/* ------------------------------------------------------------------ */
/* GF(2^8)                                                             */
/* ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial of the given degree, high-order term implicit. */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gmul(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gmul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) {
      result[i] = result[i]! ^ gmul(divisor[i]!, factor);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

const getBit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

function totalDataCodewords(version: number): number {
  const [, g1, d1, g2, d2] = ECC_M[version - 1]!;
  return g1 * d1 + g2 * d2;
}

/** Mode indicator + character count + payload, padded to the version's capacity. */
function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = totalDataCodewords(version);
  const countBits = version < 10 ? 8 : 16;
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);

  const capacityBits = capacity * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    out[i >>> 3] = byte;
  }
  // Alternating pad codewords, per the standard.
  for (let i = bits.length / 8, pad = 0; i < capacity; i += 1, pad += 1) {
    out[i] = pad % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/** Split into blocks, add Reed–Solomon parity, and interleave. */
function addEccAndInterleave(data: Uint8Array, version: number): Uint8Array {
  const [ecLen, g1, d1, g2, d2] = ECC_M[version - 1]!;
  const blocks: Uint8Array[] = [];
  const eccs: Uint8Array[] = [];
  const divisor = rsDivisor(ecLen);

  let offset = 0;
  for (let i = 0; i < g1 + g2; i += 1) {
    const len = i < g1 ? d1 : d2;
    const block = data.slice(offset, offset + len);
    offset += len;
    blocks.push(block);
    eccs.push(rsRemainder(block, divisor));
  }

  const maxData = Math.max(d1, d2);
  const out: number[] = [];
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.length) out.push(block[i]!);
    }
  }
  for (let i = 0; i < ecLen; i += 1) {
    for (const ecc of eccs) out.push(ecc[i]!);
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

export interface QrMatrix {
  size: number;
  /** `modules[y][x]` — true is dark. */
  modules: boolean[][];
  version: number;
}

function makeGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

/**
 * Encode `text` as a QR symbol at error-correction level M.
 * Throws when the payload exceeds version 20 (666 bytes).
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= ECC_M.length; v += 1) {
    const countBits = v < 10 ? 8 : 16;
    const needed = 4 + countBits + bytes.length * 8;
    if (needed <= totalDataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new Error("Payload is too long to encode as a QR code at this error-correction level.");
  }

  const size = version * 4 + 17;
  const modules = makeGrid(size);
  const isFunction = makeGrid(size);

  const setFn = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  /* --- timing patterns, drawn first: the finders overwrite part of them --- */
  for (let i = 0; i < size; i += 1) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  /* --- finder patterns + separators --- */
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  /* --- alignment patterns --- */
  const centres = ALIGNMENT[version - 1]!;
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = 0; j < centres.length; j += 1) {
      const last = centres.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = centres[i]!;
      const cy = centres[j]!;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  /* --- version information (v7+) --- */
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  /* --- format information; drawn once per mask below --- */
  const drawFormat = (mask: number) => {
    // Level M is 0b00 in the format field.
    const value = (0b00 << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((value << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) setFn(8, i, getBit(bits, i));
    setFn(8, 7, getBit(bits, 6));
    setFn(8, 8, getBit(bits, 7));
    setFn(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) setFn(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i += 1) setFn(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i += 1) setFn(8, size - 15 + i, getBit(bits, i));
    // the always-dark module
    setFn(8, size - 8, true);
  };
  drawFormat(0);

  /* --- codewords, zig-zag from the bottom right --- */
  const codewords = addEccAndInterleave(buildCodewords(bytes, version), version);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right === 6 ? 5 : right;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = col - j;
        const upward = ((col + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && bitIndex < codewords.length * 8) {
          modules[y]![x] = getBit(codewords[bitIndex >>> 3]!, 7 - (bitIndex & 7));
          bitIndex += 1;
        }
      }
    }
  }

  /* --- masks --- */
  const maskAt = (mask: number, x: number, y: number): boolean => {
    switch (mask) {
      case 0:
        return (x + y) % 2 === 0;
      case 1:
        return y % 2 === 0;
      case 2:
        return x % 3 === 0;
      case 3:
        return (x + y) % 3 === 0;
      case 4:
        return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5:
        return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6:
        return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default:
        return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (isFunction[y]![x]) continue;
        if (maskAt(mask, x, y)) modules[y]![x] = !modules[y]![x];
      }
    }
  };

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(mask);
    drawFormat(mask);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask); // XOR again to undo
  }
  applyMask(bestMask);
  drawFormat(bestMask);

  return { size, modules, version };
}

/* ------------------------------------------------------------------ */
/* Mask selection                                                      */
/* ------------------------------------------------------------------ */

function penaltyScore(modules: boolean[][], size: number): number {
  let result = 0;

  const addHistory = (runLength: number, history: number[]) => {
    let length = runLength;
    if (history[0] === 0) length += size; // the quiet zone counts as light
    history.pop();
    history.unshift(length);
  };

  const countPatterns = (history: number[]): number => {
    const n = history[1]!;
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (
      (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    );
  };

  const terminate = (runColor: boolean, runLength: number, history: number[]): number => {
    let length = runLength;
    if (runColor) {
      addHistory(length, history);
      length = 0;
    }
    length += size;
    addHistory(length, history);
    return countPatterns(history);
  };

  /* rules 1 and 3, by row then by column */
  for (let y = 0; y < size; y += 1) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x += 1) {
      if (modules[y]![x] === runColor) {
        runLength += 1;
        if (runLength === 5) result += 3;
        else if (runLength > 5) result += 1;
      } else {
        addHistory(runLength, history);
        if (!runColor) result += countPatterns(history) * 40;
        runColor = modules[y]![x]!;
        runLength = 1;
      }
    }
    result += terminate(runColor, runLength, history) * 40;
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y += 1) {
      if (modules[y]![x] === runColor) {
        runLength += 1;
        if (runLength === 5) result += 3;
        else if (runLength > 5) result += 1;
      } else {
        addHistory(runLength, history);
        if (!runColor) result += countPatterns(history) * 40;
        runColor = modules[y]![x]!;
        runLength = 1;
      }
    }
    result += terminate(runColor, runLength, history) * 40;
  }

  /* rule 2 — 2x2 blocks of one colour */
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) {
        result += 3;
      }
    }
  }

  /* rule 4 — balance of dark and light */
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (modules[y]![x]) dark += 1;
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * 10;

  return result;
}

/** The symbol as an SVG path `d`, one module = one unit, origin at 0,0. */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y]![x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return parts.join("");
}
