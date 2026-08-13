import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
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
    expect(html).not.toMatch(/<script/i);
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
});
