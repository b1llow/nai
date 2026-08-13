import { openaiError } from "./errors";
import { MAX_TOKEN_LEN, MIN_TOKEN_LEN } from "./limits";

/**
 * Require a well-formed Bearer token: visible ASCII, bounded length, no
 * trailing junk that could smuggle headers.
 */
export function parseAuthorization(header: string | undefined): string {
  const raw = (header ?? "").trim();
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  if (!match) {
    throw openaiError(401, "Missing or invalid Authorization header", {
      type: "authentication_error",
      code: "invalid_api_key",
    });
  }
  const token = match[1]!;
  if (token.length < MIN_TOKEN_LEN || token.length > MAX_TOKEN_LEN) {
    throw openaiError(401, "Missing or invalid Authorization header", {
      type: "authentication_error",
      code: "invalid_api_key",
    });
  }
  // Printable ASCII except space / DEL — rejects CR/LF and non-ASCII.
  if (/[^\x21-\x7E]/.test(token)) {
    throw openaiError(401, "Missing or invalid Authorization header", {
      type: "authentication_error",
      code: "invalid_api_key",
    });
  }
  return `Bearer ${token}`;
}

/**
 * MCP auth: request Bearer header wins; otherwise the optional Worker secret.
 * A present but malformed header is rejected. A malformed secret is a
 * server misconfiguration (do not fall through).
 */
export function resolveMcpAuthorization(
  header: string | undefined,
  secret: string | undefined,
): string | null {
  const raw = (header ?? "").trim();
  if (raw) return parseAuthorization(header);
  const token = (secret ?? "").trim();
  if (!token) return null;
  try {
    return parseAuthorization(`Bearer ${token}`);
  } catch {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
}
