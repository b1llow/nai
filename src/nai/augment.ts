import type { Env } from "../env";
import { openaiError } from "../errors";
import { MAX_BINARY_RESPONSE_BYTES } from "../limits";
import { bytesToBase64 } from "./binary";
import { DIRECTOR_TYPES, EMOTIONS, clampDim } from "./catalog";
import { decodeUserImage } from "./image-input";
import { naiFetchBinary } from "../upstream";
import { extractPngs } from "./zip";

export type DirectorType = (typeof DIRECTOR_TYPES)[number];
export type Emotion = (typeof EMOTIONS)[number];

export type DirectorInput = {
  req_type: DirectorType;
  image: string;
  width?: number;
  height?: number;
  prompt?: string;
  defry?: number;
  emotion?: Emotion;
  emotion_level?: number;
};

export type ImageFileResult = {
  name: string;
  mimeType: "image/png";
  base64: string;
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function runDirector(
  env: Env,
  auth: string,
  input: DirectorInput,
  signal?: AbortSignal,
): Promise<ImageFileResult[]> {
  if (!(DIRECTOR_TYPES as readonly string[]).includes(input.req_type)) {
    throw openaiError(400, "unknown director req_type", {
      type: "invalid_request_error",
      param: "req_type",
    });
  }
  const decoded = decodeUserImage(input.image, "image");
  const width = clampDim(finiteNumber(input.width) ?? decoded.width ?? 1024);
  const height = clampDim(finiteNumber(input.height) ?? decoded.height ?? 1024);

  const body: Record<string, unknown> = {
    req_type: input.req_type,
    image: decoded.base64,
    width,
    height,
  };

  if (input.req_type === "colorize") {
    body.defry = Math.trunc(Math.min(5, Math.max(0, finiteNumber(input.defry) ?? 0)));
    if (input.prompt) body.prompt = input.prompt;
  }
  if (input.req_type === "emotion") {
    const mood = input.emotion ?? "neutral";
    if (!(EMOTIONS as readonly string[]).includes(mood)) {
      throw openaiError(400, "unknown emotion", {
        type: "invalid_request_error",
        param: "emotion",
      });
    }
    const extra = input.prompt ? input.prompt : "";
    body.prompt = `${mood};;${extra}`;
    body.defry = Math.trunc(
      Math.min(5, Math.max(0, finiteNumber(input.emotion_level) ?? 0)),
    );
  }

  const zipBytes = await naiFetchBinary(
    env,
    "/ai/augment-image",
    { method: "POST", auth, host: "image", body, signal },
    MAX_BINARY_RESPONSE_BYTES,
  );
  return extractPngs(zipBytes).map((f) => ({
    name: f.name,
    mimeType: "image/png" as const,
    base64: bytesToBase64(f.bytes),
  }));
}

export async function upscaleImage(
  env: Env,
  auth: string,
  args: { image: string; scale?: 2 | 4; width?: number; height?: number },
  signal?: AbortSignal,
): Promise<ImageFileResult[]> {
  const decoded = decodeUserImage(args.image, "image");
  const scale = args.scale === 4 ? 4 : 2;
  const width = clampDim(finiteNumber(args.width) ?? decoded.width ?? 1024);
  const height = clampDim(finiteNumber(args.height) ?? decoded.height ?? 1024);
  const zipBytes = await naiFetchBinary(
    env,
    "/ai/upscale",
    {
      method: "POST",
      auth,
      host: "api",
      body: {
        image: decoded.base64,
        width,
        height,
        scale,
      },
      signal,
    },
    MAX_BINARY_RESPONSE_BYTES,
  );
  return extractPngs(zipBytes).map((f) => ({
    name: f.name,
    mimeType: "image/png" as const,
    base64: bytesToBase64(f.bytes),
  }));
}
