import { describe, expect, it } from "vitest";
import { resolveNaiBaseUrl } from "../src/env";
import { HttpError } from "../src/errors";

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
