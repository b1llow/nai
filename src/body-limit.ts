import { openaiError } from "./errors";
import { readBytesCapped } from "./upstream";

const SKIP_BODY_LIMIT = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cap an incoming request body. `Content-Length` is a fast-path reject;
 * the body is also counted so chunked uploads cannot skip the limit.
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

  const { bytes, truncated } = await readBytesCapped(
    new Response(request.body),
    maxBytes,
  );
  if (truncated) {
    throw openaiError(413, "Request body too large", {
      type: "invalid_request_error",
    });
  }

  return new Request(request, { body: bytes });
}
