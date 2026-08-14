import { describe, expect, it } from "vitest";
import {
  clientRegistrationCallback,
  isAllowedOAuthRedirect,
} from "../src/oauth/redirects";

describe("isAllowedOAuthRedirect", () => {
  it("allows the Grok connector callback", () => {
    expect(
      isAllowedOAuthRedirect("https://grok.com/connectors-oauth-exchange-code/"),
    ).toBe(true);
    expect(
      isAllowedOAuthRedirect("https://grok.com/connectors-oauth-exchange-code"),
    ).toBe(true);
    expect(
      isAllowedOAuthRedirect(
        "https://www.grok.com/connectors-oauth-exchange-code/",
      ),
    ).toBe(true);
    expect(isAllowedOAuthRedirect("https://grok.com/other")).toBe(false);
    expect(
      isAllowedOAuthRedirect(
        "https://grok.com.evil.example/connectors-oauth-exchange-code/",
      ),
    ).toBe(false);
  });

  it("allows ChatGPT, Claude, and loopback callbacks", () => {
    expect(
      isAllowedOAuthRedirect("https://chatgpt.com/connector/oauth/callback"),
    ).toBe(true);
    expect(
      isAllowedOAuthRedirect(
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ),
    ).toBe(true);
    expect(
      isAllowedOAuthRedirect(
        "https://chat.openai.com/connector/oauth/abc",
      ),
    ).toBe(true);
    expect(isAllowedOAuthRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(
      true,
    );
    expect(
      isAllowedOAuthRedirect("https://www.claude.ai/api/mcp/auth_callback"),
    ).toBe(true);
    expect(isAllowedOAuthRedirect("https://claude.ai/login")).toBe(false);
    expect(isAllowedOAuthRedirect("https://claude.ai/api/mcp/other")).toBe(false);
    expect(isAllowedOAuthRedirect("http://127.0.0.1:8787/callback")).toBe(true);
    expect(isAllowedOAuthRedirect("http://[::1]/callback")).toBe(true);
    expect(isAllowedOAuthRedirect("http://localhost:6274/oauth/callback")).toBe(
      true,
    );
  });

  it("rejects unknown hosts, credentials, and hashes", () => {
    expect(isAllowedOAuthRedirect("https://evil.example/steal")).toBe(false);
    expect(isAllowedOAuthRedirect("https://chatgpt.com/evil")).toBe(false);
    expect(
      isAllowedOAuthRedirect("https://chatgpt.com.evil.example/connector/oauth/x"),
    ).toBe(false);
    expect(
      isAllowedOAuthRedirect("https://user:pass@chatgpt.com/connector/oauth/x"),
    ).toBe(false);
    expect(
      isAllowedOAuthRedirect("https://chatgpt.com/connector/oauth/x#frag"),
    ).toBe(false);
  });
});

describe("clientRegistrationCallback", () => {
  it("allows Grok DCR metadata", () => {
    expect(
      clientRegistrationCallback({
        clientMetadata: {
          redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"],
        },
        request: new Request("https://nai.hoshinoaya.com/oauth/register"),
      }),
    ).toBeUndefined();
  });

  it("allows ChatGPT and Claude DCR metadata", () => {
    expect(
      clientRegistrationCallback({
        clientMetadata: {
          redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
        },
        request: new Request("https://nai.hoshinoaya.com/oauth/register"),
      }),
    ).toBeUndefined();
    expect(
      clientRegistrationCallback({
        clientMetadata: {
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        },
        request: new Request("https://nai.hoshinoaya.com/oauth/register"),
      }),
    ).toBeUndefined();
    expect(
      clientRegistrationCallback({
        clientMetadata: { redirect_uris: ["https://claude.ai/login"] },
        request: new Request("https://nai.hoshinoaya.com/oauth/register"),
      }),
    ).toMatchObject({ code: "invalid_redirect_uri" });
  });

  it("rejects a missing or disallowed redirect_uri", () => {
    expect(
      clientRegistrationCallback({
        clientMetadata: {},
        request: new Request("https://nai.hoshinoaya.com/oauth/register"),
      }),
    ).toMatchObject({ code: "invalid_redirect_uri" });
    expect(
      clientRegistrationCallback({
        clientMetadata: { redirect_uris: ["https://evil.example/steal"] },
        request: new Request("https://nai.hoshinoaya.com/oauth/register"),
      }),
    ).toMatchObject({ code: "invalid_redirect_uri" });
  });
});
