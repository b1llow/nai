import type {
  ClientRegistrationCallbackOptions,
  ClientRegistrationCallbackResult,
} from "@cloudflare/workers-oauth-provider";

/**
 * Redirect URIs accepted for DCR and the consent page.
 * CIMD clients are still fetched by URL; this blocks random DCR phishing
 * clients and unknown authorize redirects.
 *
 * Grok does not perform DCR itself: register a public PKCE client once via
 * POST /oauth/register with the grok.com callback, then paste that client_id
 * into Grok's Custom Connector form (see README).
 */
export function isAllowedOAuthRedirect(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;

  const host = url.hostname.toLowerCase();
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    isLoopbackHost(host)
  ) {
    return true;
  }
  if (url.protocol !== "https:") return false;

  if (host === "chatgpt.com" || host === "chat.openai.com") {
    const path = url.pathname;
    return (
      path === "/connector/oauth" ||
      path.startsWith("/connector/oauth/") ||
      path === "/connector_platform_oauth_redirect"
    );
  }
  if (
    host === "claude.ai" ||
    host === "www.claude.ai" ||
    host === "claude.com" ||
    host === "www.claude.com"
  ) {
    return (
      url.pathname === "/api/mcp/auth_callback" ||
      url.pathname === "/api/mcp/auth_callback/"
    );
  }
  if (host === "grok.com" || host === "www.grok.com") {
    return (
      url.pathname === "/connectors-oauth-exchange-code" ||
      url.pathname === "/connectors-oauth-exchange-code/"
    );
  }
  return false;
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function redirectUrisFromMetadata(metadata: Record<string, unknown>): string[] {
  const raw = metadata.redirect_uris;
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

export function clientRegistrationCallback({
  clientMetadata,
}: ClientRegistrationCallbackOptions): ClientRegistrationCallbackResult | void {
  const uris = redirectUrisFromMetadata(clientMetadata);
  if (uris.length === 0) {
    return {
      code: "invalid_redirect_uri",
      description: "redirect_uris is required",
    };
  }
  for (const uri of uris) {
    if (!isAllowedOAuthRedirect(uri)) {
      return {
        code: "invalid_redirect_uri",
        description: "redirect_uri is not allowed for this server",
      };
    }
  }
}
