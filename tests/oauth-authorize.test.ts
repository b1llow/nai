import {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { openaiError } from "../src/errors";
import { handleAuthorize } from "../src/oauth/authorize";
import * as account from "../src/nai/account";
import { testEnv, testExecutionContext } from "./helpers";

const oauthReq: AuthRequest = {
  responseType: "code",
  clientId: "chatgpt-client",
  redirectUri: "https://chatgpt.com/connector/oauth/callback",
  scope: ["mcp", "offline_access"],
  state: "state-1",
  issuer: "https://nai.hoshinoaya.com",
};

function mockProvider(
  overrides: Partial<OAuthHelpers> = {},
): OAuthHelpers {
  return {
    parseAuthRequest: async () => oauthReq,
    lookupClient: async () => ({
      clientId: "chatgpt-client",
      redirectUris: [oauthReq.redirectUri],
      clientName: "ChatGPT",
    }),
    completeAuthorization: async () => ({
      redirectTo: "https://chatgpt.com/connector/oauth/callback?code=abc",
    }),
    ...overrides,
  } as OAuthHelpers;
}

function cookiesFrom(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) {
    const single = res.headers.get("Set-Cookie");
    if (single) setCookies.push(single);
  }
  return setCookies
    .map((c) => c.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

async function startConsent(
  completeImpl: OAuthHelpers["completeAuthorization"] = async () => ({
    redirectTo: "https://chatgpt.com/connector/oauth/callback?code=abc",
  }),
) {
  const complete = vi.fn(completeImpl);
  const env = testEnv({
    OAUTH_PROVIDER: mockProvider({ completeAuthorization: complete }),
  });
  const res = await handleAuthorize(
    new Request("http://127.0.0.1:8787/authorize?client_id=chatgpt-client"),
    env,
    testExecutionContext(),
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  return { env, cookies: cookiesFrom(res), csrf: csrf!, complete, html };
}

describe("OAuth consent", () => {
  it("renders a token form and does not auto-approve", async () => {
    const { html } = await startConsent();
    expect(html).toMatch(/Persistent API token/i);
    expect(html).toMatch(/ChatGPT/);
    expect(html).toMatch(/chatgpt-client/);
    expect(html).toMatch(/https:\/\/chatgpt\.com\/connector\/oauth\/callback/);
    expect(html).not.toMatch(/<script/i);
  });

  it("labels an unnamed client without assuming ChatGPT", async () => {
    const env = testEnv({
      OAUTH_PROVIDER: mockProvider({
        lookupClient: async () => ({
          clientId: "chatgpt-client",
          redirectUris: [oauthReq.redirectUri],
          tokenEndpointAuthMethod: "none",
        }),
      }),
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize?client_id=chatgpt-client"),
      env,
      testExecutionContext(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/an MCP client/);
    expect(html).not.toMatch(/ChatGPT/);
    expect(html).toMatch(/chatgpt-client/);
    expect(html).toMatch(/https:\/\/chatgpt\.com\/connector\/oauth\/callback/);
  });

  it("rejects a disallowed redirect URI without storing consent", async () => {
    const env = testEnv({
      OAUTH_PROVIDER: mockProvider({
        parseAuthRequest: async () => ({
          ...oauthReq,
          redirectUri: "https://evil.example/steal",
        }),
      }),
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize?client_id=chatgpt-client"),
      env,
      testExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toMatch(/not allowed/i);
    const listed = await env.OAUTH_KV.list({ prefix: "consent:" });
    expect(listed.keys).toHaveLength(0);
  });

  it("does not redirect AuthorizationError to a disallowed URI", async () => {
    const env = testEnv({
      OAUTH_PROVIDER: mockProvider({
        parseAuthRequest: async () => {
          throw new AuthorizationError("invalid_request", {
            description: "bad request",
            redirectUri: "https://evil.example/steal",
            state: "state-1",
          });
        },
      }),
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize?client_id=chatgpt-client"),
      env,
      testExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("returns 429 when GET /authorize is rate-limited before parsing", async () => {
    let parsed = 0;
    const env = testEnv({
      OAUTH_AUTHORIZE_RATE_LIMIT: { limit: async () => ({ success: false }) },
      OAUTH_PROVIDER: mockProvider({
        parseAuthRequest: async () => {
          parsed += 1;
          return oauthReq;
        },
      }),
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize?client_id=chatgpt-client"),
      env,
      testExecutionContext(),
    );
    expect(res.status).toBe(429);
    expect(parsed).toBe(0);
  });

  it("rejects a missing CSRF token without completing authorization", async () => {
    const { env, cookies, complete } = await startConsent();
    const body = new URLSearchParams({
      decision: "approve",
      nai_token: "abcdefghijklmnop",
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize", {
        method: "POST",
        headers: { Cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      testExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a bad NovelAI token without completing authorization", async () => {
    const spy = vi
      .spyOn(account, "getSubscription")
      .mockRejectedValue(openaiError(401, "Invalid Authentication"));
    const { env, cookies, csrf, complete } = await startConsent();
    const body = new URLSearchParams({
      decision: "approve",
      csrf_token: csrf,
      nai_token: "abcdefghijklmnop",
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize", {
        method: "POST",
        headers: { Cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      testExecutionContext(),
    );
    spy.mockRestore();
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/rejected/i);
    expect(complete).not.toHaveBeenCalled();

    const ok = vi.spyOn(account, "getSubscription").mockResolvedValue({
      tier: "opus",
    });
    const retry = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize", {
        method: "POST",
        headers: { Cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          decision: "approve",
          csrf_token: csrf,
          nai_token: "abcdefghijklmnop",
        }),
      }),
      env,
      testExecutionContext(),
    );
    ok.mockRestore();
    expect(retry.status).toBe(302);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("completes authorization after a valid token check", async () => {
    const spy = vi.spyOn(account, "getSubscription").mockResolvedValue({
      tier: "opus",
    });
    const complete = vi.fn(async (opts: { props?: { naiAuth?: string } }) => {
      expect(opts.props?.naiAuth).toBe("Bearer abcdefghijklmnop");
      return { redirectTo: "https://chatgpt.com/connector/oauth/callback?code=abc" };
    }) as unknown as OAuthHelpers["completeAuthorization"];
    const { env, cookies, csrf } = await startConsent(complete);
    const body = new URLSearchParams({
      decision: "approve",
      csrf_token: csrf,
      nai_token: "abcdefghijklmnop",
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize", {
        method: "POST",
        headers: { Cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      testExecutionContext(),
    );
    spy.mockRestore();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("code=abc");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("redirects deny with access_denied and does not complete", async () => {
    const { env, cookies, csrf, complete } = await startConsent();
    const body = new URLSearchParams({
      decision: "deny",
      csrf_token: csrf,
    });
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize", {
        method: "POST",
        headers: { Cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      env,
      testExecutionContext(),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("state-1");
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an oversized authorize POST by actual body bytes", async () => {
    const { env, cookies, csrf, complete } = await startConsent();
    const res = await handleAuthorize(
      new Request("http://127.0.0.1:8787/authorize", {
        method: "POST",
        headers: { Cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
        body: `csrf_token=${csrf}&decision=approve&nai_token=${"a".repeat(70_000)}`,
      }),
      env,
      testExecutionContext(),
    );
    expect(res.status).toBe(413);
    expect(complete).not.toHaveBeenCalled();
  });
});
