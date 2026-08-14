import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../env";
import { limitRequestBody } from "../body-limit";
import { unhandledToResponse } from "../errors";
import {
  MAX_MCP_BODY_BYTES,
  MCP_CUSTOM_DOMAIN,
  MCP_ISSUER,
  MCP_PATH,
  isAllowedMcpHostname,
  mcpOriginFromRequest,
} from "../limits";
import { resolveMcpToolAuth } from "../oauth/props";
import { enforceIpRateLimit } from "../ratelimit";
import { registerNaiTools } from "./tools";

export function createNaiMcpServer(
  env: Env,
  auth: string | null,
  origin: string = MCP_ISSUER,
): McpServer {
  const server = new McpServer({
    name: "novelai",
    version: "1.0.0",
  });
  registerNaiTools(server, env, auth, origin);
  return server;
}

function mcpAllowedHostnames(request: Request): string[] {
  const hosts = new Set(["localhost", "127.0.0.1", MCP_CUSTOM_DOMAIN]);
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    if (isAllowedMcpHostname(hostname)) hosts.add(hostname);
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
  try {
    let inbound = request;
    if (inbound.method !== "OPTIONS") {
      await enforceIpRateLimit(env, inbound);
      inbound = await limitRequestBody(inbound, MAX_MCP_BODY_BYTES);
    }

    const auth = resolveMcpToolAuth(
      ctx.props,
      inbound.headers.get("Authorization") ?? undefined,
    );

    const origin = mcpOriginFromRequest(inbound);
    const response = await createMcpHandler(() => createNaiMcpServer(env, auth, origin), {
      route: MCP_PATH,
      allowedHostnames: mcpAllowedHostnames(inbound),
      corsOptions: {
        origin: "*",
        methods: "GET, POST, OPTIONS",
        headers:
          "Authorization, Content-Type, Accept, MCP-Protocol-Version, mcp-session-id",
      },
    })(inbound, env, ctx);

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (err) {
    return unhandledToResponse(err, "/mcp");
  }
}
