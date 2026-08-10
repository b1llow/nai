import type { Context } from "hono";
import type { AppEnv } from "./types";
import { openaiError } from "./errors";
import { normalizeMessages } from "./content";
import { NAI_OA, naiFetch, throwMappedUpstreamError } from "./upstream";

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

  let prompt: string;
  if (typeof req.prompt === "string") {
    prompt = req.prompt;
  } else if (Array.isArray(req.messages)) {
    const msgs = normalizeMessages(req.messages, "messages");
    prompt = messagesToPrompt(msgs);
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
  const data = await res.json();
  return c.json(data);
}
