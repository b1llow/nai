import type { Context } from "hono";
import type { AppEnv } from "./types";
import { openaiError } from "./errors";
import { assertMessagesBudget, flattenContent, normalizeRole } from "./content";
import {
  runChatCompletion,
  type ChatBody,
} from "./chat";
import {
  formatSseEvent,
  parseSseJson,
  stripNaiFields,
  SseLimitError,
  type ChatCompletion,
} from "./sse";
import {
  MAX_COMPLETION_CHARS,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_MODEL_LEN,
  MAX_TOKENS,
  MAX_USER_LEN,
  safeIdent,
} from "./limits";

function rid(prefix: string): string {
  const hex =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${hex}`;
}

export function responsesInputToMessages(raw: unknown): {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  user?: string;
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
  if (req.model.length > MAX_MODEL_LEN) {
    throw openaiError(400, "model is too long", {
      type: "invalid_request_error",
      param: "model",
    });
  }

  // Reject unsupported features
  if (req.tools != null && (Array.isArray(req.tools) ? req.tools.length : true)) {
    throw openaiError(400, "tools are not supported", {
      type: "invalid_request_error",
      param: "tools",
    });
  }
  if (req.tool_choice != null) {
    throw openaiError(400, "tool_choice is not supported", {
      type: "invalid_request_error",
      param: "tool_choice",
    });
  }
  if (req.previous_response_id != null) {
    throw openaiError(400, "previous_response_id is not supported", {
      type: "invalid_request_error",
      param: "previous_response_id",
    });
  }
  if (req.conversation != null) {
    throw openaiError(400, "conversation is not supported", {
      type: "invalid_request_error",
      param: "conversation",
    });
  }
  if (req.background === true) {
    throw openaiError(400, "background is not supported", {
      type: "invalid_request_error",
      param: "background",
    });
  }
  if (req.reasoning != null && typeof req.reasoning === "object") {
    const r = req.reasoning as Record<string, unknown>;
    if (r.effort != null) {
      throw openaiError(400, "reasoning is not supported", {
        type: "invalid_request_error",
        param: "reasoning",
      });
    }
  }
  if (req.text != null && typeof req.text === "object") {
    const t = req.text as Record<string, unknown>;
    const fmt = t.format as Record<string, unknown> | undefined;
    if (fmt && (fmt.type === "json_schema" || fmt.type === "json_object")) {
      throw openaiError(
        400,
        `${safeIdent(fmt.type, 32)} response format is not supported`,
        {
          type: "invalid_request_error",
          param: "text",
        },
      );
    }
  }

  const messages: Array<{ role: string; content: string }> = [];

  if (typeof req.instructions === "string" && req.instructions) {
    if (req.instructions.length > MAX_MESSAGE_CHARS) {
      throw openaiError(400, "instructions is too long", {
        type: "invalid_request_error",
        param: "instructions",
      });
    }
    messages.push({ role: "system", content: req.instructions });
  }

  const input = req.input;
  if (typeof input === "string") {
    if (input.length > MAX_MESSAGE_CHARS) {
      throw openaiError(400, "input is too long", {
        type: "invalid_request_error",
        param: "input",
      });
    }
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    if (input.length > MAX_MESSAGES) {
      throw openaiError(400, `input must contain at most ${MAX_MESSAGES} items`, {
        type: "invalid_request_error",
        param: "input",
      });
    }
    for (const item of input) {
      if (!item || typeof item !== "object") {
        throw openaiError(400, "invalid input item", {
          type: "invalid_request_error",
          param: "input",
        });
      }
      const it = item as Record<string, unknown>;
      if (it.type === "function_call" || it.type === "function_call_output") {
        throw openaiError(400, "function calls are not supported", {
          type: "invalid_request_error",
          param: "input",
        });
      }
      // Only message-shaped items are supported.
      if (it.type != null && it.type !== "message") {
        throw openaiError(
          400,
          `unsupported input item type: ${safeIdent(it.type, 32)}`,
          {
            type: "invalid_request_error",
            param: "input",
          },
        );
      }
      let role = normalizeRole(it.role ?? "user");
      if (!["system", "user", "assistant"].includes(role)) role = "user";
      const content = flattenContent(it.content, "input");
      messages.push({ role, content });
    }
  } else if (input != null) {
    throw openaiError(400, "input must be a string or array", {
      type: "invalid_request_error",
      param: "input",
    });
  }

  const hasNonSystem = messages.some((m) => m.role !== "system");
  if (messages.length === 0 || !hasNonSystem) {
    throw openaiError(400, "input is required", {
      type: "invalid_request_error",
      param: "input",
    });
  }
  assertMessagesBudget(messages, "input");

  const out: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    user?: string;
  } = {
    model: req.model,
    messages,
    stream: req.stream === true,
  };

  if (typeof req.max_output_tokens === "number") {
    if (!Number.isFinite(req.max_output_tokens)) {
      throw openaiError(400, "max_output_tokens must be a number", {
        type: "invalid_request_error",
        param: "max_output_tokens",
      });
    }
    out.max_tokens = Math.min(
      MAX_TOKENS,
      Math.max(1, Math.trunc(req.max_output_tokens)),
    );
  }
  if (typeof req.temperature === "number") {
    if (!Number.isFinite(req.temperature)) {
      throw openaiError(400, "temperature must be a number", {
        type: "invalid_request_error",
        param: "temperature",
      });
    }
    out.temperature = Math.min(2, Math.max(0, req.temperature));
  }
  if (typeof req.top_p === "number") {
    if (!Number.isFinite(req.top_p)) {
      throw openaiError(400, "top_p must be a number", {
        type: "invalid_request_error",
        param: "top_p",
      });
    }
    out.top_p = Math.min(1, Math.max(0, req.top_p));
  }
  if (typeof req.user === "string") {
    if (req.user.length > MAX_USER_LEN) {
      throw openaiError(400, "user must be a short string", {
        type: "invalid_request_error",
        param: "user",
      });
    }
    out.user = req.user;
  }

  return out;
}

export function buildResponseObject(opts: {
  id: string;
  model: string;
  created_at: number;
  status: "completed" | "in_progress" | "failed" | "incomplete";
  text: string;
  messageId: string;
  usage?: ChatCompletion["usage"] | null;
  error?: { code: string | null; message: string } | null;
  incomplete_reason?: string | null;
}) {
  const usage = opts.usage ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const outputStatus =
    opts.status === "failed" || opts.status === "incomplete"
      ? "incomplete"
      : "completed";
  return {
    id: opts.id,
    object: "response" as const,
    created_at: opts.created_at,
    status: opts.status,
    error: opts.error ?? null,
    incomplete_details: opts.incomplete_reason
      ? { reason: opts.incomplete_reason }
      : null,
    model: opts.model,
    output:
      opts.status === "in_progress" && !opts.text
        ? []
        : [
            {
              id: opts.messageId,
              type: "message" as const,
              role: "assistant" as const,
              status: outputStatus,
              content: [
                {
                  type: "output_text" as const,
                  text: opts.text,
                  annotations: [] as unknown[],
                },
              ],
            },
          ],
    usage: {
      input_tokens: usage.prompt_tokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.completion_tokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.total_tokens,
    },
  };
}

export async function handleResponses(c: Context<AppEnv>) {
  const auth = c.get("auth") as string;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw openaiError(400, "invalid JSON body", {
      type: "invalid_request_error",
    });
  }

  const parsed = responsesInputToMessages(raw);
  const chatBody: ChatBody = {
    model: parsed.model,
    messages: parsed.messages,
    stream: true,
  };
  if (parsed.max_tokens !== undefined) chatBody.max_tokens = parsed.max_tokens;
  if (parsed.temperature !== undefined) chatBody.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) chatBody.top_p = parsed.top_p;
  if (parsed.user !== undefined) chatBody.user = parsed.user;

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
  const detach = () => {
    c.req.raw.signal.removeEventListener("abort", onAbort);
  };

  const responseId = rid("resp");
  const messageId = rid("msg");
  const created_at = Math.floor(Date.now() / 1000);

  try {
    if (!parsed.stream) {
      const result = await runChatCompletion(c.env, auth, chatBody, {
        stream: false,
        signal: ac.signal,
      });
      if (result.kind !== "json") {
        throw openaiError(502, "unexpected stream result", {
          type: "api_error",
          code: "upstream_error",
        });
      }
      const text = result.completion.choices[0]?.message.content ?? "";
      const truncated =
        result.completion.choices[0]?.finish_reason === "length";
      detach();
      return c.json(
        buildResponseObject({
          id: responseId,
          model: result.completion.model,
          created_at,
          status: truncated ? "incomplete" : "completed",
          text,
          messageId,
          usage: result.completion.usage,
          incomplete_reason: truncated ? "max_output_tokens" : null,
        }),
      );
    }

    // Stream path: always consume upstream as stream, map to Responses events
    const result = await runChatCompletion(c.env, auth, chatBody, {
      stream: true,
      signal: ac.signal,
    });
    if (result.kind !== "stream") {
      // Got JSON unexpectedly — emit as completed single shot
      const text = result.completion.choices[0]?.message.content ?? "";
      return streamResponsesFromText({
        responseId,
        messageId,
        created_at,
        model: result.completion.model,
        text,
        usage: result.completion.usage,
        truncated: result.completion.choices[0]?.finish_reason === "length",
        clientSignal: c.req.raw.signal,
        upstreamAbort: ac,
        onDone: detach,
      });
    }

    return streamResponsesFromChat({
      upstream: result.response,
      responseId,
      messageId,
      created_at,
      model: parsed.model,
      clientSignal: c.req.raw.signal,
      upstreamAbort: ac,
      onDone: detach,
    });
  } catch (err) {
    detach();
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw err;
  }
}

export function streamResponsesFromText(opts: {
  responseId: string;
  messageId: string;
  created_at: number;
  model: string;
  text: string;
  usage: ChatCompletion["usage"];
  truncated?: boolean;
  clientSignal?: AbortSignal;
  upstreamAbort?: AbortController;
  onDone?: () => void;
}): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let seq = 0;

  const abort = () => {
    try {
      opts.upstreamAbort?.abort();
    } catch {
      /* ignore */
    }
    try {
      writer.abort();
    } catch {
      /* ignore */
    }
  };
  opts.clientSignal?.addEventListener("abort", abort, { once: true });

  (async () => {
    try {
      const base = buildResponseObject({
        id: opts.responseId,
        model: opts.model,
        created_at: opts.created_at,
        status: "in_progress",
        text: "",
        messageId: opts.messageId,
      });
      base.output = [];

      await writer.write(
        encoder.encode(
          formatSseEvent("response.created", {
            type: "response.created",
            response: { ...base, status: "in_progress" },
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.in_progress", {
            type: "response.in_progress",
            response: { ...base, status: "in_progress" },
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: opts.messageId,
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            },
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.content_part.added", {
            type: "response.content_part.added",
            item_id: opts.messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
            sequence_number: seq++,
          }),
        ),
      );
      if (opts.text) {
        await writer.write(
          encoder.encode(
            formatSseEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: opts.messageId,
              output_index: 0,
              content_index: 0,
              delta: opts.text,
              sequence_number: seq++,
            }),
          ),
        );
      }
      await writer.write(
        encoder.encode(
          formatSseEvent("response.output_text.done", {
            type: "response.output_text.done",
            item_id: opts.messageId,
            output_index: 0,
            content_index: 0,
            text: opts.text,
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.content_part.done", {
            type: "response.content_part.done",
            item_id: opts.messageId,
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: opts.text,
              annotations: [],
            },
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: opts.messageId,
              type: "message",
              role: "assistant",
              status: opts.truncated ? "incomplete" : "completed",
              content: [
                {
                  type: "output_text",
                  text: opts.text,
                  annotations: [],
                },
              ],
            },
            sequence_number: seq++,
          }),
        ),
      );
      const terminal = buildResponseObject({
        id: opts.responseId,
        model: opts.model,
        created_at: opts.created_at,
        status: opts.truncated ? "incomplete" : "completed",
        text: opts.text,
        messageId: opts.messageId,
        usage: opts.usage,
        incomplete_reason: opts.truncated ? "max_output_tokens" : null,
      });
      const terminalType = opts.truncated
        ? "response.incomplete"
        : "response.completed";
      await writer.write(
        encoder.encode(
          formatSseEvent(terminalType, {
            type: terminalType,
            response: terminal,
            sequence_number: seq++,
          }),
        ),
      );
      await writer.close();
    } catch (err) {
      try {
        await writer.abort(err);
      } catch {
        /* ignore */
      }
    } finally {
      opts.clientSignal?.removeEventListener("abort", abort);
      try {
        opts.onDone?.();
      } catch {
        /* ignore */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store",
      Connection: "keep-alive",
    },
  });
}

export function streamResponsesFromChat(opts: {
  upstream: Response;
  responseId: string;
  messageId: string;
  created_at: number;
  model: string;
  clientSignal?: AbortSignal;
  upstreamAbort?: AbortController;
  onDone?: () => void;
}): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let seq = 0;

  const abort = () => {
    try {
      opts.upstreamAbort?.abort();
    } catch {
      /* ignore */
    }
    try {
      writer.abort();
    } catch {
      /* ignore */
    }
  };
  opts.clientSignal?.addEventListener("abort", abort, { once: true });

  (async () => {
    let fullText = "";
    let usage: ChatCompletion["usage"] | null = null;
    let model = opts.model;
    let truncated = false;

    try {
      const base = buildResponseObject({
        id: opts.responseId,
        model,
        created_at: opts.created_at,
        status: "in_progress",
        text: "",
        messageId: opts.messageId,
      });
      // empty output for created/in_progress
      const inProgress = { ...base, status: "in_progress" as const, output: [] };

      await writer.write(
        encoder.encode(
          formatSseEvent("response.created", {
            type: "response.created",
            response: inProgress,
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.in_progress", {
            type: "response.in_progress",
            response: inProgress,
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: opts.messageId,
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            },
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.content_part.added", {
            type: "response.content_part.added",
            item_id: opts.messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
            sequence_number: seq++,
          }),
        ),
      );

      if (opts.upstream.body) {
        try {
          for await (const raw of parseSseJson(opts.upstream.body)) {
            if (opts.clientSignal?.aborted) break;
            const chunk = stripNaiFields(raw as Record<string, unknown>);
            if (typeof chunk.model === "string") model = chunk.model;
            if (chunk.usage && typeof chunk.usage === "object") {
              const u = chunk.usage as Record<string, unknown>;
              usage = {
                prompt_tokens:
                  typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
                completion_tokens:
                  typeof u.completion_tokens === "number"
                    ? u.completion_tokens
                    : 0,
                total_tokens:
                  typeof u.total_tokens === "number" ? u.total_tokens : 0,
              };
            }
            const choices = chunk.choices as
              | Array<Record<string, unknown>>
              | undefined;
            const c0 = choices?.[0];
            if (c0 && c0.finish_reason === "length") truncated = true;
            const delta = c0?.delta as Record<string, unknown> | undefined;
            const content =
              delta && typeof delta.content === "string" ? delta.content : "";
            if (!content) continue;
            if (fullText.length + content.length > MAX_COMPLETION_CHARS) {
              const room = Math.max(0, MAX_COMPLETION_CHARS - fullText.length);
              const piece = content.slice(0, room);
              if (piece) {
                fullText += piece;
                await writer.write(
                  encoder.encode(
                    formatSseEvent("response.output_text.delta", {
                      type: "response.output_text.delta",
                      item_id: opts.messageId,
                      output_index: 0,
                      content_index: 0,
                      delta: piece,
                      sequence_number: seq++,
                    }),
                  ),
                );
              }
              truncated = true;
              break;
            }
            fullText += content;
            await writer.write(
              encoder.encode(
                formatSseEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  item_id: opts.messageId,
                  output_index: 0,
                  content_index: 0,
                  delta: content,
                  sequence_number: seq++,
                }),
              ),
            );
          }
        } catch (err) {
          if (!(err instanceof SseLimitError)) throw err;
          truncated = true;
        }
      }

      await writer.write(
        encoder.encode(
          formatSseEvent("response.output_text.done", {
            type: "response.output_text.done",
            item_id: opts.messageId,
            output_index: 0,
            content_index: 0,
            text: fullText,
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.content_part.done", {
            type: "response.content_part.done",
            item_id: opts.messageId,
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: fullText,
              annotations: [],
            },
            sequence_number: seq++,
          }),
        ),
      );
      await writer.write(
        encoder.encode(
          formatSseEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: opts.messageId,
              type: "message",
              role: "assistant",
              status: truncated ? "incomplete" : "completed",
              content: [
                {
                  type: "output_text",
                  text: fullText,
                  annotations: [],
                },
              ],
            },
            sequence_number: seq++,
          }),
        ),
      );

      const terminal = buildResponseObject({
        id: opts.responseId,
        model,
        created_at: opts.created_at,
        status: truncated ? "incomplete" : "completed",
        text: fullText,
        messageId: opts.messageId,
        usage,
        incomplete_reason: truncated ? "max_output_tokens" : null,
      });
      const terminalType = truncated
        ? "response.incomplete"
        : "response.completed";
      await writer.write(
        encoder.encode(
          formatSseEvent(terminalType, {
            type: terminalType,
            response: terminal,
            sequence_number: seq++,
          }),
        ),
      );
      await writer.close();
    } catch (err) {
      try {
        const message = "upstream stream failed";
        await writer.write(
          encoder.encode(
            formatSseEvent("response.failed", {
              type: "response.failed",
              response: buildResponseObject({
                id: opts.responseId,
                model,
                created_at: opts.created_at,
                status: "failed",
                text: fullText,
                messageId: opts.messageId,
                usage,
                error: { code: "upstream_error", message },
              }),
              sequence_number: seq++,
            }),
          ),
        );
        await writer.close();
      } catch {
        try {
          await writer.abort(err);
        } catch {
          /* ignore */
        }
      }
    } finally {
      opts.clientSignal?.removeEventListener("abort", abort);
      try {
        opts.onDone?.();
      } catch {
        /* ignore */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store",
      Connection: "keep-alive",
    },
  });
}
