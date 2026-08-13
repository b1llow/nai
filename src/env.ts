import { openaiError } from "./errors";
import { isAllowedNaiHost } from "./limits";

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type Env = {
  /** Required wrangler var (see wrangler.jsonc vars). */
  NAI_BASE_URL: string;
  /**
   * When "1" or "true", skip the NovelAI host allowlist (local mocks only).
   * Still requires http(s) and rejects embedded credentials.
   */
  NAI_ALLOW_UNSAFE_BASE_URL?: string;
  /** Optional Cloudflare Rate Limiting binding. */
  API_RATE_LIMIT?: RateLimitBinding;
};

function parseBase(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
}

/**
 * Resolve the upstream origin. Production only allows https://text.novelai.net
 * and https://api.novelai.net so a bad binding cannot exfiltrate Bearer tokens.
 */
export function resolveNaiBaseUrl(env: Env): string {
  const url = parseBase(env.NAI_BASE_URL);
  if (url.username || url.password) {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }

  const unsafe =
    env.NAI_ALLOW_UNSAFE_BASE_URL === "1" ||
    env.NAI_ALLOW_UNSAFE_BASE_URL === "true";

  if (unsafe) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw openaiError(500, "Server misconfigured", {
        type: "api_error",
        code: "internal_error",
      });
    }
    return url.origin;
  }

  if (url.protocol !== "https:") {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  if (url.port && url.port !== "443") {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  if (!isAllowedNaiHost(url.hostname)) {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  return url.origin;
}
