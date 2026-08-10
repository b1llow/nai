import type { Context } from "hono";
import type { Env } from "./env";
import type { AppEnv } from "./types";
import { mapNaiError, openaiError, type HttpError } from "./errors";
import { normalizeMessages } from "./content";
import {
  aggregateChatStream,
  formatSseData,
  parseSseJson,
  stripNaiFields,
  SSE_DONE,
  type ChatCompletion,
} from "./sse";
import { NAI_OA, naiFetch, throwMappedUpstreamError } from "./upstream";

const PASS_THROUGH_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "seed",
  "logit_bias",
  "logprobs",
  "user",
  "enable_thinking",
  "unified_linear",
  "unified_quadratic",
  "unified_cubic",
  "unified_increase_linear_with_entropy",
  "generation_prefix",
  "suffix",
] as const;

const DROP_KEYS = [
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "modalities",
  "audio",
  "store",
  "stream_options",
  "n",
] as const;

export type ChatBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  [key: string]: unknown;
};

export function sanitizeChatBody(raw: unknown): {
  body: ChatBody;
  stream: boolean;
} {
  if (!raw || typeof raw !== "object") {
    throw openaiError(400, "request body must be a JSON object", {
      type: "invalid_request_error",
    });
  }
  const req = raw as Record<string, unknown>;

  if (typeof req.model !== "string" || !req.model) {
    throw openaiError(400, "model is required", {
      type: "invalid_request_error",
      param: "model",
    });
  }

  // Allow empty tools/functions arrays (common client default); reject non-empty.
  if (
    (req.tools != null &&
      (Array.isArray(req.tools) ? req.tools.length > 0 : true)) ||
    (req.functions != null &&
      (Array.isArray(req.functions) ? req.functions.length > 0 : true))
  ) {
    throw openaiError(400, "tools are not supported", {
      type: "invalid_request_error",
      param: req.tools != null ? "tools" : "functions",
    });
  }

  if (req.n != null && req.n !== 1) {
    throw openaiError(400, "only n=1 is supported", {
      type: "invalid_request_error",
      param: "n",
    });
  }

  const messages = normalizeMessages(req.messages, "messages");
  const stream = req.stream === true;

  const body: ChatBody = {
    model: req.model,
    messages,
    stream: true, // always force upstream stream
  };

  for (const key of PASS_THROUGH_KEYS) {
    if (req[key] !== undefined) body[key] = req[key];
  }

  // Explicitly ensure dropped keys are not present
  for (const key of DROP_KEYS) {
    delete body[key];
  }

  return { body, stream };
}

export type RunChatOptions = {
  stream: boolean;
  signal?: AbortSignal;
};

export type RunChatResult =
  | { kind: "json"; completion: ChatCompletion }
  | {
      kind: "stream";
      response: Response;
      id: string;
      created: number;
      model: string;
    };

/**
 * Shared chat runner used by /v1/chat/completions and /v1/responses.
 * Always forces upstream stream:true; aggregates when client wants JSON.
 */
export async function runChatCompletion(
  env: Env,
  auth: string,
  chatBody: ChatBody,
  opts: RunChatOptions,
): Promise<RunChatResult> {
  const upstreamBody = { ...chatBody, stream: true };
  const res = await naiFetch(env, NAI_OA.chat, {
    method: "POST",
    auth,
    body: upstreamBody,
    signal: opts.signal,
    stream: true,
  });

  if (!res.ok) {
    await throwMappedUpstreamError(res);
  }

  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`
      : `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = chatBody.model;

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    if (opts.stream) {
      return { kind: "stream", response: res, id, created, model };
    }
    const completion = await aggregateChatStream(res, { id, created, model });
    return { kind: "json", completion };
  }

  if (ct.includes("application/json")) {
    // Unexpected non-stream success — try to coerce
    const data = (await res.json()) as Record<string, unknown>;
    if (data.error) {
      throw mapNaiError(502, data, res.headers);
    }
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
    if (
      data.object === "chat.completion" &&
      msg &&
      typeof msg.content === "string" &&
      msg.content.length > 0
    ) {
      return {
        kind: "json",
        completion: {
          id: typeof data.id === "string" ? data.id : id,
          object: "chat.completion",
          created: typeof data.created === "number" ? data.created : created,
          model: typeof data.model === "string" ? data.model : model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: msg.content },
              finish_reason:
                typeof choices![0]!.finish_reason === "string"
                  ? (choices![0]!.finish_reason as string)
                  : "stop",
              logprobs: null,
            },
          ],
          usage: normalizeUsage(data.usage),
        },
      };
    }
    throw openaiError(502, "unexpected non-stream upstream response", {
      type: "api_error",
      code: "upstream_error",
    });
  }

  throw openaiError(502, "unexpected upstream content type", {
    type: "api_error",
    code: "upstream_error",
  });
}

function normalizeUsage(usage: unknown): ChatCompletion["usage"] {
  if (!usage || typeof usage !== "object") {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const u = usage as Record<string, unknown>;
  return {
    prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    completion_tokens:
      typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : 0,
  };
}

export type PipeChatStreamOpts = {
  clientSignal?: AbortSignal;
  /** Abort upstream fetch when the client disconnects. */
  upstreamAbort?: AbortController;
  /** Called when the pipe finishes (success, error, or abort). */
  onDone?: () => void;
};

/** Pipe upstream SSE → client SSE, stripping NAI fields. */
export function pipeChatStream(
  upstream: Response,
  meta: { id: string; created: number; model: string },
  opts?: PipeChatStreamOpts,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const clientSignal = opts?.clientSignal;
  const upstreamAbort = opts?.upstreamAbort;
  const onDone = opts?.onDone;

  const abort = () => {
    try {
      upstreamAbort?.abort();
    } catch {
      /* ignore */
    }
    try {
      writer.abort();
    } catch {
      /* ignore */
    }
  };
  clientSignal?.addEventListener("abort", abort, { once: true });

  (async () => {
    let wroteDone = false;
    try {
      if (!upstream.body) {
        await writer.write(encoder.encode(SSE_DONE));
        wroteDone = true;
        await writer.close();
        return;
      }
      for await (const raw of parseSseJson(upstream.body)) {
        if (clientSignal?.aborted) break;
        const chunk = stripNaiFields(raw as Record<string, unknown>) as Record<
          string,
          unknown
        >;
        if (typeof chunk.object !== "string") {
          chunk.object = "chat.completion.chunk";
        }
        if (typeof chunk.id !== "string") chunk.id = meta.id;
        if (typeof chunk.created !== "number") chunk.created = meta.created;
        if (typeof chunk.model !== "string") chunk.model = meta.model;
        await writer.write(encoder.encode(formatSseData(chunk)));
      }
      if (!wroteDone && !clientSignal?.aborted) {
        await writer.write(encoder.encode(SSE_DONE));
        wroteDone = true;
      }
      await writer.close();
    } catch (err) {
      try {
        await writer.abort(err);
      } catch {
        /* ignore */
      }
    } finally {
      clientSignal?.removeEventListener("abort", abort);
      try {
        onDone?.();
      } catch {
        /* ignore */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function handleChatCompletions(c: Context<AppEnv>) {
  const auth = c.get("auth") as string;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw openaiError(400, "invalid JSON body", {
      type: "invalid_request_error",
    });
  }

  const { body, stream } = sanitizeChatBody(raw);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

  const detach = () => {
    c.req.raw.signal.removeEventListener("abort", onAbort);
  };

  try {
    const result = await runChatCompletion(c.env, auth, body, {
      stream,
      signal: ac.signal,
    });

    if (result.kind === "json") {
      detach();
      return c.json(result.completion);
    }

    // Keep onAbort attached until the stream ends so client disconnect
    // cancels the upstream NovelAI request via ac.
    return pipeChatStream(
      result.response,
      { id: result.id, created: result.created, model: result.model },
      {
        clientSignal: c.req.raw.signal,
        upstreamAbort: ac,
        onDone: detach,
      },
    );
  } catch (err) {
    detach();
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw err;
  }
}

// re-export for responses error typing convenience
export type { HttpError };
