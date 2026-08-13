import { describe, expect, it } from "vitest";
import { mcpJson, withImages } from "../src/mcp/result";

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
  it("keeps PNG blobs in content and copies meta to structuredContent", () => {
    const meta = {
      seed: 42,
      model: "nai-diffusion-4-5-full",
      action: "generate",
      width: 832,
      height: 1216,
      files: ["image_0.png"],
    };
    const out = withImages(meta, [
      { name: "image_0.png", base64: "abc", mimeType: "image/png" },
    ]);
    expect(out.structuredContent).toEqual(meta);
    expect(out.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(meta, null, 2),
    });
    expect(out.content[1]).toEqual({
      type: "image",
      data: "abc",
      mimeType: "image/png",
    });
  });
});
