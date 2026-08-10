import type { Env } from "./env";
import { mapNaiError, openaiError } from "./errors";

export const NAI_OA = {
  models: "/oa/v1/models",
  chat: "/oa/v1/chat/completions",
  completions: "/oa/v1/completions",
  tokenCount: "/oa/v1/internal/token-count",
} as const;

function correlationId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export async function naiFetch(
  env: Env,
  path: string,
  init: {
    method?: string;
    auth: string;
    body?: unknown;
    signal?: AbortSignal;
    stream?: boolean;
  },
): Promise<Response> {
  const base = env.NAI_BASE_URL.replace(/\/$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: init.auth,
    Accept: init.stream ? "text/event-stream" : "application/json",
    "x-correlation-id": correlationId(),
  };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw openaiError(502, "Failed to reach NovelAI upstream", {
      type: "api_error",
      code: "upstream_error",
    });
  }

  return res;
}

/** Read upstream error body and throw mapped HttpError. */
export async function throwMappedUpstreamError(res: Response): Promise<never> {
  let body: unknown = null;
  const ct = res.headers.get("content-type") ?? "";
  try {
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // Upstream sometimes returns SSE-shaped or plain text errors
        const trimmed = text.trim();
        if (trimmed.startsWith("{")) {
          try {
            body = JSON.parse(trimmed.split("\n")[0]!.replace(/^data:\s*/, ""));
          } catch {
            body = text;
          }
        } else if (ct.includes("text/event-stream") && trimmed.startsWith("data:")) {
          const first = trimmed.split("\n").find((l) => l.startsWith("data:"));
          if (first) {
            const payload = first.slice(5).trim();
            try {
              body = JSON.parse(payload);
            } catch {
              body = text;
            }
          } else {
            body = text;
          }
        } else {
          body = text;
        }
      }
    }
  } catch {
    body = null;
  }
  throw mapNaiError(res.status, body, res.headers);
}
