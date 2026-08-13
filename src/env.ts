import { openaiError } from "./errors";
import { isAllowedNaiHost } from "./limits";

/**
 * Bindings from `wrangler types` (`Cloudflare.Env`), plus the local-only
 * unsafe-URL flag which is set via `.dev.vars` and is not in production vars.
 *
 * `API_RATE_LIMIT` is optional at the type level because the Worker fail-opens
 * when the binding is missing (tests and platform outages).
 */
export type Env = Omit<Cloudflare.Env, "API_RATE_LIMIT"> & {
  NAI_ALLOW_UNSAFE_BASE_URL?: string;
  API_RATE_LIMIT?: Cloudflare.Env["API_RATE_LIMIT"];
};

export type NaiUrlEnv = Pick<Env, "NAI_BASE_URL" | "NAI_ALLOW_UNSAFE_BASE_URL">;

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
export function resolveNaiBaseUrl(env: NaiUrlEnv): string {
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
