import type { Env } from "./env";
import { resolveNaiOrigin } from "./env";
import { mapNaiError, openaiError } from "./errors";
import {
  MAX_ERROR_BODY_BYTES,
  isAllowedNaiPath,
  type NaiHostKind,
} from "./limits";

export const NAI_OA = {
  models: "/oa/v1/models",
  chat: "/oa/v1/chat/completions",
  completions: "/oa/v1/completions",
  tokenCount: "/oa/v1/internal/token-count",
} as const;

export const NAI_ACCEPT_JSON = "application/json";
export const NAI_ACCEPT_SSE = "text/event-stream";
export const NAI_ACCEPT_BINARY =
  "application/x-zip-compressed, application/zip, application/octet-stream, image/png, audio/mpeg, audio/webm, application/json";

function correlationId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export async function readBytesCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - size;
      if (remaining <= 0) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        size += remaining;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: merged, truncated };
}

export async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readBytesCapped(res, maxBytes);
  return { text: new TextDecoder().decode(bytes), truncated };
}

export type NaiFetchInit = {
  method?: string;
  auth: string;
  body?: unknown;
  signal?: AbortSignal;
  stream?: boolean;
  host?: NaiHostKind;
  accept?: string;
};

export async function naiFetch(
  env: Env,
  path: string,
  init: NaiFetchInit,
): Promise<Response> {
  const host: NaiHostKind = init.host ?? "text";
  if (!isAllowedNaiPath(host, path)) {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  const base = resolveNaiOrigin(env, host);
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    Authorization: init.auth,
    Accept:
      init.accept ??
      (init.stream ? NAI_ACCEPT_SSE : NAI_ACCEPT_JSON),
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
    const { text } = await readBodyCapped(res, MAX_ERROR_BODY_BYTES);
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
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

export async function naiFetchBinary(
  env: Env,
  path: string,
  init: NaiFetchInit,
  maxBytes: number,
): Promise<Uint8Array> {
  const res = await naiFetch(env, path, {
    ...init,
    accept: init.accept ?? NAI_ACCEPT_BINARY,
  });
  if (!res.ok) await throwMappedUpstreamError(res);
  const { bytes, truncated } = await readBytesCapped(res, maxBytes);
  if (truncated) {
    throw openaiError(502, "upstream response too large", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  return bytes;
}

export async function naiFetchJson(
  env: Env,
  path: string,
  init: NaiFetchInit,
  maxBytes: number,
): Promise<unknown> {
  const res = await naiFetch(env, path, init);
  if (!res.ok) await throwMappedUpstreamError(res);
  const { text, truncated } = await readBodyCapped(res, maxBytes);
  if (truncated) {
    throw openaiError(502, "upstream response too large", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw openaiError(502, "unexpected upstream JSON", {
      type: "api_error",
      code: "upstream_error",
    });
  }
}
