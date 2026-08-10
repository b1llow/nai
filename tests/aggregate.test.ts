import { describe, expect, it } from "vitest";
import { aggregateChatStream } from "../src/sse";
import fixture from "./fixtures/xialong-stream.sse?raw";

function responseFromSse(sse: string): Response {
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("aggregateChatStream", () => {
  it("aggregates fixture SSE into chat.completion with plain text", async () => {
    const completion = await aggregateChatStream(responseFromSse(fixture), {
      id: "fallback-id",
      created: 1,
      model: "xialong-v1",
    });

    expect(completion.object).toBe("chat.completion");
    expect(completion.model).toBe("xialong-v1");
    expect(completion.id).toBe("chatcmpl-testfixture001");
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0]!.message).toEqual({
      role: "assistant",
      content: "\nHey there, friend.\n",
    });
    expect(completion.choices[0]!.finish_reason).toBe("stop");
    expect(completion.choices[0]!).not.toHaveProperty("token_ids");
    expect(completion.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    });
  });

  it("uses zero usage when no usage chunk present", async () => {
    const sse =
      'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
      'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const completion = await aggregateChatStream(responseFromSse(sse), {
      id: "c1",
      created: 42,
      model: "m",
    });
    expect(completion.choices[0]!.message.content).toBe("Hi");
    expect(completion.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});
