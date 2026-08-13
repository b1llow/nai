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
    expect(body.resource).toMatch(/\/mcp$/);
    expect(body.authorization_servers?.length).toBeGreaterThan(0);
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
});
