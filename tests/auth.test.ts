import { describe, expect, it } from "vitest";
import { parseAuthorization, resolveMcpAuthorization } from "../src/auth";
import { HttpError } from "../src/errors";

describe("parseAuthorization", () => {
  it("accepts a bounded printable Bearer token", () => {
    expect(parseAuthorization("Bearer abcdefghijklmnop")).toBe(
      "Bearer abcdefghijklmnop",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parseAuthorization("  Bearer abcdefghijklmnop  ")).toBe(
      "Bearer abcdefghijklmnop",
    );
  });

  it("rejects missing, short, or smuggled values", () => {
    expect(() => parseAuthorization(undefined)).toThrow(HttpError);
    expect(() => parseAuthorization("")).toThrow(HttpError);
    expect(() => parseAuthorization("Bearer x")).toThrow(HttpError);
    expect(() => parseAuthorization("Bearer token extra")).toThrow(HttpError);
    expect(() =>
      parseAuthorization("Bearer abcdefgh\nX-Injected: 1"),
    ).toThrow(HttpError);
    expect(() => parseAuthorization("Basic abcdefghijklmnop")).toThrow(HttpError);
  });
});

describe("resolveMcpAuthorization", () => {
  it("accepts a request Bearer header", () => {
    expect(resolveMcpAuthorization("Bearer header-token-xx")).toBe(
      "Bearer header-token-xx",
    );
  });

  it("returns null when the header is absent instead of using a secret", () => {
    expect(resolveMcpAuthorization(undefined)).toBeNull();
    expect(resolveMcpAuthorization("")).toBeNull();
    expect(resolveMcpAuthorization("   ")).toBeNull();
  });

  it("rejects a malformed header", () => {
    expect(() => resolveMcpAuthorization("Bearer x")).toThrow(HttpError);
  });
});
