import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { testEnv, testExecutionContext } from "./helpers";

const env = testEnv();
const ctx = testExecutionContext();

describe("MCP OAuth discovery", () => {
  it("challenges unauthenticated /mcp with protected-resource metadata", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    const www = res.headers.get("WWW-Authenticate") ?? "";
    expect(www).toMatch(/Bearer/i);
    expect(www).toMatch(/resource_metadata=/);
    expect(www).toMatch(/oauth-protected-resource/);
  });

  it("serves protected resource metadata for /mcp", async () => {
    const res = await worker.fetch(
      new Request(
        "https://nai.hoshinoaya.com/.well-known/oauth-protected-resource/mcp",
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource?: string;
      authorization_servers?: string[];
      scopes_supported?: string[];
    };
    expect(body.resource).toBe("https://nai.hoshinoaya.com/mcp");
    expect(body.authorization_servers).toEqual(["https://nai.hoshinoaya.com"]);
    expect(body.scopes_supported).toContain("mcp");
  });

  it("serves authorization server metadata", async () => {
    const res = await worker.fetch(
      new Request(
        "https://nai.hoshinoaya.com/.well-known/oauth-authorization-server",
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      client_id_metadata_document_supported?: boolean;
      code_challenge_methods_supported?: string[];
      scopes_supported?: string[];
      grant_types_supported?: string[];
    };
    expect(body.authorization_endpoint).toContain("/authorize");
    expect(body.token_endpoint).toContain("/oauth/token");
    expect(body.registration_endpoint).toContain("/oauth/register");
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.scopes_supported).toContain("offline_access");
    expect(body.grant_types_supported).toContain("refresh_token");
  });

  it("accepts a format-valid NovelAI Bearer on /mcp (compat path)", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer header-token-xx",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(res.status).not.toBe(401);
  });

  it("rejects a malformed Bearer through the OAuth gate", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer x",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an expired-looking library access token on /mcp", async () => {
    const token = `nai-${"ab".repeat(32)}:grantid:secretsecret`;
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("registers ChatGPT redirect URIs and rejects others", async () => {
    const ok = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      env,
      ctx,
    );
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as { client_id?: string };
    expect(created.client_id).toBeTruthy();

    const evil = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris: ["https://evil.example/steal"],
          token_endpoint_auth_method: "none",
        }),
      }),
      env,
      ctx,
    );
    expect(evil.status).toBe(400);
    const body = (await evil.json()) as { error?: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("returns 429 when DCR is rate-limited", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/oauth/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      testEnv({
        OAUTH_REGISTER_RATE_LIMIT: { limit: async () => ({ success: false }) },
      }),
      ctx,
    );
    expect(res.status).toBe(429);
  });
});
