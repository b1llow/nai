import {
  MAX_COMPLETION_CHARS,
  MAX_SSE_EVENT_CHARS,
  MAX_SSE_LINE_BUFFER,
  MAX_SSE_STREAM_BYTES,
} from "./limits";

export const SSE_DONE = "data: [DONE]\n\n";

export class SseLimitError extends Error {
  constructor(message = "upstream stream exceeded size limits") {
    super(message);
    this.name = "SseLimitError";
  }
}

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
  let dataChars = 0;
  let totalBytes = 0;

  const flushEvent = function* (): Generator<any> {
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    dataLines = [];
    dataChars = 0;
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
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SSE_STREAM_BYTES) {
        throw new SseLimitError();
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_LINE_BUFFER) {
        throw new SseLimitError();
      }

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
          const payload = line.startsWith("data: ")
            ? line.slice(6)
            : line.slice(5);
          dataChars += payload.length + 1;
          if (dataChars > MAX_SSE_EVENT_CHARS) {
            throw new SseLimitError();
          }
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
        dataChars += payload.length;
        if (dataChars > MAX_SSE_EVENT_CHARS) {
          throw new SseLimitError();
        }
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

const CHUNK_KEYS = new Set([
  "id",
  "object",
  "created",
  "model",
  "choices",
  "usage",
  "system_fingerprint",
]);
const CHOICE_KEYS = new Set([
  "index",
  "delta",
  "message",
  "finish_reason",
  "logprobs",
  "text",
]);
const TEXT_PART_KEYS = new Set(["role", "content", "refusal"]);
const USAGE_KEYS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
]);

function pick(
  src: Record<string, unknown>,
  allowed: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) {
      out[key] = src[key];
    }
  }
  return out;
}

function sanitizeUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of USAGE_KEYS) {
    const n = u[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Keep OpenAI chat chunk fields; drop NAI-only and unknown keys. */
export function stripNaiFields<T extends Record<string, unknown>>(chunk: T): T {
  const base = pick(chunk, CHUNK_KEYS);
  if (Array.isArray(chunk.choices)) {
    base.choices = chunk.choices.map((choice) => {
      if (!choice || typeof choice !== "object") return choice;
      const c = pick(choice as Record<string, unknown>, CHOICE_KEYS);
      const delta = (choice as Record<string, unknown>).delta;
      if (delta && typeof delta === "object") {
        c.delta = pick(delta as Record<string, unknown>, TEXT_PART_KEYS);
      }
      const message = (choice as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        c.message = pick(message as Record<string, unknown>, TEXT_PART_KEYS);
      }
      return c;
    });
  }
  if (chunk.usage && typeof chunk.usage === "object") {
    const usage = sanitizeUsage(chunk.usage);
    if (usage) base.usage = usage;
    else delete base.usage;
  }
  return base as T;
}

function emptyCompletion(meta: {
  id: string;
  created: number;
  model: string;
}): ChatCompletion {
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

/**
 * Consume upstream SSE chat stream and build a single chat.completion object.
 */
export async function aggregateChatStream(
  upstream: Response,
  meta: { id: string; created: number; model: string },
): Promise<ChatCompletion> {
  if (!upstream.body) return emptyCompletion(meta);

  let fullText = "";
  let finishReason: string | null = null;
  let usage: ChatCompletion["usage"] | null = null;
  let id = meta.id;
  let model = meta.model;
  let created = meta.created;
  let truncated = false;

  try {
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
      const message = c0.message as Record<string, unknown> | undefined;
      if (!delta && message && typeof message.content === "string") {
        fullText += message.content;
      }
      if (typeof c0.text === "string" && c0.text && !delta) {
        fullText += c0.text;
      }
      if (fullText.length > MAX_COMPLETION_CHARS) {
        fullText = fullText.slice(0, MAX_COMPLETION_CHARS);
        truncated = true;
        break;
      }
    }
  } catch (err) {
    if (!(err instanceof SseLimitError)) throw err;
    truncated = true;
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
        finish_reason: truncated ? "length" : (finishReason ?? "stop"),
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
