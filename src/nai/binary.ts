import { Buffer } from "node:buffer";

const PNG_MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
  // Buffer.from(..., "base64") is lenient; reject invalid alphabets so
  // decodeUserImage still treats junk as a client error.
  if (b64.length % 4 === 1 || !BASE64_RE.test(b64)) {
    throw new TypeError("invalid base64");
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function stripDataUrl(raw: string): string {
  const t = raw.trim();
  const m = /^data:[a-zA-Z0-9.+/-]+;base64,/i.exec(t);
  const body = m ? t.slice(m[0].length) : t;
  return body.replace(/\s+/g, "");
}

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

export function isPng(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_MAGIC);
}

export function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP_MAGIC);
}

/** Read width/height from PNG IHDR. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192) return null;
  return { width, height };
}
