// PNG metadata: inserts tEXt (Latin-1) or iTXt (UTF-8) chunks right after IHDR.
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let table: Uint32Array | undefined;

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const isLatin1 = (text: string) => [...text].every((c) => c.charCodeAt(0) <= 0xff && c.length === 1);

/** One text chunk: tEXt when keyword and text are Latin-1, otherwise iTXt with UTF-8 text. */
export function textChunk(keyword: string, text: string): Uint8Array {
  if (!/^[\x20-\x7e]{1,79}$/.test(keyword)) throw new Error(`Invalid PNG text keyword "${keyword}".`);
  const key = Uint8Array.from(keyword, (c) => c.charCodeAt(0));
  if (isLatin1(text)) {
    const value = Uint8Array.from(text, (c) => c.charCodeAt(0));
    const data = new Uint8Array(key.length + 1 + value.length);
    data.set(key); data.set(value, key.length + 1);
    return chunk("tEXt", data);
  }
  const value = new TextEncoder().encode(text);
  // keyword \0 compression-flag(0) method(0) language-tag \0 translated-keyword \0 text
  const data = new Uint8Array(key.length + 5 + value.length);
  data.set(key);
  data.set(value, key.length + 5);
  return chunk("iTXt", data);
}

/** Returns a copy of the PNG with the given text entries inserted after IHDR. */
export function insertPngText(png: Uint8Array, entries: Record<string, string>): Uint8Array {
  for (let i = 0; i < 8; i += 1) if (png[i] !== SIGNATURE[i]) throw new Error("Not a PNG file.");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ihdrLength = view.getUint32(8);
  const type = String.fromCharCode(...png.subarray(12, 16));
  if (type !== "IHDR") throw new Error("PNG does not start with IHDR.");
  const insertAt = 8 + 12 + ihdrLength;
  const chunks = Object.entries(entries).filter(([, value]) => value).map(([key, value]) => textChunk(key, value));
  const extra = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, insertAt));
  let at = insertAt;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  out.set(png.subarray(insertAt), at);
  return out;
}

/** Lists chunks as [type, data] (for tests and validation). */
export function readPngChunks(png: Uint8Array): { type: string; data: Uint8Array; crcOk: boolean }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    const crcOk = crc32(png.subarray(at + 4, at + 8 + length)) === view.getUint32(at + 8 + length);
    out.push({ type, data, crcOk });
    at += 12 + length;
    if (type === "IEND") break;
  }
  return out;
}
