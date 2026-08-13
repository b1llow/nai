import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import app from "../app";
import type { Env } from "../env";
import { logError } from "../log";
import { handleMcp } from "../mcp/server";
import { handleAuthorize } from "./authorize";
import { OAUTH_SCOPES, resolveNaiBearer } from "./props";

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

export function createNaiOAuthProvider(): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: handleMcp },
    defaultHandler: { fetch: handleDefault },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [...OAUTH_SCOPES],
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    resolveExternalToken: resolveNaiBearer,
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
      resource_name: "NovelAI MCP",
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    },
  });
}
