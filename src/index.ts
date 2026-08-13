import type { Env } from "./env";
import app from "./app";
import { unhandledToResponse } from "./errors";
import { requestPath } from "./log";
import { handleMcp } from "./mcp/server";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/mcp") {
        return await handleMcp(request, env, ctx);
      }
      return await app.fetch(request, env, ctx);
    } catch (err) {
      return unhandledToResponse(err, requestPath(request));
    }
  },
} satisfies ExportedHandler<Env>;
