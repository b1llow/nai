import { describe, expect, it } from "vitest";
import {
  buildResponseObject,
  responsesInputToMessages,
  streamResponsesFromChat,
  streamResponsesFromText,
} from "../src/responses";
import { parseSseJson } from "../src/sse";
import { HttpError } from "../src/errors";
import fixture from "./fixtures/xialong-stream.sse?raw";

describe("responsesInputToMessages", () => {
  it("maps string input + instructions to messages", () => {
    const parsed = responsesInputToMessages({
      model: "xialong-v1",
      input: "Hello",
      instructions: "Be brief",
      max_output_tokens: 32,
      temperature: 0.5,
    });
    expect(parsed.model).toBe("xialong-v1");
    expect(parsed.messages).toEqual([
      { role: "system", content: "Be brief" },
      { role: "user", content: "Hello" },
    ]);
    expect(parsed.max_tokens).toBe(32);
    expect(parsed.temperature).toBe(0.5);
    expect(parsed.stream).toBe(false);
  });

  it("maps array input with developer role rewrite", () => {
    const parsed = responsesInputToMessages({
      model: "glm-4-6",
      input: [
        { type: "message", role: "developer", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      stream: true,
    });
    expect(parsed.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(parsed.stream).toBe(true);
  });

  it("rejects tools and empty input", () => {
    expect(() =>
      responsesInputToMessages({
        model: "xialong-v1",
        input: "x",
        tools: [{ type: "function" }],
      }),
    ).toThrow(HttpError);

    expect(() =>
      responsesInputToMessages({
        model: "xialong-v1",
        instructions: "only system",
      }),
    ).toThrow(/input/i);
  });

  it("rejects unsupported input item types", () => {
    expect(() =>
      responsesInputToMessages({
        model: "xialong-v1",
        input: [{ type: "item_reference", id: "msg_1" }],
      }),
    ).toThrow(/unsupported input item type/i);

    expect(() =>
      responsesInputToMessages({
        model: "xialong-v1",
        input: [{ type: "reasoning", content: "think" }],
      }),
    ).toThrow(HttpError);
  });

  it("rejects json_object text format", () => {
    expect(() =>
      responsesInputToMessages({
        model: "xialong-v1",
        input: "hi",
        text: { format: { type: "json_object" } },
      }),
    ).toThrow(/json_object/i);
  });
});

describe("responses stream helpers", () => {
  it("streamResponsesFromChat emits contiguous lifecycle events", async () => {
    const upstream = new Response(fixture, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const res = streamResponsesFromChat({
      upstream,
      responseId: "resp_test",
      messageId: "msg_test",
      created_at: 1735689600,
      model: "xialong-v1",
    });
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);

    const events: Array<{ type: string; sequence_number: number }> = [];
    for await (const obj of parseSseJson(res.body!)) {
      const rec = obj as Record<string, unknown>;
      events.push({
        type: String(rec.type),
        sequence_number: Number(rec.sequence_number),
      });
    }

    expect(events.map((e) => e.sequence_number)).toEqual(
      events.map((_, i) => i),
    );
    expect(events[0]!.type).toBe("response.created");
    expect(events.some((e) => e.type === "response.output_text.delta")).toBe(
      true,
    );
    expect(events[events.length - 1]!.type).toBe("response.completed");

    const upstream2 = new Response(fixture, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const res2 = streamResponsesFromChat({
      upstream: upstream2,
      responseId: "resp_test2",
      messageId: "msg_test2",
      created_at: 1735689600,
      model: "xialong-v1",
    });
    let completedText = "";
    let completedUsage: Record<string, unknown> | null = null;
    for await (const obj of parseSseJson(res2.body!)) {
      const rec = obj as Record<string, unknown>;
      if (rec.type === "response.completed") {
        const response = rec.response as Record<string, unknown>;
        const output = response.output as Array<Record<string, unknown>>;
        const content = output[0]!.content as Array<Record<string, unknown>>;
        completedText = String(content[0]!.text);
        completedUsage = response.usage as Record<string, unknown>;
      }
    }
    expect(completedText).toBe("\nHey there, friend.\n");
    expect(completedUsage).toEqual({
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 20,
    });
  });

  it("streamResponsesFromText emits completed response shape", async () => {
    const text = "Hey there, friend.";
    const res = streamResponsesFromText({
      responseId: "resp_abc",
      messageId: "msg_abc",
      created_at: 1,
      model: "xialong-v1",
      text,
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

    const types: string[] = [];
    let completedText = "";
    let totalTokens = -1;
    let objectName = "";
    for await (const obj of parseSseJson(res.body!)) {
      const rec = obj as Record<string, unknown>;
      types.push(String(rec.type));
      if (rec.type === "response.completed") {
        const response = rec.response as Record<string, unknown>;
        objectName = String(response.object);
        const output = response.output as Array<Record<string, unknown>>;
        const content = output[0]!.content as Array<Record<string, unknown>>;
        completedText = String(content[0]!.text);
        const usage = response.usage as Record<string, unknown>;
        totalTokens = Number(usage.total_tokens);
      }
    }
    expect(types[0]).toBe("response.created");
    expect(types[types.length - 1]).toBe("response.completed");
    expect(objectName).toBe("response");
    expect(completedText).toBe(text);
    expect(totalTokens).toBe(3);
  });

  it("buildResponseObject maps usage fields", () => {
    const obj = buildResponseObject({
      id: "resp_x",
      model: "m",
      created_at: 1,
      status: "completed",
      text: "hi",
      messageId: "msg_x",
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    });
    expect(obj.usage).toEqual({
      input_tokens: 4,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 9,
    });
    expect(obj.output[0]!.content[0]!.text).toBe("hi");
  });

  it("marks truncated responses as incomplete", () => {
    const obj = buildResponseObject({
      id: "resp_x",
      model: "m",
      created_at: 1,
      status: "incomplete",
      text: "hi",
      messageId: "msg_x",
      incomplete_reason: "max_output_tokens",
    });
    expect(obj.status).toBe("incomplete");
    expect(obj.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(obj.output[0]!.status).toBe("incomplete");
  });

  it("marks upstream max_tokens finish as incomplete", async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n' +
      "data: [DONE]\n\n";
    const res = streamResponsesFromChat({
      upstream: new Response(sse, {
        headers: { "Content-Type": "text/event-stream" },
      }),
      responseId: "resp_len",
      messageId: "msg_len",
      created_at: 1,
      model: "m",
    });
    const types: string[] = [];
    let terminal: Record<string, unknown> | null = null;
    for await (const obj of parseSseJson(res.body!)) {
      const rec = obj as Record<string, unknown>;
      types.push(String(rec.type));
      if (rec.type === "response.incomplete") {
        terminal = rec.response as Record<string, unknown>;
      }
    }
    expect(types[types.length - 1]).toBe("response.incomplete");
    expect(terminal?.status).toBe("incomplete");
    expect(terminal?.incomplete_details).toEqual({
      reason: "max_output_tokens",
    });
  });
});
