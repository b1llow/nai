import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../env";
import { limitRequestBody } from "../body-limit";
import { unhandledToResponse } from "../errors";
import {
  MAX_MCP_BODY_BYTES,
  MCP_CUSTOM_DOMAIN,
  MCP_PATH,
  isAllowedMcpHostname,
} from "../limits";
import { resolveMcpToolAuth } from "../oauth/props";
import { enforceIpRateLimit } from "../ratelimit";
import { IMAGE_WIDGET_RENDER_TOOL } from "./image-widget";
import { registerNaiTools } from "./tools";

export const MCP_SERVER_INSTRUCTIONS =
  `After nai_generate_image, nai_upscale, or nai_director returns an image_id, call ${IMAGE_WIDGET_RENDER_TOOL} with that image_id (or image_ids) so ChatGPT mounts the image preview UI. If image_id is null, that result already binds the preview — do not call ${IMAGE_WIDGET_RENDER_TOOL}. Do not open ui:// URIs. nai_get_image only reloads bytes.`;

export function createNaiMcpServer(env: Env, auth: string | null): McpServer {
  const server = new McpServer(
    { name: "novelai", version: "1.0.0" },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  registerNaiTools(server, env, auth);
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

    const response = await createMcpHandler(() => createNaiMcpServer(env, auth), {
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
