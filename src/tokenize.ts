import type { Context } from "hono";
import type { AppEnv } from "./types";
import { openaiError } from "./errors";
import { normalizeMessages } from "./content";
import { NAI_OA, naiFetch, readBodyCapped, throwMappedUpstreamError } from "./upstream";
import {
  MAX_MODEL_LEN,
  MAX_TOKENIZE_RESPONSE_BYTES,
  MAX_TOTAL_CONTENT_CHARS,
} from "./limits";

/** Approximate NovelAI/GLM chat template for token-count prompts. */
function messagesToPrompt(
  messages: Array<{ role: string; content: string }>,
): string {
  let prompt = "[gMASK]<sop>";
  for (const m of messages) {
    prompt += `<|${m.role}|>\n${m.content}`;
  }
  prompt += "<|assistant|>\n";
  return prompt;
}

export function sanitizeTokenCountResponse(
  data: unknown,
): Record<string, unknown> {
  if (!data || typeof data !== "object") {
    throw openaiError(502, "unexpected upstream token-count response", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  const o = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const takeNumber = (key: string) => {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9) {
      out[key] = v;
    }
  };

  takeNumber("token_count");
  takeNumber("count");
  takeNumber("tokens");

  if (
    typeof out.token_count !== "number" &&
    typeof out.tokens === "number"
  ) {
    out.token_count = out.tokens;
  }
  if (
    typeof out.token_count !== "number" &&
    typeof out.count === "number"
  ) {
    out.token_count = out.count;
  }

  if (typeof out.token_count !== "number") {
    throw openaiError(502, "unexpected upstream token-count response", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  return out;
}

export async function handleTokenCount(c: Context<AppEnv>) {
  const auth = c.get("auth") as string;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw openaiError(400, "invalid JSON body", {
      type: "invalid_request_error",
    });
  }
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

  let prompt: string;
  if (typeof req.prompt === "string") {
    if (req.prompt.length > MAX_TOTAL_CONTENT_CHARS) {
      throw openaiError(400, "prompt is too long", {
        type: "invalid_request_error",
        param: "prompt",
      });
    }
    prompt = req.prompt;
  } else if (Array.isArray(req.messages)) {
    const msgs = normalizeMessages(req.messages, "messages");
    prompt = messagesToPrompt(msgs);
    if (prompt.length > MAX_TOTAL_CONTENT_CHARS) {
      throw openaiError(400, "messages content is too long", {
        type: "invalid_request_error",
        param: "messages",
      });
    }
  } else {
    throw openaiError(400, "prompt or messages is required", {
      type: "invalid_request_error",
      param: "prompt",
    });
  }

  const res = await naiFetch(c.env, NAI_OA.tokenCount, {
    method: "POST",
    auth,
    body: { model: req.model, prompt },
    signal: c.req.raw.signal,
  });
  if (!res.ok) await throwMappedUpstreamError(res);
  const { text, truncated } = await readBodyCapped(
    res,
    MAX_TOKENIZE_RESPONSE_BYTES,
  );
  if (truncated) {
    throw openaiError(502, "unexpected upstream token-count response", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw openaiError(502, "unexpected upstream token-count response", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  return c.json(sanitizeTokenCountResponse(data));
}
