import type { Env } from "../env";
import { openaiError } from "../errors";
import { ARTIFACT_TTL_SECONDS, MAX_ARTIFACT_BYTES } from "../limits";
import { bytesToBase64 } from "../nai/binary";
import {
  decodeUserImage,
  isVibeRef,
  parseImageId,
  parseVibeId,
  type DecodedImage,
} from "../nai/image-input";
import { naiUserId } from "../oauth/props";

/**
 * Image/vibe artifacts live in OAUTH_KV (prefix `img:` / `vibe:` / `vibecache:`).
 *
 * KV is eventually consistent across PoPs (~60s). Same-PoP generate → upscale
 * usually hits the write. A miss returns a recoverable 400 so the model can
 * retry, regenerate, or fall back to PNG base64. Upgrade path if misses become
 * common: R2 (strongly consistent), no new binding in this revision.
 *
 * Values over {@link MAX_ARTIFACT_BYTES} (under KV's 25 MiB cap) skip persist
 * so ImageContent still returns.
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
  "was not found or has expired. Retry shortly, regenerate, or pass PNG base64 instead.";

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

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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

/**
 * Persist PNG bytes. Returns the new image_id, or null when the object is too
 * large for KV or the write fails (caller still returns ImageContent).
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
  const id = createImageId();
  try {
    await env.OAUTH_KV.put(imageKey(id), bytesToArrayBuffer(bytes), {
      expirationTtl: ARTIFACT_TTL_SECONDS,
      metadata: {
        owner,
        mime: meta.mime,
        width: meta.width,
        height: meta.height,
        name: meta.name,
      } satisfies ImageArtifactMeta,
    });
  } catch {
    return null;
  }
  return id;
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
  const row = await env.OAUTH_KV.getWithMetadata<ImageArtifactMeta>(
    imageKey(id),
    { type: "arrayBuffer" },
  );
  const meta = row.metadata;
  if (!row.value || !meta || meta.owner !== owner) {
    throw openaiError(400, `${param} ${NOT_FOUND}`, {
      type: "invalid_request_error",
      param,
    });
  }
  const bytes = new Uint8Array(row.value);
  return {
    id,
    bytes,
    base64: bytesToBase64(bytes),
    mime: typeof meta.mime === "string" ? meta.mime : "image/png",
    width: typeof meta.width === "number" ? meta.width : undefined,
    height: typeof meta.height === "number" ? meta.height : undefined,
    name: typeof meta.name === "string" ? meta.name : "image_0.png",
  };
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
  const hash = await sha256Hex(pngBytes);
  const key = vibeCacheKey(owner, hash, model, informationExtracted);
  const row = await env.OAUTH_KV.getWithMetadata<VibeArtifactMeta>(key);
  if (!row.value || !row.metadata || row.metadata.owner !== owner) return null;
  return row.value;
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
 * Resolve an image field: image_id / nai://image URI from KV, otherwise PNG
 * base64 / data URL. vibe_id is rejected here — use {@link resolveImageOrVibeRef}.
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
}> {
  if (parseVibeId(raw)) {
    const vibe = await getVibe(env, owner, raw, param);
    return {
      image: vibe.base64,
      encoded: true,
      information_extracted: vibe.information_extracted,
    };
  }
  if (parseImageId(raw)) {
    const stored = await getImage(env, owner, raw, param);
    return { image: stored.base64, encoded: false };
  }
  return { image: raw, encoded: false };
}
