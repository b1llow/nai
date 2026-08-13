import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/errors";
import { ARTIFACT_TTL_SECONDS, MAX_ARTIFACT_BYTES } from "../src/limits";
import {
  getCachedVibe,
  getImage,
  getVibe,
  putCachedVibe,
  putImage,
  putVibe,
  resolveImageOrVibeRef,
  resolveImageRef,
} from "../src/mcp/artifacts";
import { base64ToBytes } from "../src/nai/binary";
import {
  isImageRef,
  isVibeRef,
  parseImageId,
  parseVibeId,
} from "../src/nai/image-input";
import { testEnv } from "./helpers";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const OWNER = "nai-owner-a";
const OTHER = "nai-owner-b";

describe("image/vibe ref parsing", () => {
  it("accepts image_id and nai://image URIs", () => {
    const id = "img_" + "ab".repeat(16);
    expect(parseImageId(id)).toBe(id);
    expect(parseImageId(`nai://image/${id}`)).toBe(id);
    expect(isImageRef(id)).toBe(true);
    expect(parseImageId("image_0.png")).toBeNull();
    expect(isImageRef(PNG_1X1)).toBe(false);
  });

  it("accepts vibe_id", () => {
    const id = "vibe_" + "cd".repeat(16);
    expect(parseVibeId(id)).toBe(id);
    expect(isVibeRef(id)).toBe(true);
    expect(isVibeRef(id.replace("vibe_", "img_"))).toBe(false);
  });
});

describe("image artifact store", () => {
  it("round-trips PNG bytes with owner metadata", async () => {
    const env = testEnv();
    const bytes = base64ToBytes(PNG_1X1);
    const id = await putImage(env, OWNER, bytes, {
      mime: "image/png",
      name: "image_0.png",
      width: 1,
      height: 1,
    });
    expect(id).toMatch(/^img_[a-f0-9]{32}$/);

    const stored = await getImage(env, OWNER, id!, "image");
    expect(stored.base64).toBe(PNG_1X1);
    expect(stored.width).toBe(1);
    expect(stored.name).toBe("image_0.png");
    expect(Array.from(stored.bytes)).toEqual(Array.from(bytes));

    const viaUri = await getImage(env, OWNER, `nai://image/${id}`, "image");
    expect(viaUri.id).toBe(id);
  });

  it("hides existence from the wrong owner and from unknown ids", async () => {
    const env = testEnv();
    const id = await putImage(env, OWNER, base64ToBytes(PNG_1X1), {
      mime: "image/png",
      name: "image_0.png",
    });
    await expect(getImage(env, OTHER, id!, "image")).rejects.toBeInstanceOf(
      HttpError,
    );
    await expect(getImage(env, OTHER, id!, "image")).rejects.toThrow(
      /not found or has expired/,
    );
    const missing = "img_" + "11".repeat(16);
    await expect(getImage(env, OWNER, missing, "image")).rejects.toThrow(
      /not found or has expired/,
    );
  });

  it("rejects expired keys without leaking them", async () => {
    const env = testEnv();
    const id = await putImage(env, OWNER, base64ToBytes(PNG_1X1), {
      mime: "image/png",
      name: "image_0.png",
    });
    const key = `img:${id}`;
    const row = await env.OAUTH_KV.get(key, "arrayBuffer");
    await env.OAUTH_KV.put(key, row!, { expiration: 1, metadata: { owner: OWNER } });
    await expect(getImage(env, OWNER, id!, "image")).rejects.toThrow(
      /not found or has expired/,
    );
  });

  it("records a 24h TTL on put", async () => {
    const env = testEnv();
    const spy = vi.spyOn(env.OAUTH_KV, "put");
    await putImage(env, OWNER, base64ToBytes(PNG_1X1), {
      mime: "image/png",
      name: "image_0.png",
    });
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^img:img_[a-f0-9]{32}$/),
      expect.any(ArrayBuffer),
      expect.objectContaining({ expirationTtl: ARTIFACT_TTL_SECONDS }),
    );
    spy.mockRestore();
  });

  it("skips persist when the object exceeds the KV-safe cap", async () => {
    const env = testEnv();
    const id = await putImage(env, OWNER, new Uint8Array(MAX_ARTIFACT_BYTES + 1), {
      mime: "image/png",
      name: "huge.png",
    });
    expect(id).toBeNull();
  });
});

describe("resolveImageRef", () => {
  it("resolves image_id, URI, and PNG base64", async () => {
    const env = testEnv();
    const bytes = base64ToBytes(PNG_1X1);
    const id = await putImage(env, OWNER, bytes, {
      mime: "image/png",
      name: "image_0.png",
      width: 1,
      height: 1,
    });

    const fromId = await resolveImageRef(env, OWNER, id!, "image");
    expect(fromId.base64).toBe(PNG_1X1);
    expect(fromId.width).toBe(1);

    const fromUri = await resolveImageRef(
      env,
      OWNER,
      `nai://image/${id}`,
      "image",
    );
    expect(fromUri.base64).toBe(PNG_1X1);

    const fromB64 = await resolveImageRef(env, OWNER, PNG_1X1, "image");
    expect(fromB64.base64).toBe(PNG_1X1);
    expect(fromB64.isPng).toBe(true);
  });

  it("rejects vibe_id on a plain image field", async () => {
    const env = testEnv();
    await expect(
      resolveImageRef(env, OWNER, "vibe_" + "ab".repeat(16), "image"),
    ).rejects.toThrow(/not a vibe_id/);
  });
});

describe("vibe artifacts and cache", () => {
  it("stores vibe_id and resolves it as an encoded reference", async () => {
    const env = testEnv();
    const id = await putVibe(env, OWNER, "dG9rZW4=", {
      model: "nai-diffusion-4-5-full",
      information_extracted: 1,
    });
    expect(id).toMatch(/^vibe_[a-f0-9]{32}$/);
    const stored = await getVibe(env, OWNER, id!, "image");
    expect(stored.base64).toBe("dG9rZW4=");

    const resolved = await resolveImageOrVibeRef(env, OWNER, id!, "reference_images");
    expect(resolved).toEqual({ image: "dG9rZW4=", encoded: true });
  });

  it("caches encode results per owner+png+model+ie", async () => {
    const env = testEnv();
    const png = base64ToBytes(PNG_1X1);
    expect(
      await getCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 1),
    ).toBeNull();
    await putCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 1, "cached-token");
    expect(
      await getCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 1),
    ).toBe("cached-token");
    expect(
      await getCachedVibe(env, OTHER, png, "nai-diffusion-4-5-full", 1),
    ).toBeNull();
    expect(
      await getCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 0.5),
    ).toBeNull();
  });
});
