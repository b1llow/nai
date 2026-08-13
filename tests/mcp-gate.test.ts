import { describe, expect, it } from "vitest";
import { MAX_MCP_BODY_BYTES } from "../src/limits";
import { handleMcp } from "../src/mcp/server";
import { testEnv, testExecutionContext } from "./helpers";

const env = testEnv();
const ctx = testExecutionContext();

describe("MCP HTTP gates", () => {
  it("rejects oversized Content-Length before the MCP handler", async () => {
    const res = await handleMcp(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: {
          "content-length": String(MAX_MCP_BODY_BYTES + 1),
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
  });

  it("rejects a malformed Authorization header with 401", async () => {
    const res = await handleMcp(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer x",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("does not treat a malformed OAuth naiAuth prop as the inbound Bearer", async () => {
    const res = await handleMcp(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer x",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
      testExecutionContext({ naiAuth: "Bearer x" }),
    );
    expect(res.status).not.toBe(401);
  });

  it("rejects an oversized streamed body without Content-Length", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(120);
    let sent = 0;
    const total = MAX_MCP_BODY_BYTES + 1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const n = Math.min(chunk.byteLength, total - sent);
        controller.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
        sent += n;
      },
    });
    const res = await handleMcp(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
  });

  it("returns 429 when the limiter denies", async () => {
    const res = await handleMcp(
      new Request("https://nai.hoshinoaya.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: "{}",
      }),
      testEnv({
        API_RATE_LIMIT: { limit: async () => ({ success: false }) },
      }),
      ctx,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
