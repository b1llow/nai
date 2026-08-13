import { describe, expect, it } from "vitest";
import { sanitizeChatBody } from "../src/chat";
import { normalizeMessages } from "../src/content";
import { HttpError, mapNaiError } from "../src/errors";
import { MAX_MESSAGES, MAX_TOKENS } from "../src/limits";
import { parseSseJson, SseLimitError, stripNaiFields } from "../src/sse";
import { sanitizeTokenCountResponse } from "../src/tokenize";

describe("mapNaiError sanitization", () => {
  it("drops oversized or HTML JSON messages", () => {
    const html = mapNaiError(502, { message: "<script>alert(1)</script>" });
    expect(html.message).toBe("The upstream server had an error");

    const huge = mapNaiError(400, { message: "x".repeat(2000) });
    expect(huge.message).toBe("Request failed with status 400");
  });

  it("forwards only numeric Retry-After", () => {
    const ok = mapNaiError(429, { message: "slow down" }, new Headers({ "retry-after": "12" }));
    expect(ok.headers["Retry-After"]).toBe("12");

    const injected = mapNaiError(429, { message: "slow down" }, {
      get: () => "12\r\nSet-Cookie: a=b",
    } as unknown as Headers);
    expect(injected.headers["Retry-After"]).toBeUndefined();
  });

  it("drops non-token error codes", () => {
    const err = mapNaiError(400, { message: "nope", code: "not a code\n" });
    expect(err.code).toBeNull();
  });
});

describe("sanitizeChatBody", () => {
  it("clamps max_tokens and rejects object sampling params", () => {
    const { body } = sanitizeChatBody({
      model: "xialong-v1",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 99_999,
      temperature: 0.5,
    });
    expect(body.max_tokens).toBe(MAX_TOKENS);
    expect(body.temperature).toBe(0.5);

    expect(() =>
      sanitizeChatBody({
        model: "xialong-v1",
        messages: [{ role: "user", content: "hi" }],
        temperature: { $gt: 0 },
      }),
    ).toThrow(HttpError);
  });
});

describe("normalizeMessages limits", () => {
  it("rejects too many messages", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => ({
      role: "user",
      content: "x",
    }));
    expect(() => normalizeMessages(messages)).toThrow(/at most/i);
  });
});

describe("stripNaiFields allowlist", () => {
  it("drops unknown top-level fields", () => {
    const cleaned = stripNaiFields({
      id: "x",
      account_id: "secret",
      metadata: { foo: 1 },
      choices: [
        {
          index: 0,
          delta: { content: "Hi", token_ids: [1, 2] },
          token_ids: [1, 2],
          finish_reason: null,
        },
      ],
    });
    expect(cleaned).toEqual({
      id: "x",
      choices: [
        {
          index: 0,
          delta: { content: "Hi" },
          finish_reason: null,
        },
      ],
    });
    expect(cleaned).not.toHaveProperty("account_id");
  });
});

describe("parseSseJson limits", () => {
  it("throws when a line buffer grows without a newline", async () => {
    const huge = "data: " + "a".repeat(300_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    await expect(async () => {
      for await (const _ of parseSseJson(stream)) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(SseLimitError);
  });
});

describe("sanitizeTokenCountResponse", () => {
  it("keeps numeric counts and drops extra fields", () => {
    expect(
      sanitizeTokenCountResponse({
        token_count: 12,
        prompt: "secret",
        tokens: [1, 2, 3],
      }),
    ).toEqual({ token_count: 12 });
  });

  it("rejects payloads without a count", () => {
    expect(() => sanitizeTokenCountResponse({ prompt: "x" })).toThrow(HttpError);
  });
});
