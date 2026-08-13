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
  it("prefers a request Bearer header over the Worker secret", () => {
    expect(
      resolveMcpAuthorization("Bearer header-token-xx", "secret-token-yy"),
    ).toBe("Bearer header-token-xx");
  });

  it("falls back to the Worker secret when the header is absent", () => {
    expect(resolveMcpAuthorization(undefined, "secret-token-yy")).toBe(
      "Bearer secret-token-yy",
    );
  });

  it("returns null when neither header nor secret is set", () => {
    expect(resolveMcpAuthorization(undefined, undefined)).toBeNull();
    expect(resolveMcpAuthorization("", "")).toBeNull();
  });

  it("rejects a malformed header even if a secret exists", () => {
    expect(() =>
      resolveMcpAuthorization("Bearer x", "secret-token-yy"),
    ).toThrow(HttpError);
  });

  it("treats a malformed secret as a server misconfiguration", () => {
    try {
      resolveMcpAuthorization(undefined, "short");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(500);
    }
  });
});
