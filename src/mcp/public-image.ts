import type { Env } from "../env";
import {
  MCP_ISSUER,
  PUBLIC_IMAGE_CACHE_CONTROL,
  PUBLIC_WEBP_QUALITY,
  isAllowedMcpHostname,
} from "../limits";
import { bytesToArrayBuffer } from "../nai/binary";

export type PublishedImage = {
  url: string;
  mime: string;
  filename: string;
};

const PUBLIC_FILE_RE = /^(img_[a-f0-9]{32})\.(webp|png)$/i;

export function originalImageKey(id: string): string {
  return `orig/${id}.png`;
}

export function publicImageKey(id: string, ext: "webp" | "png"): string {
  return `i/${id}.${ext}`;
}

export function parsePublicImageFile(
  file: string,
): { id: string; ext: "webp" | "png" } | null {
  const match = PUBLIC_FILE_RE.exec(file);
  if (!match) return null;
  return {
    id: match[1]!.toLowerCase(),
    ext: match[2]!.toLowerCase() as "webp" | "png",
  };
}

export function publicImageOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      isAllowedMcpHostname(url.hostname)
    ) {
      return url.origin;
    }
  } catch {
    /* ignore */
  }
  return MCP_ISSUER;
}

export function publicImageUrl(
  origin: string,
  id: string,
  ext: "webp" | "png",
): string {
  return `${publicImageOrigin(origin)}/i/${id}.${ext}`;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytesToArrayBuffer(bytes)]).stream();
}

async function encodeWebp(
  env: Env,
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  if (!env.IMAGES) return null;
  try {
    const result = await env.IMAGES.input(bytesToStream(bytes)).output({
      format: "image/webp",
      quality: PUBLIC_WEBP_QUALITY,
    });
    const response = result.response();
    if (!response.ok) return null;
    const out = new Uint8Array(await response.arrayBuffer());
    return out.byteLength > 0 ? out : null;
  } catch {
    return null;
  }
}

async function existingPublicImage(
  bucket: R2Bucket,
  origin: string,
  imageId: string,
): Promise<PublishedImage | null> {
  const webp = await bucket.head(publicImageKey(imageId, "webp"));
  if (webp) {
    return {
      url: publicImageUrl(origin, imageId, "webp"),
      mime: "image/webp",
      filename: `${imageId}.webp`,
    };
  }
  const png = await bucket.head(publicImageKey(imageId, "png"));
  if (png) {
    return {
      url: publicImageUrl(origin, imageId, "png"),
      mime: "image/png",
      filename: `${imageId}.png`,
    };
  }
  return null;
}

/**
 * Store a public WebP (or PNG fallback) under `i/<id>.<ext>` and return the
 * https URL. Null when the bucket is missing or the write fails.
 */
export async function publishImage(
  env: Env,
  origin: string,
  imageId: string,
  bytes: Uint8Array,
): Promise<PublishedImage | null> {
  if (!env.IMG_BUCKET || bytes.byteLength === 0) return null;
  try {
    const existing = await existingPublicImage(env.IMG_BUCKET, origin, imageId);
    if (existing) return existing;

    const webp = await encodeWebp(env, bytes);
    const ext = webp ? "webp" : "png";
    const body = webp ?? bytes;
    const mime = webp ? "image/webp" : "image/png";
    await env.IMG_BUCKET.put(publicImageKey(imageId, ext), bytesToArrayBuffer(body), {
      httpMetadata: { contentType: mime },
    });
    return {
      url: publicImageUrl(origin, imageId, ext),
      mime,
      filename: `${imageId}.${ext}`,
    };
  } catch {
    return null;
  }
}

function normalizeEtag(token: string): string {
  return token.trim().replace(/^W\//i, "").trim();
}

/** RFC 9110 If-None-Match: `*`, weak validators, and comma-separated lists. */
export function ifNoneMatchHits(inm: string, etag: string): boolean {
  const tokens = inm.split(",").map((part) => part.trim()).filter(Boolean);
  if (tokens.includes("*")) return true;
  const want = normalizeEtag(etag);
  return tokens.some((token) => normalizeEtag(token) === want);
}

function publicImageNotFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Public capability-URL handler for `GET|HEAD /i/:file`. */
export async function servePublicImage(
  env: Env,
  file: string,
  request?: Request,
): Promise<Response> {
  const parsed = parsePublicImageFile(file);
  if (!parsed || !env.IMG_BUCKET) return publicImageNotFound();

  const key = publicImageKey(parsed.id, parsed.ext);
  const obj = await env.IMG_BUCKET.get(key);
  if (!obj) return publicImageNotFound();

  const mime =
    obj.httpMetadata?.contentType ??
    (parsed.ext === "webp" ? "image/webp" : "image/png");
  const headers = new Headers();
  headers.set("Content-Type", mime);
  headers.set("Cache-Control", PUBLIC_IMAGE_CACHE_CONTROL);
  headers.set("X-Content-Type-Options", "nosniff");
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
  if (obj.size) headers.set("Content-Length", String(obj.size));

  const inm = request?.headers.get("If-None-Match");
  if (inm && obj.httpEtag && ifNoneMatchHits(inm, obj.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  if (request?.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
