import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/errors";
import { MAX_ARTIFACT_BYTES } from "../src/limits";
import { originalImageKey } from "../src/mcp/public-image";
import { bytesToArrayBuffer } from "../src/nai/binary";
import {
  getCachedVibe,
  getImage,
  getVibe,
  putCachedVibe,
  putImage,
  putVibe,
  resolveImageOrVibeRef,
  resolveImageRef,
  vibeIeKey,
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
      /not found/,
    );
    const missing = "img_" + "11".repeat(16);
    await expect(getImage(env, OWNER, missing, "image")).rejects.toThrow(
      /not found/,
    );
  });

  it("stores the original PNG in R2 with owner metadata, not KV", async () => {
    const env = testEnv();
    const kvSpy = vi.spyOn(env.OAUTH_KV, "put");
    const id = await putImage(env, OWNER, base64ToBytes(PNG_1X1), {
      mime: "image/png",
      name: "image_0.png",
      width: 1,
      height: 1,
    });
    expect(kvSpy).not.toHaveBeenCalled();
    kvSpy.mockRestore();
    const obj = await env.IMG_BUCKET!.get(originalImageKey(id!));
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata).toMatchObject({
      owner: OWNER,
      mime: "image/png",
      name: "image_0.png",
      width: "1",
      height: "1",
    });
  });

  it("reads a legacy KV image_id when R2 has no object", async () => {
    const env = testEnv();
    const id = "img_" + "ab".repeat(16);
    await env.OAUTH_KV.put(`img:${id}`, bytesToArrayBuffer(base64ToBytes(PNG_1X1)), {
      metadata: {
        owner: OWNER,
        mime: "image/png",
        name: "legacy.png",
        width: 1,
        height: 1,
      },
    });
    const stored = await getImage(env, OWNER, id, "image");
    expect(stored.name).toBe("legacy.png");
    expect(stored.base64).toBe(PNG_1X1);
    expect(stored.width).toBe(1);
  });

  it("does not revive an expired legacy KV image_id", async () => {
    const env = testEnv();
    const id = "img_" + "cd".repeat(16);
    await env.OAUTH_KV.put(
      `img:${id}`,
      bytesToArrayBuffer(base64ToBytes(PNG_1X1)),
      { expiration: 1, metadata: { owner: OWNER, mime: "image/png", name: "old.png" } },
    );
    await expect(getImage(env, OWNER, id, "image")).rejects.toThrow(/not found/);
  });

  it("returns null when IMG_BUCKET is missing", async () => {
    const env = testEnv({ IMG_BUCKET: undefined });
    const id = await putImage(env, OWNER, base64ToBytes(PNG_1X1), {
      mime: "image/png",
      name: "image_0.png",
    });
    expect(id).toBeNull();
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
    expect(resolved).toEqual({
      image: "dG9rZW4=",
      encoded: true,
      information_extracted: 1,
      model: "nai-diffusion-4-5-full",
    });
  });

  it("preserves the stored information_extracted on vibe_id resolve", async () => {
    const env = testEnv();
    const id = await putVibe(env, OWNER, "dG9rZW4=", {
      model: "nai-diffusion-4-5-full",
      information_extracted: 0.42,
    });
    const resolved = await resolveImageOrVibeRef(env, OWNER, id!, "reference_images");
    expect(resolved.information_extracted).toBe(0.42);
    expect(resolved.encoded).toBe(true);
  });

  it("keeps nearby information_extracted values in separate cache slots", async () => {
    expect(vibeIeKey(0.55)).not.toBe(vibeIeKey(0.554));
    const env = testEnv();
    const png = base64ToBytes(PNG_1X1);
    await putCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 0.55, "ie-55");
    await putCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 0.554, "ie-554");
    expect(
      await getCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 0.55),
    ).toBe("ie-55");
    expect(
      await getCachedVibe(env, OWNER, png, "nai-diffusion-4-5-full", 0.554),
    ).toBe("ie-554");
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

  it("treats vibe cache read failures as misses", async () => {
    const env = testEnv();
    env.OAUTH_KV.getWithMetadata = (async () => {
      throw new Error("kv unavailable");
    }) as typeof env.OAUTH_KV.getWithMetadata;
    await expect(
      getCachedVibe(env, OWNER, base64ToBytes(PNG_1X1), "nai-diffusion-4-5-full", 1),
    ).resolves.toBeNull();
  });
});
