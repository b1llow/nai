import { describe, expect, it } from "vitest";
import { IMAGE_WIDGET_URI } from "../src/mcp/image-widget";
import { mcpJson, mcpNeedAuth, runTool, withImages, withWidgetBridge } from "../src/mcp/result";
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
    const out = await withImages(
      { env, owner: "nai-testowner", origin: "https://nai.hoshinoaya.com" },
      extra,
      [{ name: "image_0.png", bytes, base64: PNG_1X1, mimeType: "image/png" }],
    );

    const structured = out.structuredContent as {
      image_id: string;
      image_url: string;
      images: Array<{
        image_id: string;
        filename: string;
        resource_uri: string;
        url: string;
        mime_type: string;
      }>;
      files?: unknown;
    };
    expect(structured.files).toBeUndefined();
    expect(structured.image_id).toMatch(/^img_[a-f0-9]{32}$/);
    expect(structured.image_url).toBe(
      `https://nai.hoshinoaya.com/i/${structured.image_id}.webp`,
    );
    expect(structured.images).toHaveLength(1);
    expect(structured.images[0]?.filename).toBe("image_0.png");
    expect(structured.images[0]?.resource_uri).toBe(
      `nai://image/${structured.image_id}`,
    );
    expect(structured.images[0]?.image_id).toBe(structured.image_id);
    expect(structured.images[0]?.url).toBe(structured.image_url);
    expect(structured.images[0]?.mime_type).toBe("image/webp");

    expect(out.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(out.structuredContent, null, 2),
    });
    expect(out.content.some((block) => block.type === "image")).toBe(false);
    expect(out.content[1]).toEqual({
      type: "resource_link",
      uri: structured.image_url,
      name: `${structured.image_id}.webp`,
      mimeType: "image/webp",
    });
    expect(out._meta?.mcp_tool_result).toBeUndefined();
    expect(out._meta?.["openai/outputTemplate"]).toBeUndefined();
  });

  it("copies error envelopes onto widget _meta for ChatGPT", () => {
    const out = withWidgetBridge(mcpNeedAuth());
    expect(out.isError).toBe(true);
    expect(out._meta?.mcp_tool_result).toEqual({
      content: out.content,
      isError: true,
    });
    expect(out._meta?.call_tool_result).toEqual(out._meta?.mcp_tool_result);
  });

  it("attaches widget _meta only when runTool is opted in", async () => {
    const plain = await runTool("Bearer token-xx", async () => mcpJson({ text: "ok" }));
    expect(plain._meta?.mcp_tool_result).toBeUndefined();
    expect(plain.structuredContent).toEqual({ text: "ok" });

    const widget = await runTool(
      "Bearer token-xx",
      async () => mcpJson({ text: "ok" }),
      { widget: true, templateUri: "ui://novelai/image-preview-v2.html" },
    );
    expect(widget._meta?.mcp_tool_result).toEqual({
      content: widget.content,
      structuredContent: { text: "ok" },
    });
    expect(widget._meta).toMatchObject({
      ui: { resourceUri: "ui://novelai/image-preview-v2.html" },
      "openai/outputTemplate": "ui://novelai/image-preview-v2.html",
    });
  });

  it("does not advertise a base64 fallback when the image cannot be stored", async () => {
    const env = testEnv();
    const out = await withImages(
      { env, owner: "nai-testowner", origin: "https://nai.hoshinoaya.com" },
      { seed: 1 },
      [{ name: "image_0.png", bytes: new Uint8Array(0), base64: "" }],
    );
    const images = (out.structuredContent as { images: Array<{ skipped?: string }> })
      .images;
    expect(images[0]?.skipped).toMatch(/cannot be passed to later image tools/);
    expect(images[0]?.skipped).not.toMatch(/pass PNG base64/);
  });

  it("falls back to ImageContent when the public rendition cannot be written", async () => {
    const env = testEnv();
    const bucket = env.IMG_BUCKET!;
    const origPut = bucket.put.bind(bucket);
    bucket.put = (async (key, value, opts) => {
      if (String(key).startsWith("i/")) throw new Error("r2 public put failed");
      return origPut(key, value, opts);
    }) as typeof bucket.put;

    const out = await withImages(
      { env, owner: "nai-testowner", origin: "https://nai.hoshinoaya.com" },
      { seed: 1 },
      [{ name: "image_0.png", bytes: base64ToBytes(PNG_1X1), base64: PNG_1X1 }],
    );
    const structured = out.structuredContent as {
      image_id: string;
      image_url?: string;
    };
    expect(structured.image_id).toMatch(/^img_[a-f0-9]{32}$/);
    expect(structured.image_url).toBeUndefined();
    expect(out.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          data: PNG_1X1,
          mimeType: "image/png",
        }),
      ]),
    );
  });

  it("binds the preview widget when persist fails so ChatGPT can still mount", async () => {
    const env = testEnv({ IMG_BUCKET: undefined });
    const bytes = base64ToBytes(PNG_1X1);
    const out = await withImages(
      { env, owner: "nai-testowner", origin: "https://nai.hoshinoaya.com" },
      { seed: 1 },
      [{ name: "image_0.png", bytes, base64: PNG_1X1, mimeType: "image/png" }],
    );
    expect(out.structuredContent).toMatchObject({ image_id: null });
    expect(out._meta).toMatchObject({
      ui: { resourceUri: IMAGE_WIDGET_URI },
      "openai/outputTemplate": IMAGE_WIDGET_URI,
      mcp_tool_result: {
        structuredContent: { image_id: null },
      },
      call_tool_result: {
        structuredContent: { image_id: null },
      },
    });
    expect(out.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          data: PNG_1X1,
          mimeType: "image/png",
        }),
      ]),
    );
  });

  it("publishes a PNG URL when the Images binding is missing", async () => {
    const env = testEnv({ IMAGES: undefined });
    const out = await withImages(
      { env, owner: "nai-testowner", origin: "https://nai.hoshinoaya.com" },
      { seed: 1 },
      [{ name: "image_0.png", bytes: base64ToBytes(PNG_1X1), base64: PNG_1X1 }],
    );
    const structured = out.structuredContent as { image_url: string };
    expect(structured.image_url).toMatch(
      /^https:\/\/nai\.hoshinoaya\.com\/i\/img_[a-f0-9]{32}\.png$/,
    );
    expect(out.content.some((block) => block.type === "image")).toBe(false);
  });
});
