/** Request, payload, and stream bounds for the public proxy. */

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGES = 512;
export const MAX_MESSAGE_CHARS = 512 * 1024;
export const MAX_TOTAL_CONTENT_CHARS = 1024 * 1024;
export const MAX_TOKENS = 16_384;
export const MAX_MODEL_LEN = 256;
export const MAX_USER_LEN = 256;
export const MAX_STOP_STRINGS = 8;
export const MAX_STOP_LEN = 256;
export const MAX_LOGIT_BIAS_KEYS = 256;
export const MAX_PREFIX_LEN = 8192;
export const MAX_ERROR_MESSAGE_LEN = 500;
export const MAX_ERROR_CODE_LEN = 64;
export const MAX_ERROR_BODY_BYTES = 16_384;
export const MAX_TOKEN_LEN = 4096;
export const MIN_TOKEN_LEN = 8;
export const MAX_SSE_LINE_BUFFER = 256 * 1024;
export const MAX_SSE_EVENT_CHARS = 256 * 1024;
export const MAX_SSE_STREAM_BYTES = 4 * 1024 * 1024;
export const MAX_COMPLETION_CHARS = 512 * 1024;
export const MAX_TOKENIZE_RESPONSE_BYTES = 16_384;
export const MAX_MODELS_RESPONSE_BYTES = 256_000;
export const MAX_CHAT_JSON_BYTES = 1024 * 1024;
export const RATE_LIMIT_PER_MINUTE = 120;
export const MAX_MCP_BODY_BYTES = 20 * 1024 * 1024;
export const MAX_AUTHORIZE_BODY_BYTES = 64 * 1024;
export const OAUTH_CONSENT_TTL_SECONDS = 600;
export const MAX_BINARY_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PROMPT_CHARS = 8_000;
export const MAX_IMAGE_SAMPLES = 4;
export const MAX_REFERENCE_IMAGES = 4;
export const MAX_CHARACTER_PROMPTS = 6;
export const MAX_VOICE_TEXT_CHARS = 1_000;
export const MAX_NATIVE_TEXT_CHARS = 100_000;
export const MCP_CUSTOM_DOMAIN = "nai.hoshinoaya.com";
export const MCP_PATH = "/mcp";
export const MCP_RESOURCE = `https://${MCP_CUSTOM_DOMAIN}${MCP_PATH}`;
export const MCP_ISSUER = `https://${MCP_CUSTOM_DOMAIN}`;

/** Hostnames this Worker serves `/mcp` on. Unknown hosts stay bound to `MCP_RESOURCE`. */
export function isAllowedMcpHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === MCP_CUSTOM_DOMAIN ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".workers.dev")
  );
}

/**
 * RFC 9728 resource identifier for this request. Production ChatGPT uses
 * `MCP_RESOURCE`; wrangler and `*.workers.dev` bind tokens to that origin
 * so audience checks succeed without weakening the custom-domain pin.
 */
export function mcpResourceFromRequest(request: Request): string {
  try {
    const url = new URL(request.url);
    if (isAllowedMcpHostname(url.hostname)) return `${url.origin}${MCP_PATH}`;
  } catch {
    /* ignore */
  }
  return MCP_RESOURCE;
}

export type NaiHostKind = "text" | "image" | "api";

const TEXT_HOSTS = new Set(["text.novelai.net", "api.novelai.net"]);
const IMAGE_HOSTS = new Set(["image.novelai.net"]);
const API_HOSTS = new Set(["api.novelai.net"]);

const TEXT_AI_PATHS = new Set(["/ai/generate", "/ai/generate-stream"]);
const IMAGE_PATHS = new Set([
  "/ai/generate-image",
  "/ai/augment-image",
  "/ai/encode-vibe",
  "/ai/generate-image/suggest-tags",
]);
const API_PATHS = new Set([
  "/user/subscription",
  "/user/information",
  "/ai/generate-voice",
  "/ai/upscale",
  "/ai/annotate-image",
]);

/** Truncate attacker-controlled identifiers before putting them in error strings. */
export function safeIdent(value: unknown, max = 128): string {
  if (typeof value !== "string") return "invalid";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
  return cleaned || "invalid";
}

export function sanitizeErrorText(value: string): string | null {
  const t = value.trim();
  if (!t) return null;
  if (t.length > MAX_ERROR_MESSAGE_LEN) return null;
  if (t.includes("<") || /[\r\n]/.test(t)) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return null;
  return t;
}

export function sanitizeErrorCode(value: string): string | null {
  const t = value.trim();
  if (!t || t.length > MAX_ERROR_CODE_LEN) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(t)) return null;
  return t;
}

/** Only delta-seconds Retry-After values are forwarded. */
export function sanitizeRetryAfter(value: string | null): string | null {
  if (!value) return null;
  const t = value.trim();
  if (!/^\d{1,8}$/.test(t)) return null;
  return t;
}

/** Host allowlist. Default kind is text (existing OpenAI proxy). */
export function isAllowedNaiHost(
  hostname: string,
  kind: NaiHostKind = "text",
): boolean {
  const host = hostname.toLowerCase();
  if (kind === "image") return IMAGE_HOSTS.has(host);
  if (kind === "api") return API_HOSTS.has(host);
  return TEXT_HOSTS.has(host);
}

/**
 * Path allowlist per upstream host. Query strings are ignored.
 * Rejects protocol-relative URLs, traversal, and header-smuggling bytes.
 */
export function isAllowedNaiPath(kind: NaiHostKind, path: string): boolean {
  if (typeof path !== "string" || path.length < 2 || path.length > 1024) {
    return false;
  }
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || path.includes("..") || path.includes("@")) {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const pathname = path.split("?")[0]!;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return false;
  if (kind === "text") {
    return pathname.startsWith("/oa/v1/") || TEXT_AI_PATHS.has(pathname);
  }
  if (kind === "image") return IMAGE_PATHS.has(pathname);
  return API_PATHS.has(pathname);
}
