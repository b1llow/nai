import type { Env } from "./env";
import { unhandledToResponse } from "./errors";
import { requestPath } from "./log";
import { oauthProviderFor } from "./oauth/provider";
import { enforceIpRateLimit } from "./ratelimit";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/oauth/register") {
        await enforceIpRateLimit(env, request, env.OAUTH_REGISTER_RATE_LIMIT);
      }
      return await oauthProviderFor(request).fetch(request, env, ctx);
    } catch (err) {
      return unhandledToResponse(err, requestPath(request));
    }
  },
} satisfies ExportedHandler<Env>;
