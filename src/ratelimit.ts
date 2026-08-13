import type { Env } from "./env";
import { HttpError, openaiError } from "./errors";

/**
 * Per-IP Cloudflare rate limit. Missing/failing bindings fail open so an
 * outage is not a 500.
 */
export async function enforceIpRateLimit(
  env: Env,
  request: Request,
): Promise<void> {
  const limiter = env.API_RATE_LIMIT;
  if (!limiter) return;
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown";
  try {
    const { success } = await limiter.limit({ key: ip });
    if (!success) {
      throw openaiError(429, "Rate limit exceeded", {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        headers: { "Retry-After": "60" },
      });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
}
