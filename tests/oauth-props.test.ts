import { describe, expect, it } from "vitest";
import {
  LOCAL_DEV_ORIGIN,
  MCP_ISSUER,
  MCP_RESOURCE,
  mcpOriginFromRequest,
  mcpResourceFromRequest,
} from "../src/limits";
import {
  grantedScopes,
  isInternalOAuthAccessToken,
  naiAuthFromProps,
  naiUserId,
  resolveMcpToolAuth,
  resolveNaiBearer,
} from "../src/oauth/props";
import { testEnv } from "./helpers";

const LIBRARY_ACCESS_TOKEN = `nai-${"ab".repeat(32)}:grantid:secretsecret`;

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

describe("resolveMcpToolAuth", () => {
  it("does not fall back to the inbound header when OAuth props are present", () => {
    expect(
      resolveMcpToolAuth(
        { naiAuth: "Bearer x" },
        "Bearer header-token-xx",
      ),
    ).toBeNull();
    expect(
      resolveMcpToolAuth(
        { naiAuth: "Bearer abcdefghijklmnop" },
        "Bearer header-token-xx",
      ),
    ).toBe("Bearer abcdefghijklmnop");
  });

  it("uses the inbound header when OAuth props were never set", () => {
    expect(resolveMcpToolAuth({}, "Bearer header-token-xx")).toBe(
      "Bearer header-token-xx",
    );
    expect(resolveMcpToolAuth(undefined, "Bearer header-token-xx")).toBe(
      "Bearer header-token-xx",
    );
  });
});

describe("isInternalOAuthAccessToken", () => {
  it("detects this Worker's opaque access tokens", () => {
    expect(isInternalOAuthAccessToken(LIBRARY_ACCESS_TOKEN)).toBe(true);
    expect(isInternalOAuthAccessToken("header-token-xx")).toBe(false);
    expect(isInternalOAuthAccessToken("abc:def:ghi-token")).toBe(false);
  });
});

describe("resolveNaiBearer", () => {
  it("accepts a format-valid NovelAI token for the pinned MCP resource", async () => {
    const out = await resolveNaiBearer({
      token: "header-token-xx",
      request: new Request("https://nai.hoshinoaya.com/mcp"),
      env: testEnv(),
    });
    expect(out).toEqual({
      props: { naiAuth: "Bearer header-token-xx" },
      audience: MCP_RESOURCE,
    });
  });

  it("rejects a short token so OAuthProvider can 401", async () => {
    const out = await resolveNaiBearer({
      token: "x",
      request: new Request("https://nai.hoshinoaya.com/mcp"),
      env: testEnv(),
    });
    expect(out).toBeNull();
  });

  it("rejects an expired-looking library access token", async () => {
    const out = await resolveNaiBearer({
      token: LIBRARY_ACCESS_TOKEN,
      request: new Request("https://nai.hoshinoaya.com/mcp"),
      env: testEnv(),
    });
    expect(out).toBeNull();
  });

  it("binds the audience to the request origin for local and workers.dev hosts", async () => {
    const local = await resolveNaiBearer({
      token: "header-token-xx",
      request: new Request("http://127.0.0.1:8787/mcp"),
      env: testEnv(),
    });
    expect(local?.audience).toBe("http://127.0.0.1:8787/mcp");

    const workersDev = await resolveNaiBearer({
      token: "header-token-xx",
      request: new Request("https://nai.example.workers.dev/mcp"),
      env: testEnv(),
    });
    expect(workersDev?.audience).toBe("https://nai.example.workers.dev/mcp");
  });
});

describe("mcpResourceFromRequest", () => {
  it("pins allowed hosts to origin + /mcp and others to the canonical resource", () => {
    expect(
      mcpResourceFromRequest(new Request("https://nai.hoshinoaya.com/mcp")),
    ).toBe(MCP_RESOURCE);
    expect(
      mcpResourceFromRequest(new Request("http://127.0.0.1:8787/mcp")),
    ).toBe("http://127.0.0.1:8787/mcp");
    expect(
      mcpResourceFromRequest(
        new Request("https://nai.example.workers.dev/v1/models"),
      ),
    ).toBe("https://nai.example.workers.dev/mcp");
    expect(
      mcpResourceFromRequest(new Request("https://evil.example/mcp")),
    ).toBe(MCP_RESOURCE);
  });
});

describe("mcpOriginFromRequest", () => {
  it("uses the request origin on allowed hosts", () => {
    expect(
      mcpOriginFromRequest(new Request("https://nai.hoshinoaya.com/mcp")),
    ).toBe(MCP_ISSUER);
    expect(
      mcpOriginFromRequest(new Request("http://127.0.0.1:8787/mcp")),
    ).toBe("http://127.0.0.1:8787");
    expect(
      mcpOriginFromRequest(new Request("https://evil.example/mcp")),
    ).toBe(MCP_ISSUER);
  });

  it("maps wrangler custom-domain http rewrites to the local listen origin", () => {
    expect(
      mcpOriginFromRequest(new Request("http://nai.hoshinoaya.com/mcp")),
    ).toBe(LOCAL_DEV_ORIGIN);
    expect(
      mcpOriginFromRequest(
        new Request("http://nai.hoshinoaya.com/mcp", {
          headers: { Host: "127.0.0.1:8787" },
        }),
      ),
    ).toBe(LOCAL_DEV_ORIGIN);
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
