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
export const RATE_LIMIT_PER_MINUTE = 120;

const ALLOWED_NAI_HOSTS = new Set(["text.novelai.net", "api.novelai.net"]);

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

export function isAllowedNaiHost(hostname: string): boolean {
  return ALLOWED_NAI_HOSTS.has(hostname.toLowerCase());
}
