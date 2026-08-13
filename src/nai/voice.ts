import type { Env } from "../env";
import { openaiError } from "../errors";
import { MAX_BINARY_RESPONSE_BYTES, MAX_VOICE_TEXT_CHARS } from "../limits";
import { bytesToBase64 } from "./binary";
import { naiFetchBinary } from "../upstream";

export type VoiceResult = {
  mimeType: string;
  base64: string;
};

export async function generateVoice(
  env: Env,
  auth: string,
  args: {
    text: string;
    voice?: string;
    version?: "v1" | "v2";
    opus?: boolean;
  },
  signal?: AbortSignal,
): Promise<VoiceResult> {
  const text = args.text.trim();
  if (!text) {
    throw openaiError(400, "text is required", {
      type: "invalid_request_error",
      param: "text",
    });
  }
  if (text.length > MAX_VOICE_TEXT_CHARS) {
    throw openaiError(400, "text is too long", {
      type: "invalid_request_error",
      param: "text",
    });
  }
  const version = args.version ?? "v2";
  const opus = args.opus !== false;
  const voice = (args.voice ?? "Aini").trim() || "Aini";
  const bytes = await naiFetchBinary(
    env,
    "/ai/generate-voice",
    {
      method: "POST",
      auth,
      host: "api",
      body: {
        text,
        seed: voice,
        voice: version === "v1" ? 1 : 0,
        opus,
        version,
      },
      signal,
    },
    MAX_BINARY_RESPONSE_BYTES,
  );
  return {
    mimeType: opus ? "audio/webm" : "audio/mpeg",
    base64: bytesToBase64(bytes),
  };
}
