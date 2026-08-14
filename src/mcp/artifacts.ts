import type { Env } from "../env";
import { HttpError, openaiError } from "../errors";
import { ARTIFACT_TTL_SECONDS, MAX_ARTIFACT_BYTES } from "../limits";
import { bytesToArrayBuffer, bytesToBase64 } from "../nai/binary";
import {
  decodeUserImage,
  isVibeRef,
  parseImageId,
  parseVibeId,
  type DecodedImage,
} from "../nai/image-input";
import { naiUserId } from "../oauth/props";
import { originalImageKey } from "./public-image";

/**
 * Image artifacts live in R2 (`orig/<id>.png`, owner in customMetadata).
 * Public WebP renditions are written separately (`i/<id>.webp`).
 *
 * R2 is strongly consistent, so generate → upscale on any PoP sees the write.
 * A miss returns a recoverable 400 so the model can regenerate or pass PNG
 * base64. During the KV→R2 transition, {@link getImage} also reads legacy
 * `img:` KV rows (those expire on their own 24h TTL).
 *
 * Vibe tokens stay in OAUTH_KV (`vibe:` / `vibecache:`).
 *
 * Values over {@link MAX_ARTIFACT_BYTES} skip persist so the tool can still
 * return a public URL fallback or ImageContent.
 */

export type ImageArtifactMeta = {
  owner: string;
  mime: string;
  width?: number;
  height?: number;
  name: string;
};

export type StoredImage = {
  id: string;
  bytes: Uint8Array;
  base64: string;
  mime: string;
  width?: number;
  height?: number;
  name: string;
};

export type StoredVibe = {
  id: string;
  base64: string;
  model: string;
  information_extracted: number;
};

export type VibeArtifactMeta = {
  owner: string;
  model: string;
  information_extracted: number;
};

const NOT_FOUND =
  "was not found. Pass a current image_id, or PNG base64 instead.";

function imageKey(id: string): string {
  return `img:${id}`;
}

function vibeKey(id: string): string {
  return `vibe:${id}`;
}

function randomHex(byteLen: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(byteLen));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createImageId(): string {
  return `img_${randomHex(16)}`;
}

export function createVibeId(): string {
  return `vibe_${randomHex(16)}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Distinct floats stay distinct so 0.55 and 0.554 never share a cache slot. */
export function vibeIeKey(value: number): string {
  if (!Number.isFinite(value)) return "nan";
  return value.toString();
}

function vibeCacheKey(
  owner: string,
  hash: string,
  model: string,
  informationExtracted: number,
): string {
  const m = model.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return `vibecache:${owner}:${hash}:${m}:${vibeIeKey(informationExtracted)}`;
}

export async function artifactOwner(auth: string): Promise<string> {
  return naiUserId(auth);
}

function parseDim(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function storedFromBytes(
  id: string,
  bytes: Uint8Array,
  meta: { mime?: string; width?: number; height?: number; name?: string },
): StoredImage {
  return {
    id,
    bytes,
    base64: bytesToBase64(bytes),
    mime: typeof meta.mime === "string" && meta.mime ? meta.mime : "image/png",
    width: typeof meta.width === "number" ? meta.width : undefined,
    height: typeof meta.height === "number" ? meta.height : undefined,
    name: typeof meta.name === "string" && meta.name ? meta.name : "image_0.png",
  };
}

/**
 * Persist original PNG bytes in R2. Returns the new image_id, or null when
 * the object is too large or the write fails (caller may still publish/return
 * ImageContent).
 */
export async function putImage(
  env: Env,
  owner: string,
  bytes: Uint8Array,
  meta: Omit<ImageArtifactMeta, "owner">,
): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
    return null;
  }
  if (!env.IMG_BUCKET) return null;
  const id = createImageId();
  try {
    await env.IMG_BUCKET.put(originalImageKey(id), bytesToArrayBuffer(bytes), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        owner,
        mime: meta.mime,
        name: meta.name,
        width: meta.width != null ? String(meta.width) : "",
        height: meta.height != null ? String(meta.height) : "",
      },
    });
  } catch {
    return null;
  }
  return id;
}

async function getImageFromR2(
  env: Env,
  owner: string,
  id: string,
  param: string,
): Promise<StoredImage | null> {
  if (!env.IMG_BUCKET) return null;
  const obj = await env.IMG_BUCKET.get(originalImageKey(id));
  if (!obj) return null;
  const meta = obj.customMetadata ?? {};
  if (meta.owner !== owner) {
    throw openaiError(400, `${param} ${NOT_FOUND}`, {
      type: "invalid_request_error",
      param,
    });
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return storedFromBytes(id, bytes, {
    mime: meta.mime,
    name: meta.name,
    width: parseDim(meta.width),
    height: parseDim(meta.height),
  });
}

async function getImageFromLegacyKv(
  env: Env,
  owner: string,
  id: string,
): Promise<StoredImage | null> {
  const row = await env.OAUTH_KV.getWithMetadata<ImageArtifactMeta>(
    imageKey(id),
    { type: "arrayBuffer" },
  );
  const meta = row.metadata;
  if (!row.value || !meta || meta.owner !== owner) return null;
  return storedFromBytes(id, new Uint8Array(row.value), {
    mime: typeof meta.mime === "string" ? meta.mime : undefined,
    name: typeof meta.name === "string" ? meta.name : undefined,
    width: typeof meta.width === "number" ? meta.width : undefined,
    height: typeof meta.height === "number" ? meta.height : undefined,
  });
}

export async function getImage(
  env: Env,
  owner: string,
  raw: string,
  param = "image",
): Promise<StoredImage> {
  const id = parseImageId(raw);
  if (!id) {
    throw openaiError(
      400,
      `${param} is not a valid image_id (expected img_<32 hex> or nai://image/img_...)`,
      { type: "invalid_request_error", param },
    );
  }
  try {
    const fromR2 = await getImageFromR2(env, owner, id, param);
    if (fromR2) return fromR2;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    /* R2 platform errors fall through to the legacy KV read. */
  }

  const fromKv = await getImageFromLegacyKv(env, owner, id);
  if (fromKv) return fromKv;

  throw openaiError(400, `${param} ${NOT_FOUND}`, {
    type: "invalid_request_error",
    param,
  });
}

export async function putVibe(
  env: Env,
  owner: string,
  tokenB64: string,
  meta: Omit<VibeArtifactMeta, "owner">,
): Promise<string | null> {
  if (!tokenB64 || tokenB64.length > MAX_ARTIFACT_BYTES) {
    return null;
  }
  const id = createVibeId();
  try {
    await env.OAUTH_KV.put(vibeKey(id), tokenB64, {
      expirationTtl: ARTIFACT_TTL_SECONDS,
      metadata: {
        owner,
        model: meta.model,
        information_extracted: meta.information_extracted,
      } satisfies VibeArtifactMeta,
    });
  } catch {
    return null;
  }
  return id;
}

export async function getVibe(
  env: Env,
  owner: string,
  raw: string,
  param = "image",
): Promise<StoredVibe> {
  const id = parseVibeId(raw);
  if (!id) {
    throw openaiError(
      400,
      `${param} is not a valid vibe_id (expected vibe_<32 hex>)`,
      { type: "invalid_request_error", param },
    );
  }
  const row = await env.OAUTH_KV.getWithMetadata<VibeArtifactMeta>(vibeKey(id));
  const meta = row.metadata;
  if (!row.value || !meta || meta.owner !== owner) {
    throw openaiError(400, `${param} ${NOT_FOUND}`, {
      type: "invalid_request_error",
      param,
    });
  }
  return {
    id,
    base64: row.value,
    model: typeof meta.model === "string" ? meta.model : "",
    information_extracted:
      typeof meta.information_extracted === "number"
        ? meta.information_extracted
        : 1,
  };
}

export async function getCachedVibe(
  env: Env,
  owner: string,
  pngBytes: Uint8Array,
  model: string,
  informationExtracted: number,
): Promise<string | null> {
  try {
    const hash = await sha256Hex(pngBytes);
    const key = vibeCacheKey(owner, hash, model, informationExtracted);
    const row = await env.OAUTH_KV.getWithMetadata<VibeArtifactMeta>(key);
    if (!row.value || !row.metadata || row.metadata.owner !== owner) return null;
    return row.value;
  } catch {
    return null;
  }
}

export async function putCachedVibe(
  env: Env,
  owner: string,
  pngBytes: Uint8Array,
  model: string,
  informationExtracted: number,
  tokenB64: string,
): Promise<void> {
  if (!tokenB64 || tokenB64.length > MAX_ARTIFACT_BYTES) return;
  const hash = await sha256Hex(pngBytes);
  const key = vibeCacheKey(owner, hash, model, informationExtracted);
  try {
    await env.OAUTH_KV.put(key, tokenB64, {
      expirationTtl: ARTIFACT_TTL_SECONDS,
      metadata: {
        owner,
        model,
        information_extracted: informationExtracted,
      } satisfies VibeArtifactMeta,
    });
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Resolve an image field: image_id / nai://image URI from R2 (or legacy KV),
 * otherwise PNG base64 / data URL. vibe_id is rejected here — use
 * {@link resolveImageOrVibeRef}.
 */
export async function resolveImageRef(
  env: Env,
  owner: string,
  raw: string,
  param = "image",
): Promise<DecodedImage> {
  if (isVibeRef(raw)) {
    throw openaiError(
      400,
      `${param} expects an image_id or PNG, not a vibe_id`,
      { type: "invalid_request_error", param },
    );
  }
  if (parseImageId(raw)) {
    const stored = await getImage(env, owner, raw, param);
    return {
      base64: stored.base64,
      bytes: stored.bytes,
      width: stored.width,
      height: stored.height,
      isPng: true,
    };
  }
  return decodeUserImage(raw, param);
}

/** reference_images[].image: image_id, vibe_id, or raw PNG / encoded token. */
export async function resolveImageOrVibeRef(
  env: Env,
  owner: string,
  raw: string,
  param = "reference_images",
): Promise<{
  image: string;
  encoded: boolean;
  information_extracted?: number;
  model?: string;
}> {
  if (parseVibeId(raw)) {
    const vibe = await getVibe(env, owner, raw, param);
    return {
      image: vibe.base64,
      encoded: true,
      information_extracted: vibe.information_extracted,
      model: vibe.model || undefined,
    };
  }
  if (parseImageId(raw)) {
    const stored = await getImage(env, owner, raw, param);
    return { image: stored.base64, encoded: false };
  }
  return { image: raw, encoded: false };
}
