import type { ResolveExternalTokenInput } from "@cloudflare/workers-oauth-provider";
import { parseAuthorization } from "../auth";
import type { Env } from "../env";

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

/** Grant `mcp` plus any advertised scopes the client actually requested. */
export function grantedScopes(requested: string[]): string[] {
  const allowed = new Set<string>(OAUTH_SCOPES);
  const granted = requested.filter((scope) => allowed.has(scope));
  if (!granted.includes("mcp")) granted.unshift("mcp");
  return granted;
}

/**
 * Compatibility path for Cursor / mcp-remote `--header Authorization`.
 * Format-check only; tools fail later if NovelAI rejects the token.
 */
export async function resolveNaiBearer({
  token,
}: ResolveExternalTokenInput<Env>): Promise<{ props: NaiAuthProps } | null> {
  try {
    return { props: { naiAuth: parseAuthorization(`Bearer ${token}`) } };
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
