import {
  sanitizeErrorCode,
  sanitizeErrorText,
  sanitizeRetryAfter,
} from "./limits";

export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "api_error";

export type OpenAIErrorBody = {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: string | null;
  };
};

export class HttpError extends Error {
  readonly status: number;
  readonly type: OpenAIErrorType;
  readonly param: string | null;
  readonly code: string | null;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    opts: {
      type?: OpenAIErrorType;
      param?: string | null;
      code?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = opts.type ?? mapStatusToType(status);
    this.param = opts.param ?? null;
    this.code = opts.code ?? null;
    this.headers = opts.headers ?? {};
  }

  toJSON(): OpenAIErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }
}

export function mapStatusToType(status: number): OpenAIErrorType {
  if (status === 401) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

export function mapStatusToCode(status: number): string | null {
  if (status === 401) return "invalid_api_key";
  if (status === 403) return "model_not_allowed";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "upstream_error";
  return null;
}

/** Map NAI utils.JsonError / HTTP status into OpenAI envelope. */
export function mapNaiError(
  status: number,
  body: unknown,
  headers?: Headers,
): HttpError {
  // Callers sometimes pass a 2xx status when an error payload arrived
  // mislabeled as success; never emit an HTTP 2xx error envelope.
  const effectiveStatus = status >= 400 ? status : 502;
  const msg = extractMessage(body) || defaultMessage(effectiveStatus);
  const codeFromBody = extractCode(body);
  const hdrs: Record<string, string> = {};
  const retryAfter = sanitizeRetryAfter(headers?.get("retry-after") ?? null);
  if (retryAfter) hdrs["Retry-After"] = retryAfter;

  return new HttpError(effectiveStatus, msg, {
    type: mapStatusToType(effectiveStatus),
    code: codeFromBody ?? mapStatusToCode(effectiveStatus),
    headers: hdrs,
  });
}

export function openaiError(
  status: number,
  message: string,
  opts: {
    type?: OpenAIErrorType;
    param?: string | null;
    code?: string | null;
    headers?: Record<string, string>;
  } = {},
): HttpError {
  return new HttpError(status, message, {
    type: opts.type ?? mapStatusToType(status),
    param: opts.param ?? null,
    code: opts.code ?? mapStatusToCode(status),
    headers: opts.headers,
  });
}

export function httpErrorToResponse(err: HttpError): Response {
  return new Response(JSON.stringify(err.toJSON()), {
    status: err.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...err.headers,
    },
  });
}

function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    if (typeof body === "string" && body.trim()) {
      return sanitizeErrorText(body);
    }
    return null;
  }
  const o = body as Record<string, unknown>;
  if (typeof o.message === "string" && o.message) {
    return sanitizeErrorText(o.message);
  }
  if (o.error && typeof o.error === "object") {
    const e = o.error as Record<string, unknown>;
    if (typeof e.message === "string" && e.message) {
      return sanitizeErrorText(e.message);
    }
  }
  if (typeof o.detail === "string" && o.detail) {
    return sanitizeErrorText(o.detail);
  }
  if (typeof o.details === "string" && o.details) {
    return sanitizeErrorText(o.details);
  }
  return null;
}

function extractCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.code === "string") return sanitizeErrorCode(o.code);
  if (o.error && typeof o.error === "object") {
    const e = o.error as Record<string, unknown>;
    if (typeof e.code === "string") return sanitizeErrorCode(e.code);
  }
  return null;
}

function defaultMessage(status: number): string {
  if (status === 401) return "Invalid Authentication";
  if (status === 403) return "Model not allowed";
  if (status === 429) return "Rate limit exceeded";
  if (status >= 500) return "The upstream server had an error";
  return `Request failed with status ${status}`;
}
