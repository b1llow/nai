import { unzipSync } from "fflate";
import { openaiError } from "../errors";
import { isPng, isZip } from "./binary";

export type ExtractedFile = {
  name: string;
  bytes: Uint8Array;
};

function looksLikePngName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  if (base.startsWith(".") || name.includes("__MACOSX")) return false;
  return /\.png$/i.test(base);
}

/**
 * NovelAI image endpoints return a ZIP of PNGs, or occasionally a raw PNG.
 */
export function extractPngs(bytes: Uint8Array): ExtractedFile[] {
  if (isPng(bytes)) {
    return [{ name: "image_0.png", bytes }];
  }
  if (!isZip(bytes)) {
    throw openaiError(502, "unexpected upstream image payload", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw openaiError(502, "failed to unzip upstream image payload", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  const out: ExtractedFile[] = [];
  for (const [name, data] of Object.entries(files)) {
    if (!data || data.byteLength === 0) continue;
    if (looksLikePngName(name) || isPng(data)) {
      out.push({ name, bytes: data });
    }
  }
  if (out.length === 0) {
    throw openaiError(502, "upstream zip contained no images", {
      type: "api_error",
      code: "upstream_error",
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
