import { describe, expect, it } from "vitest";
import { limitRequestBody } from "../src/body-limit";
import { HttpError } from "../src/errors";

function streamRequest(
  bytes: Uint8Array,
  headers: HeadersInit = { "content-type": "application/json" },
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Request("https://nai.hoshinoaya.com/mcp", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

describe("limitRequestBody", () => {
  it("rejects oversized Content-Length without reading the body", async () => {
    const req = new Request("https://nai.hoshinoaya.com/mcp", {
      method: "POST",
      headers: {
        "content-length": "100",
        "content-type": "application/json",
      },
      body: "{}",
    });
    await expect(limitRequestBody(req, 8)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects a streamed body over the cap when Content-Length is absent", async () => {
    const req = streamRequest(new TextEncoder().encode("abcdefghij"));
    expect(req.headers.get("content-length")).toBeNull();
    try {
      await limitRequestBody(req, 8);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(413);
    }
  });

  it("rejects an understated Content-Length when the stream is larger", async () => {
    const req = streamRequest(new TextEncoder().encode("x".repeat(32)), {
      "content-type": "application/json",
      "content-length": "8",
    });
    try {
      await limitRequestBody(req, 16);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(413);
    }
  });

  it("passes through a streamed body at or under the cap", async () => {
    const payload = '{"ok":true}';
    const req = streamRequest(new TextEncoder().encode(payload));
    const limited = await limitRequestBody(req, 64);
    expect(await limited.text()).toBe(payload);
    expect(limited.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(payload).byteLength),
    );
  });

  it("does not consume GET bodies", async () => {
    const req = new Request("https://nai.hoshinoaya.com/mcp");
    const limited = await limitRequestBody(req, 8);
    expect(limited).toBe(req);
  });
});
