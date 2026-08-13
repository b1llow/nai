import { describe, expect, it } from "vitest";
import {
  grantedScopes,
  naiAuthFromProps,
  naiUserId,
  resolveNaiBearer,
} from "../src/oauth/props";
import { testEnv } from "./helpers";

describe("grantedScopes", () => {
  it("always includes mcp and keeps advertised extras", () => {
    expect(grantedScopes([])).toEqual(["mcp"]);
    expect(grantedScopes(["offline_access", "mcp", "evil"])).toEqual([
      "offline_access",
      "mcp",
    ]);
  });
});

describe("naiAuthFromProps", () => {
  it("returns a validated Bearer token from OAuth props", () => {
    expect(naiAuthFromProps({ naiAuth: "Bearer abcdefghijklmnop" })).toBe(
      "Bearer abcdefghijklmnop",
    );
  });

  it("ignores missing or malformed props", () => {
    expect(naiAuthFromProps(undefined)).toBeNull();
    expect(naiAuthFromProps({})).toBeNull();
    expect(naiAuthFromProps({ naiAuth: "Bearer x" })).toBeNull();
  });
});

describe("resolveNaiBearer", () => {
  it("accepts a format-valid NovelAI token", async () => {
    const out = await resolveNaiBearer({
      token: "header-token-xx",
      request: new Request("https://nai.hoshinoaya.com/mcp"),
      env: testEnv(),
    });
    expect(out).toEqual({ props: { naiAuth: "Bearer header-token-xx" } });
  });

  it("rejects a short token so OAuthProvider can 401", async () => {
    const out = await resolveNaiBearer({
      token: "x",
      request: new Request("https://nai.hoshinoaya.com/mcp"),
      env: testEnv(),
    });
    expect(out).toBeNull();
  });
});

describe("naiUserId", () => {
  it("returns a colon-free digest", async () => {
    const id = await naiUserId("abcdefghijklmnop");
    expect(id.startsWith("nai-")).toBe(true);
    expect(id).not.toContain(":");
    expect(id).toHaveLength(4 + 64);
  });
});
