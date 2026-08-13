import { HttpError } from "../errors";

export type McpText = { type: "text"; text: string };
export type McpImage = { type: "image"; data: string; mimeType: string };
export type McpAudio = { type: "audio"; data: string; mimeType: string };
export type McpContent = McpText | McpImage | McpAudio;

export type McpToolResult = {
  content: McpContent[];
  isError?: boolean;
};

export function mcpText(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

export function mcpJson(value: unknown): McpToolResult {
  return mcpText(JSON.stringify(value, null, 2));
}

export function mcpNeedAuth(): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Missing NovelAI Persistent API token. Pass Authorization: Bearer <token> on the MCP request, or set the NAI_ACCESS_TOKEN Worker secret.",
      },
    ],
    isError: true,
  };
}

export function mcpError(err: unknown): McpToolResult {
  if (err instanceof HttpError) {
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
  return {
    content: [{ type: "text", text: "Internal Server Error" }],
    isError: true,
  };
}

export function withImages(
  meta: unknown,
  images: Array<{ name: string; base64: string; mimeType?: string }>,
): McpToolResult {
  const content: McpContent[] = [
    { type: "text", text: JSON.stringify(meta, null, 2) },
  ];
  for (const img of images) {
    content.push({
      type: "image",
      data: img.base64,
      mimeType: img.mimeType ?? "image/png",
    });
  }
  return { content };
}

export async function runTool(
  auth: string | null,
  fn: (auth: string) => Promise<McpToolResult>,
): Promise<McpToolResult> {
  if (!auth) return mcpNeedAuth();
  try {
    return await fn(auth);
  } catch (err) {
    return mcpError(err);
  }
}
