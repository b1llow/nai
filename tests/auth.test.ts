import { describe, expect, it } from "vitest";
import { parseAuthorization } from "../src/auth";
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
