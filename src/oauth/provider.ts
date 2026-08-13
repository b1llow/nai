import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import app from "../app";
import type { Env } from "../env";
import { MCP_PATH, mcpResourceFromRequest } from "../limits";
import { logError } from "../log";
import { handleMcp } from "../mcp/server";
import { handleAuthorize } from "./authorize";
import { OAUTH_SCOPES, resolveNaiBearer } from "./props";
import { clientRegistrationCallback } from "./redirects";

const providers = new Map<string, OAuthProvider<Env>>();

async function handleDefault(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") {
    return handleAuthorize(request, env, ctx);
  }
  return app.fetch(request, env, ctx);
}

export function createNaiOAuthProvider(resource: string): OAuthProvider<Env> {
  const issuer = new URL(resource).origin;
  return new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler: { fetch: handleMcp },
    defaultHandler: { fetch: handleDefault },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...OAUTH_SCOPES],
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    resolveExternalToken: resolveNaiBearer,
    clientRegistrationCallback,
    onError({ code, description, status }) {
      if (status >= 500) {
        logError({
          message: "oauth error",
          error: `${code}: ${description}`,
          status,
        });
      }
    },
    resourceMetadata: {
      resource,
      ...(issuer.startsWith("https:") ? { authorization_servers: [issuer] } : {}),
      resource_name: "NovelAI MCP",
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    },
  });
}

/** One provider per resource identifier so audience matches the request origin. */
export function oauthProviderFor(request: Request): OAuthProvider<Env> {
  const resource = mcpResourceFromRequest(request);
  const existing = providers.get(resource);
  if (existing) return existing;
  const created = createNaiOAuthProvider(resource);
  providers.set(resource, created);
  return created;
}
