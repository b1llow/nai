import { describe, expect, it } from "vitest";
import { resolveNaiBaseUrl, resolveNaiOrigin } from "../src/env";
import { HttpError } from "../src/errors";
import { isAllowedNaiPath } from "../src/limits";

describe("resolveNaiBaseUrl", () => {
  it("allows the production NovelAI hosts", () => {
    expect(
      resolveNaiBaseUrl({ NAI_BASE_URL: "https://text.novelai.net/" }),
    ).toBe("https://text.novelai.net");
    expect(
      resolveNaiBaseUrl({ NAI_BASE_URL: "https://api.novelai.net" }),
    ).toBe("https://api.novelai.net");
  });

  it("rejects other hosts, http, and credentialed URLs", () => {
    expect(() =>
      resolveNaiBaseUrl({ NAI_BASE_URL: "https://evil.example" }),
    ).toThrow(HttpError);
    expect(() =>
      resolveNaiBaseUrl({ NAI_BASE_URL: "http://text.novelai.net" }),
    ).toThrow(HttpError);
    expect(() =>
      resolveNaiBaseUrl({
        NAI_BASE_URL: "https://user:pass@text.novelai.net",
      }),
    ).toThrow(HttpError);
    expect(() =>
      resolveNaiBaseUrl({ NAI_BASE_URL: "https://169.254.169.254/" }),
    ).toThrow(HttpError);
    expect(() =>
      resolveNaiBaseUrl({ NAI_BASE_URL: "https://image.novelai.net" }),
    ).toThrow(HttpError);
  });

  it("allows local mocks only with the unsafe flag", () => {
    expect(() =>
      resolveNaiBaseUrl({ NAI_BASE_URL: "http://127.0.0.1:8788" }),
    ).toThrow(HttpError);
    expect(
      resolveNaiBaseUrl({
        NAI_BASE_URL: "http://127.0.0.1:8788",
        NAI_ALLOW_UNSAFE_BASE_URL: "1",
      }),
    ).toBe("http://127.0.0.1:8788");
  });
});

describe("resolveNaiOrigin", () => {
  const base = { NAI_BASE_URL: "https://text.novelai.net" };

  it("defaults image and api hosts when vars are omitted", () => {
    expect(resolveNaiOrigin(base, "image")).toBe("https://image.novelai.net");
    expect(resolveNaiOrigin(base, "api")).toBe("https://api.novelai.net");
  });

  it("rejects pointing image traffic at a text host", () => {
    expect(() =>
      resolveNaiOrigin(
        { ...base, NAI_IMAGE_BASE_URL: "https://text.novelai.net" },
        "image",
      ),
    ).toThrow(HttpError);
  });

  it("allows overriding image/api origins with the unsafe flag", () => {
    expect(
      resolveNaiOrigin(
        {
          ...base,
          NAI_IMAGE_BASE_URL: "http://127.0.0.1:8790",
          NAI_ALLOW_UNSAFE_BASE_URL: "1",
        },
        "image",
      ),
    ).toBe("http://127.0.0.1:8790");
  });
});

describe("isAllowedNaiPath", () => {
  it("allows OpenAI and native text paths on the text host", () => {
    expect(isAllowedNaiPath("text", "/oa/v1/chat/completions")).toBe(true);
    expect(isAllowedNaiPath("text", "/ai/generate")).toBe(true);
    expect(isAllowedNaiPath("text", "/ai/generate-image")).toBe(false);
  });

  it("allows listed image paths including suggest-tags queries", () => {
    expect(isAllowedNaiPath("image", "/ai/generate-image")).toBe(true);
    expect(
      isAllowedNaiPath("image", "/ai/generate-image/suggest-tags?prompt=blue"),
    ).toBe(true);
    expect(isAllowedNaiPath("image", "/oa/v1/models")).toBe(false);
    expect(isAllowedNaiPath("image", "/user/subscription")).toBe(true);
    expect(isAllowedNaiPath("image", "/user/information")).toBe(true);
  });

  it("rejects traversal, protocol-relative, and unknown api paths", () => {
    expect(isAllowedNaiPath("text", "//evil.example/oa/v1/models")).toBe(false);
    expect(isAllowedNaiPath("text", "/oa/v1/../secret")).toBe(false);
    expect(isAllowedNaiPath("api", "/user/login")).toBe(false);
    expect(isAllowedNaiPath("api", "/user/subscription")).toBe(false);
    expect(isAllowedNaiPath("api", "/ai/upscale")).toBe(true);
  });
});
