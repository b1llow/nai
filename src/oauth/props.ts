import type { ResolveExternalTokenInput } from "@cloudflare/workers-oauth-provider";
import { parseAuthorization, resolveMcpAuthorization } from "../auth";
import type { Env } from "../env";
import { MCP_RESOURCE } from "../limits";

export const OAUTH_SCOPES = ["mcp", "offline_access"] as const;

export type NaiAuthProps = {
  naiAuth: string;
};

export function naiAuthFromProps(props: unknown): string | null {
  if (!props || typeof props !== "object") return null;
  const naiAuth = (props as { naiAuth?: unknown }).naiAuth;
  if (typeof naiAuth !== "string") return null;
  try {
    return parseAuthorization(naiAuth);
  } catch {
    return null;
  }
}

/**
 * After OAuthProvider has set `ctx.props`, never treat the inbound Bearer as a
 * NovelAI token — it may be an expired library access token.
 * Direct `handleMcp` tests still pass a header with empty props.
 */
export function resolveMcpToolAuth(
  props: unknown,
  header: string | undefined,
): string | null {
  if (props && typeof props === "object" && "naiAuth" in props) {
    return naiAuthFromProps(props);
  }
  return resolveMcpAuthorization(header);
}

/** Grant `mcp` plus any advertised scopes the client actually requested. */
export function grantedScopes(requested: string[]): string[] {
  const allowed = new Set<string>(OAUTH_SCOPES);
  const granted = requested.filter((scope) => allowed.has(scope));
  if (!granted.includes("mcp")) granted.unshift("mcp");
  return granted;
}

/**
 * workers-oauth-provider opaque tokens are `userId:grantId:secret`.
 * This Worker always issues `userId` as `nai-<sha256 hex>`.
 */
export function isInternalOAuthAccessToken(token: string): boolean {
  const parts = token.split(":");
  return parts.length === 3 && parts[0]!.startsWith("nai-");
}

/**
 * Compatibility path for Cursor / mcp-remote `--header Authorization`.
 * Format-check only; tools fail later if NovelAI rejects the token.
 */
export async function resolveNaiBearer({
  token,
}: ResolveExternalTokenInput<Env>): Promise<{
  props: NaiAuthProps;
  audience: string;
} | null> {
  if (isInternalOAuthAccessToken(token)) return null;
  try {
    return {
      props: { naiAuth: parseAuthorization(`Bearer ${token}`) },
      audience: MCP_RESOURCE,
    };
  } catch {
    return null;
  }
}

/**
 * Stable grant owner id. Must not contain `:`; the provider uses that as an
 * opaque-token separator.
 */
export async function naiUserId(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawToken),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `nai-${hex}`;
}
