const PNG_MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    parts.push(String.fromCharCode(...sub));
  }
  return btoa(parts.join(""));
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
