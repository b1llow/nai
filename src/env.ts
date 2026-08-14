import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { openaiError } from "./errors";
import { isAllowedNaiHost, type NaiHostKind } from "./limits";

/**
 * Bindings from `wrangler types` (`Cloudflare.Env`), plus the local-only
 * unsafe-URL flag which is set via `.dev.vars` and is not in production vars.
 *
 * Rate-limit bindings are optional at the type level because the Worker
 * fail-opens when a binding is missing (tests and platform outages).
 *
 * `OAUTH_PROVIDER` is injected at runtime by `@cloudflare/workers-oauth-provider`.
 */
type RateLimitBinding =
  | "API_RATE_LIMIT"
  | "OAUTH_AUTHORIZE_RATE_LIMIT"
  | "OAUTH_REGISTER_RATE_LIMIT";

export type Env = Omit<Cloudflare.Env, RateLimitBinding> & {
  NAI_ALLOW_UNSAFE_BASE_URL?: string;
  /** Set at deploy by `npm run deploy` (`wrangler deploy --var GIT_SHA:<sha>`). */
  GIT_SHA?: string;
  API_RATE_LIMIT?: RateLimit;
  OAUTH_AUTHORIZE_RATE_LIMIT?: RateLimit;
  OAUTH_REGISTER_RATE_LIMIT?: RateLimit;
  OAUTH_PROVIDER?: OAuthHelpers;
};

export type NaiUrlEnv = Pick<Env, "NAI_BASE_URL" | "NAI_ALLOW_UNSAFE_BASE_URL"> & {
  NAI_IMAGE_BASE_URL?: string;
  NAI_API_BASE_URL?: string;
};

const DEFAULT_ORIGINS: Record<NaiHostKind, string> = {
  text: "https://text.novelai.net",
  image: "https://image.novelai.net",
  api: "https://api.novelai.net",
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

function rawOrigin(env: NaiUrlEnv, kind: NaiHostKind): string {
  if (kind === "image") {
    return env.NAI_IMAGE_BASE_URL?.trim() || DEFAULT_ORIGINS.image;
  }
  if (kind === "api") {
    return env.NAI_API_BASE_URL?.trim() || DEFAULT_ORIGINS.api;
  }
  return env.NAI_BASE_URL;
}

function resolveOrigin(raw: string, env: NaiUrlEnv, kind: NaiHostKind): string {
  const url = parseBase(raw);
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
  if (!isAllowedNaiHost(url.hostname, kind)) {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  return url.origin;
}

/**
 * Resolve an upstream origin. Production only allows the NovelAI hosts for
 * the requested kind so a bad binding cannot exfiltrate Bearer tokens.
 */
export function resolveNaiOrigin(
  env: NaiUrlEnv,
  kind: NaiHostKind = "text",
): string {
  return resolveOrigin(rawOrigin(env, kind), env, kind);
}

/**
 * Resolve the text API origin (existing OpenAI proxy). Production allows
 * https://text.novelai.net and https://api.novelai.net.
 */
export function resolveNaiBaseUrl(env: NaiUrlEnv): string {
  return resolveNaiOrigin(env, "text");
}
