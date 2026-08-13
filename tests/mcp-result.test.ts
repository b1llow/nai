import { describe, expect, it } from "vitest";
import { mcpJson, withImages } from "../src/mcp/result";
import { base64ToBytes } from "../src/nai/binary";
import { testEnv } from "./helpers";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("mcpJson", () => {
  it("puts objects on structuredContent and serializes them as text", () => {
    const out = mcpJson({ text: "hello" });
    expect(out.structuredContent).toEqual({ text: "hello" });
    expect(out.content).toEqual([
      { type: "text", text: JSON.stringify({ text: "hello" }, null, 2) },
    ]);
    expect(out.isError).toBeUndefined();
  });

  it("wraps arrays as { items } so structuredContent stays an object", () => {
    const out = mcpJson([{ id: "xialong-v1" }]);
    expect(out.structuredContent).toEqual({ items: [{ id: "xialong-v1" }] });
  });
});

describe("withImages", () => {
  it("stores PNG bytes, returns image_id, and does not use files[] as the handle", async () => {
    const env = testEnv();
    const bytes = base64ToBytes(PNG_1X1);
    const extra = {
      seed: 42,
      model: "nai-diffusion-4-5-full",
      action: "generate",
      width: 832,
      height: 1216,
    };
    const out = await withImages({ env, owner: "nai-testowner" }, extra, [
      { name: "image_0.png", bytes, base64: PNG_1X1, mimeType: "image/png" },
    ]);

    const structured = out.structuredContent as {
      image_id: string;
      images: Array<{
        image_id: string;
        filename: string;
        resource_uri: string;
      }>;
      files?: unknown;
    };
    expect(structured.files).toBeUndefined();
    expect(structured.image_id).toMatch(/^img_[a-f0-9]{32}$/);
    expect(structured.images).toHaveLength(1);
    expect(structured.images[0]?.filename).toBe("image_0.png");
    expect(structured.images[0]?.resource_uri).toBe(
      `nai://image/${structured.image_id}`,
    );
    expect(structured.images[0]?.image_id).toBe(structured.image_id);

    expect(out.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(out.structuredContent, null, 2),
    });
    expect(out.content[1]).toMatchObject({
      type: "image",
      data: PNG_1X1,
      mimeType: "image/png",
      annotations: { audience: ["user"] },
    });
    expect(out.content[2]).toEqual({
      type: "resource_link",
      uri: structured.images[0]?.resource_uri,
      name: "image_0.png",
      mimeType: "image/png",
    });
  });
});
