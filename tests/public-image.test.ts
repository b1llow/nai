import { describe, expect, it } from "vitest";
import app from "../src/app";
import { PUBLIC_IMAGE_CACHE_CONTROL } from "../src/limits";
import {
  ifNoneMatchHits,
  originalImageKey,
  parsePublicImageFile,
  publicImageKey,
  publicImageOrigin,
  publicImageUrl,
  publishImage,
  servePublicImage,
} from "../src/mcp/public-image";
import { base64ToBytes } from "../src/nai/binary";
import { testEnv } from "./helpers";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = base64ToBytes(PNG_1X1);
const IMAGE_ID = "img_" + "ab".repeat(16);

describe("public image helpers", () => {
  it("parses capability-URL filenames and rejects everything else", () => {
    expect(parsePublicImageFile(`${IMAGE_ID}.webp`)).toEqual({
      id: IMAGE_ID,
      ext: "webp",
    });
    expect(parsePublicImageFile(`${IMAGE_ID}.png`)).toEqual({
      id: IMAGE_ID,
      ext: "png",
    });
    expect(parsePublicImageFile("orig/secret.png")).toBeNull();
    expect(parsePublicImageFile("../img_ab.webp")).toBeNull();
    expect(parsePublicImageFile("img_short.webp")).toBeNull();
  });

  it("pins unknown origins to the production issuer", () => {
    expect(publicImageOrigin("https://nai.hoshinoaya.com")).toBe(
      "https://nai.hoshinoaya.com",
    );
    expect(publicImageOrigin("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(publicImageOrigin("https://evil.example")).toBe(
      "https://nai.hoshinoaya.com",
    );
    expect(publicImageUrl("https://evil.example", IMAGE_ID, "webp")).toBe(
      `https://nai.hoshinoaya.com/i/${IMAGE_ID}.webp`,
    );
  });
});

describe("publishImage", () => {
  it("writes a WebP rendition when the Images binding is available", async () => {
    const env = testEnv();
    const published = await publishImage(
      env,
      "https://nai.hoshinoaya.com",
      IMAGE_ID,
      PNG_BYTES,
    );
    expect(published).toEqual({
      url: `https://nai.hoshinoaya.com/i/${IMAGE_ID}.webp`,
      mime: "image/webp",
      filename: `${IMAGE_ID}.webp`,
    });
    const obj = await env.IMG_BUCKET!.get(publicImageKey(IMAGE_ID, "webp"));
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe("image/webp");
  });

  it("reuses an existing public object instead of rewriting", async () => {
    const env = testEnv();
    const first = await publishImage(
      env,
      "https://nai.hoshinoaya.com",
      IMAGE_ID,
      PNG_BYTES,
    );
    env.IMAGES = undefined;
    const second = await publishImage(
      env,
      "https://nai.hoshinoaya.com",
      IMAGE_ID,
      PNG_BYTES,
    );
    expect(second).toEqual(first);
    expect(await env.IMG_BUCKET!.head(publicImageKey(IMAGE_ID, "png"))).toBeNull();
  });

  it("returns null when the bucket is missing", async () => {
    const env = testEnv({ IMG_BUCKET: undefined });
    await expect(
      publishImage(env, "https://nai.hoshinoaya.com", IMAGE_ID, PNG_BYTES),
    ).resolves.toBeNull();
  });
});

describe("GET /i/:file", () => {
  it("serves a published object without auth and with immutable cache headers", async () => {
    const env = testEnv();
    await publishImage(env, "https://nai.hoshinoaya.com", IMAGE_ID, PNG_BYTES);
    const res = await app.request(`/i/${IMAGE_ID}.webp`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toBe(PUBLIC_IMAGE_CACHE_CONTROL);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("ETag")).toMatch(/^"/);
    expect(await res.arrayBuffer()).toBeTruthy();
  });

  it("returns 304 when If-None-Match matches", async () => {
    const env = testEnv();
    await publishImage(env, "https://nai.hoshinoaya.com", IMAGE_ID, PNG_BYTES);
    const first = await servePublicImage(env, `${IMAGE_ID}.webp`);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    const again = await servePublicImage(
      env,
      `${IMAGE_ID}.webp`,
      new Request(`https://nai.hoshinoaya.com/i/${IMAGE_ID}.webp`, {
        headers: { "If-None-Match": etag! },
      }),
    );
    expect(again.status).toBe(304);

    const weak = await servePublicImage(
      env,
      `${IMAGE_ID}.webp`,
      new Request(`https://nai.hoshinoaya.com/i/${IMAGE_ID}.webp`, {
        headers: { "If-None-Match": `W/${etag}, "other"` },
      }),
    );
    expect(weak.status).toBe(304);
  });

  it("treats If-None-Match lists and weak validators as hits", () => {
    expect(ifNoneMatchHits(`W/"abc", "def"`, `"abc"`)).toBe(true);
    expect(ifNoneMatchHits("*", `"abc"`)).toBe(true);
    expect(ifNoneMatchHits(`"nope"`, `"abc"`)).toBe(false);
  });

  it("returns 404 for missing, invalid, or private keys", async () => {
    const env = testEnv();
    const missing = await app.request(`/i/${IMAGE_ID}.webp`, {}, env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");

    const invalid = await app.request("/i/not-an-id.webp", {}, env);
    expect(invalid.status).toBe(404);

    const orig = await app.request(`/i/../orig/${IMAGE_ID}.png`, {}, env);
    expect(orig.status).toBe(404);
  });

  it("does not require Authorization", async () => {
    const env = testEnv();
    await publishImage(env, "https://nai.hoshinoaya.com", IMAGE_ID, PNG_BYTES);
    const res = await app.request(`/i/${IMAGE_ID}.webp`, {}, env);
    expect(res.status).toBe(200);
  });

  it("does not serve orig/ objects through the public /i/ route", async () => {
    const env = testEnv();
    await env.IMG_BUCKET!.put(originalImageKey(IMAGE_ID), PNG_BYTES, {
      httpMetadata: { contentType: "image/png" },
    });
    const res = await app.request(`/i/${IMAGE_ID}.png`, {}, env);
    expect(res.status).toBe(404);
    expect(await env.IMG_BUCKET!.head(originalImageKey(IMAGE_ID))).not.toBeNull();
  });

  it("rate-limits public image fetches and skips OPTIONS", async () => {
    const env = testEnv({
      API_RATE_LIMIT: { limit: async () => ({ success: false }) },
    });
    const denied = await app.request(
      `/i/${IMAGE_ID}.webp`,
      { headers: { "cf-connecting-ip": "203.0.113.9" } },
      env,
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("60");

    let called = 0;
    const preflight = await app.request(
      `/i/${IMAGE_ID}.webp`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "GET",
        },
      },
      {
        ...testEnv(),
        API_RATE_LIMIT: {
          limit: async () => {
            called += 1;
            return { success: false };
          },
        },
      },
    );
    expect(called).toBe(0);
    expect(preflight.status).toBeLessThan(400);
  });
});
