import { openaiError } from "./errors";
import { readStreamCapped } from "./upstream";

const SKIP_BODY_LIMIT = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cap an inbound request by actual body bytes, not just Content-Length.
 * Missing or understated Content-Length cannot bypass the limit.
 */
export async function limitRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Request> {
  if (SKIP_BODY_LIMIT.has(request.method)) return request;

  const lenHdr = request.headers.get("content-length");
  if (lenHdr !== null && lenHdr !== "") {
    const len = Number(lenHdr);
    if (Number.isFinite(len) && len > maxBytes) {
      throw openaiError(413, "Request body too large", {
        type: "invalid_request_error",
      });
    }
  }

  if (!request.body) return request;

  const { bytes, truncated } = await readStreamCapped(request.body, maxBytes);
  if (truncated) {
    throw openaiError(413, "Request body too large", {
      type: "invalid_request_error",
    });
  }

  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes.byteLength));
  return new Request(request, { body: bytes, headers });
}
