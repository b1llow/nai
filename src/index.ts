import type { Env } from "./env";
import { unhandledToResponse } from "./errors";
import { requestPath } from "./log";
import { createNaiOAuthProvider } from "./oauth/provider";

const oauth = createNaiOAuthProvider();

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await oauth.fetch(request, env, ctx);
    } catch (err) {
      return unhandledToResponse(err, requestPath(request));
    }
  },
} satisfies ExportedHandler<Env>;
