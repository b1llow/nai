import { openaiError } from "../errors";
import {
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_PROMPT_CHARS,
} from "../limits";
import { base64ToBytes, bytesToBase64, isPng, pngSize, stripDataUrl } from "./binary";

export type DecodedImage = {
  base64: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  isPng: boolean;
};

export function decodeUserImage(raw: string, param = "image"): DecodedImage {
  if (typeof raw !== "string" || !raw.trim()) {
    throw openaiError(400, `${param} is required`, {
      type: "invalid_request_error",
      param,
    });
  }
  let b64: string;
  try {
    b64 = stripDataUrl(raw);
  } catch {
    throw openaiError(400, `${param} is not valid base64`, {
      type: "invalid_request_error",
      param,
    });
  }
  if (b64.length > MAX_IMAGE_INPUT_BYTES * 2) {
    throw openaiError(400, `${param} is too large`, {
      type: "invalid_request_error",
      param,
    });
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    throw openaiError(400, `${param} is not valid base64`, {
      type: "invalid_request_error",
      param,
    });
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_INPUT_BYTES) {
    throw openaiError(400, `${param} is too large`, {
      type: "invalid_request_error",
      param,
    });
  }
  const png = isPng(bytes);
  const size = png ? pngSize(bytes) : null;
  return {
    base64: bytesToBase64(bytes),
    bytes,
    width: size?.width,
    height: size?.height,
    isPng: png,
  };
}

export function clampPrompt(value: string, param: string): string {
  if (value.length > MAX_IMAGE_PROMPT_CHARS) {
    throw openaiError(400, `${param} is too long`, {
      type: "invalid_request_error",
      param,
    });
  }
  return value;
}
