import type { Env } from "../env";
import {
  MAX_BINARY_RESPONSE_BYTES,
  MAX_ERROR_BODY_BYTES,
} from "../limits";
import {
  artifactOwner,
  getCachedVibe,
  putCachedVibe,
} from "../mcp/artifacts";
import { naiFetchBinary, naiFetchJson } from "../upstream";
import { base64ToBytes, bytesToBase64, pngSize } from "./binary";
import { applyEncodedVibes, prepareGenerateImage, type GenerateImageInput } from "./image-payload";
import { extractPngs } from "./zip";

export type GeneratedImage = {
  name: string;
  mimeType: "image/png";
  base64: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
};

export type GenerateImageResult = {
  images: GeneratedImage[];
  seed: number;
  model: string;
  action: string;
  width: number;
  height: number;
};

export async function encodeVibe(
  env: Env,
  auth: string,
  args: { image: string; model: string; information_extracted?: number },
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await naiFetchBinary(
    env,
    "/ai/encode-vibe",
    {
      method: "POST",
      auth,
      host: "image",
      body: {
        image: args.image,
        model: args.model,
        informationExtracted: args.information_extracted ?? 1,
        information_extracted: args.information_extracted ?? 1,
      },
      signal,
    },
    MAX_BINARY_RESPONSE_BYTES,
  );
  return bytesToBase64(bytes);
}

export async function generateImage(
  env: Env,
  auth: string,
  input: GenerateImageInput,
  signal?: AbortSignal,
): Promise<GenerateImageResult> {
  const prepared = prepareGenerateImage(input);
  let body = prepared.body;
  if (prepared.vibesToEncode.length > 0) {
    const owner = await artifactOwner(auth);
    const encoded: string[] = [];
    for (const slot of prepared.vibesToEncode) {
      const pngBytes = base64ToBytes(slot.image);
      const cached = await getCachedVibe(
        env,
        owner,
        pngBytes,
        prepared.model,
        slot.information_extracted,
      );
      if (cached) {
        encoded.push(cached);
        continue;
      }
      const token = await encodeVibe(
        env,
        auth,
        {
          image: slot.image,
          model: prepared.model,
          information_extracted: slot.information_extracted,
        },
        signal,
      );
      await putCachedVibe(
        env,
        owner,
        pngBytes,
        prepared.model,
        slot.information_extracted,
        token,
      );
      encoded.push(token);
    }
    body = applyEncodedVibes(prepared, encoded);
  }

  const zipBytes = await naiFetchBinary(
    env,
    "/ai/generate-image",
    {
      method: "POST",
      auth,
      host: "image",
      body,
      signal,
    },
    MAX_BINARY_RESPONSE_BYTES,
  );
  const files = extractPngs(zipBytes);
  return {
    images: files.map((f) => {
      const size = pngSize(f.bytes);
      return {
        name: f.name,
        mimeType: "image/png" as const,
        base64: bytesToBase64(f.bytes),
        bytes: f.bytes,
        width: size?.width,
        height: size?.height,
      };
    }),
    seed: prepared.seed,
    model: prepared.model,
    action: prepared.action,
    width: prepared.width,
    height: prepared.height,
  };
}

export async function suggestTags(
  env: Env,
  auth: string,
  args: { prompt: string; model?: string },
  signal?: AbortSignal,
): Promise<unknown> {
  const q = new URLSearchParams();
  q.set("prompt", args.prompt);
  if (args.model) q.set("model", args.model);
  return naiFetchJson(
    env,
    `/ai/generate-image/suggest-tags?${q.toString()}`,
    { method: "GET", auth, host: "image", signal },
    MAX_ERROR_BODY_BYTES * 4,
  );
}
