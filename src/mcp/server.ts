import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../env";
import { resolveMcpAuthorization } from "../auth";
import { HttpError, httpErrorToResponse, openaiError } from "../errors";
import { MAX_MCP_BODY_BYTES, MCP_CUSTOM_DOMAIN } from "../limits";
import { enforceIpRateLimit } from "../ratelimit";
import { registerNaiTools } from "./tools";

export function createNaiMcpServer(env: Env, auth: string | null): McpServer {
  const server = new McpServer({
    name: "novelai",
    version: "1.0.0",
  });
  registerNaiTools(server, env, auth);
  return server;
}

function mcpAllowedHostnames(request: Request): string[] {
  const hosts = new Set(["localhost", "127.0.0.1", MCP_CUSTOM_DOMAIN]);
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    if (
      hostname === MCP_CUSTOM_DOMAIN ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".workers.dev")
    ) {
      hosts.add(hostname);
    }
  } catch {
    /* ignore */
  }
  return [...hosts];
}

export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "OPTIONS") {
    try {
      await enforceIpRateLimit(env, request);
    } catch (err) {
      if (err instanceof HttpError) return httpErrorToResponse(err);
      throw err;
    }
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_MCP_BODY_BYTES) {
      return httpErrorToResponse(
        openaiError(413, "Request body too large", {
          type: "invalid_request_error",
        }),
      );
    }
  }

  let auth: string | null = null;
  try {
    auth = resolveMcpAuthorization(
      request.headers.get("Authorization") ?? undefined,
      env.NAI_ACCESS_TOKEN,
    );
  } catch (err) {
    if (err instanceof HttpError) return httpErrorToResponse(err);
    throw err;
  }

  const response = await createMcpHandler(() => createNaiMcpServer(env, auth), {
    route: "/mcp",
    allowedHostnames: mcpAllowedHostnames(request),
    corsOptions: {
      origin: "*",
      methods: "GET, POST, OPTIONS",
      headers:
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, mcp-session-id",
    },
  })(request, env, ctx);

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
