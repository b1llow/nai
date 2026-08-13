import { openaiError } from "./errors";
import {
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
  MAX_TOTAL_CONTENT_CHARS,
  safeIdent,
} from "./limits";

export type ChatMessage = {
  role: string;
  content: string;
};

/**
 * Flatten OpenAI message content (string | parts[]) to a plain string.
 * Rejects image/audio/file parts with 400.
 */
export function flattenContent(content: unknown, param = "messages"): string {
  if (content == null) return "";
  if (typeof content === "string") {
    if (content.length > MAX_MESSAGE_CHARS) {
      throw openaiError(400, "message content is too long", {
        type: "invalid_request_error",
        param,
      });
    }
    return content;
  }
  if (!Array.isArray(content)) {
    throw openaiError(400, "message content must be a string or array of parts", {
      type: "invalid_request_error",
      param,
    });
  }

  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") {
      throw openaiError(400, "invalid content part", {
        type: "invalid_request_error",
        param,
      });
    }
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : undefined;

    if (
      type === "image_url" ||
      type === "image" ||
      type === "input_audio" ||
      type === "audio" ||
      type === "file" ||
      type === "input_file" ||
      "image_url" in p
    ) {
      throw openaiError(400, "only text content is supported", {
        type: "invalid_request_error",
        param,
      });
    }

    if (type === "text" || type === "input_text" || type === "output_text") {
      if (typeof p.text === "string") texts.push(p.text);
      else if (p.text && typeof p.text === "object") {
        const t = p.text as Record<string, unknown>;
        if (typeof t.value === "string") texts.push(t.value);
      }
      continue;
    }

    // Bare { text: "..." } without type
    if (typeof p.text === "string") {
      texts.push(p.text);
      continue;
    }

    throw openaiError(400, "only text content is supported", {
      type: "invalid_request_error",
      param,
    });
  }
  const joined = texts.join("\n");
  if (joined.length > MAX_MESSAGE_CHARS) {
    throw openaiError(400, "message content is too long", {
      type: "invalid_request_error",
      param,
    });
  }
  return joined;
}

export function normalizeRole(role: unknown): string {
  if (typeof role !== "string" || !role) return "user";
  if (role === "developer") return "system";
  return role;
}

export function normalizeMessages(
  messages: unknown,
  param = "messages",
): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw openaiError(400, "messages is required and must be a non-empty array", {
      type: "invalid_request_error",
      param,
    });
  }
  if (messages.length > MAX_MESSAGES) {
    throw openaiError(400, `messages must contain at most ${MAX_MESSAGES} items`, {
      type: "invalid_request_error",
      param,
    });
  }

  const out: ChatMessage[] = [];
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      throw openaiError(400, "each message must be an object", {
        type: "invalid_request_error",
        param,
      });
    }
    const msg = m as Record<string, unknown>;
    const role = normalizeRole(msg.role);
    if (!["system", "user", "assistant"].includes(role)) {
      throw openaiError(400, `unsupported message role: ${safeIdent(msg.role)}`, {
        type: "invalid_request_error",
        param,
      });
    }
    const content = flattenContent(msg.content, param);
    total += content.length;
    if (total > MAX_TOTAL_CONTENT_CHARS) {
      throw openaiError(400, "messages content is too long", {
        type: "invalid_request_error",
        param,
      });
    }
    out.push({ role, content });
  }
  return out;
}

export function assertMessagesBudget(
  messages: ChatMessage[],
  param = "messages",
): void {
  if (messages.length > MAX_MESSAGES) {
    throw openaiError(400, `messages must contain at most ${MAX_MESSAGES} items`, {
      type: "invalid_request_error",
      param,
    });
  }
  let total = 0;
  for (const m of messages) {
    if (m.content.length > MAX_MESSAGE_CHARS) {
      throw openaiError(400, "message content is too long", {
        type: "invalid_request_error",
        param,
      });
    }
    total += m.content.length;
    if (total > MAX_TOTAL_CONTENT_CHARS) {
      throw openaiError(400, "messages content is too long", {
        type: "invalid_request_error",
        param,
      });
    }
  }
}
