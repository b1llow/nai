import { describe, expect, it } from "vitest";
import { formatSseData, parseSseJson, SSE_DONE, stripNaiFields } from "../src/sse";

function streamFromString(s: string, chunkSizes?: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  if (!chunkSizes || chunkSizes.length === 0) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  let offset = 0;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = chunkSizes[i % chunkSizes.length]!;
      i++;
      const end = Math.min(offset + size, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

describe("parseSseJson", () => {
  it("parses standard events and skips [DONE]", async () => {
    const body =
      'data: {"a":1}\n\n' +
      "data: [DONE]\n\n" +
      'data: {"b":2}\n\n';
    const out: unknown[] = [];
    for await (const obj of parseSseJson(streamFromString(body))) out.push(obj);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles fragmented chunks across TCP boundaries", async () => {
    const body =
      'data: {"id":"x","choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      "data: [DONE]\n\n";
    const out: unknown[] = [];
    for await (const obj of parseSseJson(streamFromString(body, [1, 3, 7, 11, 5]))) {
      out.push(obj);
    }
    expect(out).toHaveLength(1);
    expect((out[0] as { id: string }).id).toBe("x");
  });

  it("joins multi-line data fields", async () => {
    const body = "data: {\"msg\":\n" + 'data: "hello"}\n\n';
    const out: unknown[] = [];
    for await (const obj of parseSseJson(streamFromString(body))) out.push(obj);
    expect(out).toEqual([{ msg: "hello" }]);
  });

  it("ignores comment lines", async () => {
    const body = ': keep-alive\n\ndata: {"ok":true}\n\n';
    const out: unknown[] = [];
    for await (const obj of parseSseJson(streamFromString(body))) out.push(obj);
    expect(out).toEqual([{ ok: true }]);
  });
});

describe("formatSseData", () => {
  it("encodes data lines", () => {
    expect(formatSseData({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});

describe("stripNaiFields", () => {
  it("removes token_ids and metadata", () => {
    const cleaned = stripNaiFields({
      id: "x",
      metadata: { foo: 1 },
      choices: [
        {
          index: 0,
          delta: { content: "Hi", token_ids: [1, 2] },
          token_ids: [1, 2],
          finish_reason: null,
        },
      ],
      prompt_token_ids: [9],
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
    expect(cleaned).not.toHaveProperty("metadata");
    expect(cleaned).not.toHaveProperty("prompt_token_ids");
  });
});
