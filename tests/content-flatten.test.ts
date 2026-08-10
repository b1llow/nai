import { describe, expect, it } from "vitest";
import { flattenContent, normalizeMessages } from "../src/content";
import { HttpError } from "../src/errors";

describe("flattenContent", () => {
  it("returns strings as-is", () => {
    expect(flattenContent("hello")).toBe("hello");
  });

  it("joins text parts with newline", () => {
    expect(
      flattenContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("accepts input_text / bare text", () => {
    expect(
      flattenContent([
        { type: "input_text", text: "x" },
        { text: "y" },
        "z",
      ]),
    ).toBe("x\ny\nz");
  });

  it("throws on image parts", () => {
    expect(() =>
      flattenContent([
        { type: "text", text: "ok" },
        { type: "image_url", image_url: { url: "https://x" } },
      ]),
    ).toThrow(HttpError);
    try {
      flattenContent([{ type: "image_url", image_url: { url: "u" } }]);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).message).toMatch(/only text content/i);
      expect((e as HttpError).param).toBe("messages");
    }
  });

  it("throws on audio/file parts", () => {
    expect(() =>
      flattenContent([{ type: "input_audio", input_audio: {} }]),
    ).toThrow(/only text content/i);
    expect(() => flattenContent([{ type: "file", file: {} }])).toThrow(
      /only text content/i,
    );
  });
});

describe("normalizeMessages", () => {
  it("rewrites developer → system", () => {
    const msgs = normalizeMessages([
      { role: "developer", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(msgs).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("rejects empty messages", () => {
    expect(() => normalizeMessages([])).toThrow(HttpError);
  });
});
