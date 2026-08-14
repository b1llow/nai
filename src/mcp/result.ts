import type { Env } from "../env";
import { HttpError } from "../errors";
import { errorMessage, logError } from "../log";
import { bytesToBase64, pngSize } from "../nai/binary";
import { imageResourceUri } from "../nai/image-input";
import { putImage } from "./artifacts";
import { IMAGE_WIDGET_URI } from "./image-widget";
import { publishImage } from "./public-image";

export type McpText = { type: "text"; text: string };
export type McpImage = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: { audience: Array<"user" | "assistant"> };
};
export type McpAudio = { type: "audio"; data: string; mimeType: string };
export type McpResourceLink = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: string;
};
export type McpContent = McpText | McpImage | McpAudio | McpResourceLink;

export type McpToolResult = {
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/** Widget-only envelope for ChatGPT `toolResponseMetadata` (not model-visible). */
export function withWidgetBridge(
  result: McpToolResult,
  templateUri?: string,
): McpToolResult {
  const envelope: Record<string, unknown> = { content: result.content };
  if (result.structuredContent !== undefined) {
    envelope.structuredContent = result.structuredContent;
  }
  if (result.isError) envelope.isError = true;
  const _meta: Record<string, unknown> = {
    ...result._meta,
    mcp_tool_result: envelope,
    call_tool_result: envelope,
  };
  if (templateUri) {
    _meta.ui = { resourceUri: templateUri };
    _meta["openai/outputTemplate"] = templateUri;
  }
  return { ...result, _meta };
}

export type ImageBlob = {
  name: string;
  bytes: Uint8Array;
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
};

export type StoredImageMeta = {
  image_id: string | null;
  filename: string;
  mime_type: string;
  width?: number;
  height?: number;
  resource_uri?: string;
  url?: string;
  skipped?: string;
};

export function asStructuredContent(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value };
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return { value };
}

export function mcpText(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

export function mcpJson(value: unknown): McpToolResult {
  const structuredContent = asStructuredContent(value);
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

export function mcpNeedAuth(): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Missing NovelAI Persistent API token. Complete OAuth at /authorize, or pass Authorization: Bearer <token> on the MCP request (same as /v1).",
      },
    ],
    isError: true,
  };
}

export function mcpError(err: unknown): McpToolResult {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      logError({
        message: "mcp tool upstream error",
        error: err.message,
        status: err.status,
      });
    }
    return {
      content: [{ type: "text", text: err.message }],
      isError: true,
    };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return {
      content: [{ type: "text", text: "Request cancelled" }],
      isError: true,
    };
  }
  logError({
    message: "unhandled mcp tool error",
    error: errorMessage(err),
  });
  return {
    content: [{ type: "text", text: "Internal Server Error" }],
    isError: true,
  };
}

export async function withImages(
  ctx: { env: Env; owner: string; origin: string },
  extra: Record<string, unknown>,
  images: ImageBlob[],
): Promise<McpToolResult> {
  const stored: StoredImageMeta[] = [];
  const content: McpContent[] = [];

  for (const img of images) {
    const mime = img.mimeType ?? "image/png";
    const size = img.width && img.height ? null : pngSize(img.bytes);
    const width = img.width ?? size?.width;
    const height = img.height ?? size?.height;
    const base64 = img.base64 ?? bytesToBase64(img.bytes);
    const imageId = await putImage(ctx.env, ctx.owner, img.bytes, {
      mime,
      width,
      height,
      name: img.name,
    });
    const published = imageId
      ? await publishImage(ctx.env, ctx.origin, imageId, img.bytes)
      : null;

    const meta: StoredImageMeta = {
      image_id: imageId,
      filename: img.name,
      mime_type: published?.mime ?? mime,
      width,
      height,
    };
    if (imageId) {
      meta.resource_uri = imageResourceUri(imageId);
    } else {
      meta.skipped =
        "too large to store as image_id; this output cannot be passed to later image tools";
    }
    if (published) meta.url = published.url;
    stored.push(meta);

    if (published) {
      content.push({
        type: "resource_link",
        uri: published.url,
        name: published.filename,
        mimeType: published.mime,
      });
    } else {
      content.push({
        type: "image",
        data: base64,
        mimeType: mime,
        annotations: { audience: ["user"] },
      });
      if (imageId) {
        content.push({
          type: "resource_link",
          uri: meta.resource_uri!,
          name: img.name,
          mimeType: mime,
        });
      }
    }
  }

  const structuredContent: Record<string, unknown> = {
    ...extra,
    image_id: stored[0]?.image_id ?? null,
    images: stored,
  };
  if (stored[0]?.url) structuredContent.image_url = stored[0].url;
  content.unshift({
    type: "text",
    text: JSON.stringify(structuredContent, null, 2),
  });
  const result: McpToolResult = { content, structuredContent };
  // Data tools normally leave widget binding to nai_render_image_preview.
  // When persist fails there is no image_id to render, but ImageContent is
  // already on this result — bind the template so ChatGPT can still mount.
  if (stored.some((img) => !img.image_id)) {
    return withWidgetBridge(result, IMAGE_WIDGET_URI);
  }
  return result;
}

export async function runTool(
  auth: string | null,
  fn: (auth: string) => Promise<McpToolResult>,
  options?: { widget?: boolean; templateUri?: string },
): Promise<McpToolResult> {
  const finish = options?.widget
    ? (result: McpToolResult) => withWidgetBridge(result, options.templateUri)
    : (result: McpToolResult) => result;
  if (!auth) return finish(mcpNeedAuth());
  try {
    return finish(await fn(auth));
  } catch (err) {
    return finish(mcpError(err));
  }
}
