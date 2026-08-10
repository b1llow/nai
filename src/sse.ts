export const SSE_DONE = "data: [DONE]\n\n";

export function formatSseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function formatSseEvent(event: string, obj: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Parse an SSE byte stream into JSON objects.
 * Buffers incomplete lines across chunks; joins multi-line `data:` fields;
 * skips comments, empty events, and `[DONE]`.
 */
export async function* parseSseJson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flushEvent = function* (): Generator<any> {
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    dataLines = [];
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // skip malformed JSON events
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          yield* flushEvent();
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        if (line.startsWith("data:")) {
          // Accept "data:" and "data: "
          const payload = line.startsWith("data: ")
            ? line.slice(6)
            : line.slice(5);
          dataLines.push(payload);
          continue;
        }
        // ignore event:/id:/retry: for chat upstream
      }
    }
    buffer += decoder.decode();
    if (buffer.length) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith("data:")) {
        const payload = line.startsWith("data: ")
          ? line.slice(6)
          : line.slice(5);
        dataLines.push(payload);
      }
    }
    yield* flushEvent();
  } finally {
    try {
      await reader.cancel();
    } catch {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}

export type ChatCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string | null;
    logprobs: null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

const NAI_STRIP_KEYS = new Set([
  "token_ids",
  "processed_logprobs",
  "stop_reason",
  "matched_stop",
  "prompt_token_ids",
  "metadata",
]);

/** Strip NAI-only fields from a chunk (shallow + choices). */
export function stripNaiFields<T extends Record<string, unknown>>(chunk: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(chunk)) {
    if (NAI_STRIP_KEYS.has(k)) continue;
    if (k === "choices" && Array.isArray(v)) {
      out.choices = v.map((choice) => {
        if (!choice || typeof choice !== "object") return choice;
        const c: Record<string, unknown> = {};
        for (const [ck, cv] of Object.entries(choice as Record<string, unknown>)) {
          if (NAI_STRIP_KEYS.has(ck)) continue;
          if (ck === "delta" && cv && typeof cv === "object") {
            const d: Record<string, unknown> = {};
            for (const [dk, dv] of Object.entries(cv as Record<string, unknown>)) {
              if (NAI_STRIP_KEYS.has(dk)) continue;
              d[dk] = dv;
            }
            c.delta = d;
          } else if (ck === "message" && cv && typeof cv === "object") {
            const m: Record<string, unknown> = {};
            for (const [mk, mv] of Object.entries(cv as Record<string, unknown>)) {
              if (NAI_STRIP_KEYS.has(mk)) continue;
              m[mk] = mv;
            }
            c.message = m;
          } else {
            c[ck] = cv;
          }
        }
        return c;
      });
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Consume upstream SSE chat stream and build a single chat.completion object.
 */
export async function aggregateChatStream(
  upstream: Response,
  meta: { id: string; created: number; model: string },
): Promise<ChatCompletion> {
  if (!upstream.body) {
    return {
      id: meta.id,
      object: "chat.completion",
      created: meta.created,
      model: meta.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  let fullText = "";
  let finishReason: string | null = null;
  let usage: ChatCompletion["usage"] | null = null;
  let id = meta.id;
  let model = meta.model;
  let created = meta.created;

  for await (const raw of parseSseJson(upstream.body)) {
    const chunk = stripNaiFields(raw as Record<string, unknown>);
    if (typeof chunk.id === "string") id = chunk.id;
    if (typeof chunk.model === "string") model = chunk.model;
    if (typeof chunk.created === "number") created = chunk.created;

    if (chunk.usage && typeof chunk.usage === "object") {
      const u = chunk.usage as Record<string, unknown>;
      usage = {
        prompt_tokens: num(u.prompt_tokens),
        completion_tokens: num(u.completion_tokens),
        total_tokens: num(u.total_tokens),
      };
    }

    const choices = chunk.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const c0 = choices[0] as Record<string, unknown>;
    if (typeof c0.finish_reason === "string") finishReason = c0.finish_reason;

    const delta = c0.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string") {
      fullText += delta.content;
    }
    // Some providers put content on message even in stream chunks
    const message = c0.message as Record<string, unknown> | undefined;
    if (!delta && message && typeof message.content === "string") {
      fullText += message.content;
    }
    // Rare: non-stream-shaped chunk with text field
    if (typeof c0.text === "string" && c0.text && !delta) {
      fullText += c0.text;
    }
  }

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: fullText },
        finish_reason: finishReason ?? "stop",
        logprobs: null,
      },
    ],
    usage: usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
