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
 * MCP auth: per-request Bearer only (same as `/v1`).
 * A missing header means tools return `mcpNeedAuth`; a malformed header is 401.
 * Do not fall back to a Worker secret — this Worker is publicly reachable.
 */
export function resolveMcpAuthorization(
  header: string | undefined,
): string | null {
  const raw = (header ?? "").trim();
  if (!raw) return null;
  return parseAuthorization(header);
}
