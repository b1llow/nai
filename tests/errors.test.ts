import { describe, expect, it, vi } from "vitest";
import {
  HttpError,
  mapNaiError,
  mapStatusToCode,
  mapStatusToType,
  openaiError,
  unhandledToResponse,
} from "../src/errors";

describe("mapNaiError", () => {
  it("maps 401 to authentication_error / invalid_api_key", () => {
    const err = mapNaiError(401, {
      statusCode: 401,
      message: "Invalid token",
    });
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.type).toBe("authentication_error");
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).toBe("Invalid token");
    expect(err.toJSON()).toEqual({
      error: {
        message: "Invalid token",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    });
  });

  it("maps 429 to rate_limit_error and passes Retry-After", () => {
    const headers = new Headers({ "retry-after": "12" });
    const err = mapNaiError(429, { message: "slow down" }, headers);
    expect(err.status).toBe(429);
    expect(err.type).toBe("rate_limit_error");
    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.headers["Retry-After"]).toBe("12");
  });

  it("maps 403 to model_not_allowed", () => {
    const err = mapNaiError(403, { message: "nope" });
    expect(err.type).toBe("invalid_request_error");
    expect(err.code).toBe("model_not_allowed");
  });

  it("maps 5xx to api_error / upstream_error", () => {
    const err = mapNaiError(502, { message: "bad gateway" });
    expect(err.type).toBe("api_error");
    expect(err.code).toBe("upstream_error");
  });

  it("maps OpenAI-shaped nested error.message", () => {
    const err = mapNaiError(400, {
      error: { message: "bad req", code: "custom" },
    });
    expect(err.message).toBe("bad req");
    expect(err.code).toBe("custom");
  });

  it("clamps non-error status to 502", () => {
    const err = mapNaiError(200, { error: { message: "boom" } });
    expect(err.status).toBe(502);
    expect(err.type).toBe("api_error");
    expect(err.message).toBe("boom");
  });

  it("accepts short plain-text bodies and rejects HTML", () => {
    const ok = mapNaiError(502, "upstream unavailable");
    expect(ok.message).toBe("upstream unavailable");

    const html = mapNaiError(502, "<html><body>bad gateway</body></html>");
    expect(html.message).toBe("The upstream server had an error");
  });

  it("uses detail/details fallbacks and top-level code", () => {
    const d = mapNaiError(400, { detail: "nope", code: "x" });
    expect(d.message).toBe("nope");
    expect(d.code).toBe("x");

    const ds = mapNaiError(400, { details: "also nope" });
    expect(ds.message).toBe("also nope");
  });

  it("defaults message when body empty", () => {
    const err = mapNaiError(401, null);
    expect(err.message).toBe("Invalid Authentication");
    expect(err.headers).toEqual({});
  });
});

describe("status helpers", () => {
  it("classifies statuses", () => {
    expect(mapStatusToType(401)).toBe("authentication_error");
    expect(mapStatusToType(429)).toBe("rate_limit_error");
    expect(mapStatusToType(500)).toBe("api_error");
    expect(mapStatusToType(400)).toBe("invalid_request_error");
    expect(mapStatusToCode(401)).toBe("invalid_api_key");
    expect(mapStatusToCode(429)).toBe("rate_limit_exceeded");
  });

  it("openaiError builds envelope", () => {
    const err = openaiError(400, "only text content is supported", {
      param: "messages",
    });
    expect(err.toJSON().error.param).toBe("messages");
  });
});

describe("unhandledToResponse", () => {
  it("passes HttpError through without leaking a different status", async () => {
    const res = unhandledToResponse(openaiError(413, "Request body too large"), "/mcp");
    expect(res.status).toBe(413);
  });

  it("maps unexpected throws to a generic 500 and logs JSON", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      if (typeof msg === "string") lines.push(msg);
    });
    try {
      const res = unhandledToResponse(new Error("secret stack"), "/mcp");
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error?: { message?: string; code?: string } };
      expect(json.error?.message).toBe("Internal Server Error");
      expect(json.error?.code).toBe("internal_error");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        message: "unhandled error",
        error: "secret stack",
        path: "/mcp",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
