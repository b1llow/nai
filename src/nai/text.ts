import type { Env } from "../env";
import { openaiError } from "../errors";
import {
  MAX_NATIVE_TEXT_CHARS,
  MAX_SSE_STREAM_BYTES,
  MAX_TOKENS,
} from "../limits";
import { parseSseJson } from "../sse";
import { naiFetch, readBodyCapped, throwMappedUpstreamError } from "../upstream";
import { DEFAULT_STORY_MODEL } from "./catalog";

export type NativeTextInput = {
  input: string;
  model?: string;
  max_length?: number;
  min_length?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  top_a?: number;
  typical_p?: number;
  repetition_penalty?: number;
  generate_until_sentence?: boolean;
  seed?: number;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function extractOutput(data: unknown): string | null {
  if (typeof data === "string" && data) return data;
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (typeof o.output === "string") return o.output;
  if (typeof o.text === "string") return o.text;
  if (Array.isArray(o.output)) {
    return o.output
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          if (typeof row.data === "string") return row.data;
          if (typeof row.text === "string") return row.text;
        }
        return "";
      })
      .join("");
  }
  return null;
}

function tokenFromSse(obj: unknown): string {
  if (typeof obj === "string") return obj;
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  if (typeof o.token === "string") return o.token;
  if (typeof o.text === "string") return o.text;
  if (typeof o.output === "string") return o.output;
  const inner = extractOutput(obj);
  return inner ?? "";
}

export async function generateNativeText(
  env: Env,
  auth: string,
  input: NativeTextInput,
  signal?: AbortSignal,
): Promise<{ text: string; model: string }> {
  const prompt = input.input.trim();
  if (!prompt) {
    throw openaiError(400, "input is required", {
      type: "invalid_request_error",
      param: "input",
    });
  }
  if (prompt.length > MAX_NATIVE_TEXT_CHARS) {
    throw openaiError(400, "input is too long", {
      type: "invalid_request_error",
      param: "input",
    });
  }
  const model = (input.model ?? DEFAULT_STORY_MODEL).trim();
  if (!model || model.length > 256) {
    throw openaiError(400, "model is invalid", {
      type: "invalid_request_error",
      param: "model",
    });
  }
  const parameters: Record<string, unknown> = {
    temperature: clamp(finiteNumber(input.temperature) ?? 1, 0, 2),
    max_length: Math.trunc(clamp(finiteNumber(input.max_length) ?? 100, 1, MAX_TOKENS)),
    min_length: Math.trunc(clamp(finiteNumber(input.min_length) ?? 1, 1, MAX_TOKENS)),
    generate_until_sentence: input.generate_until_sentence !== false,
  };
  if (finiteNumber(input.top_p) !== undefined) parameters.top_p = clamp(input.top_p!, 0, 1);
  if (finiteNumber(input.top_k) !== undefined) {
    parameters.top_k = Math.trunc(clamp(input.top_k!, 0, 1000));
  }
  if (finiteNumber(input.top_a) !== undefined) parameters.top_a = clamp(input.top_a!, 0, 1);
  if (finiteNumber(input.typical_p) !== undefined) {
    parameters.typical_p = clamp(input.typical_p!, 0, 1);
  }
  if (finiteNumber(input.repetition_penalty) !== undefined) {
    parameters.repetition_penalty = clamp(input.repetition_penalty!, 0, 10);
  }
  if (finiteNumber(input.seed) !== undefined) {
    parameters.seed = Math.trunc(clamp(input.seed!, 0, 4_294_967_295));
  }

  const res = await naiFetch(env, "/ai/generate", {
    method: "POST",
    auth,
    host: "text",
    body: { input: prompt, model, parameters },
    signal,
    stream: false,
  });
  if (!res.ok) await throwMappedUpstreamError(res);

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream") && res.body) {
    let text = "";
    for await (const obj of parseSseJson(res.body)) {
      text += tokenFromSse(obj);
      if (text.length > MAX_SSE_STREAM_BYTES) break;
    }
    return { text, model };
  }

  const { text: raw, truncated } = await readBodyCapped(
    res,
    MAX_SSE_STREAM_BYTES,
  );
  if (truncated) {
    throw openaiError(502, "upstream response too large", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return { text: raw, model };
  }
  const out = extractOutput(parsed);
  if (out == null) {
    throw openaiError(502, "unexpected upstream text response", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  return { text: out, model };
}
