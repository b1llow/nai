import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RESOLUTION_PRESET_IDS } from "../src/nai/catalog";
import {
  IMAGE_WIDGET_HTML,
  IMAGE_WIDGET_MIME_TYPE,
  IMAGE_WIDGET_URI,
} from "../src/mcp/image-widget";
import { createNaiMcpServer, handleMcp } from "../src/mcp/server";
import { naiGenerateImageInputSchema } from "../src/mcp/tools";
import { testEnv, testExecutionContext } from "./helpers";

function jsonSchemaEnum(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const enumValues = (schema as { enum?: unknown }).enum;
  if (!Array.isArray(enumValues)) return undefined;
  return enumValues.filter((v): v is string => typeof v === "string");
}

describe("nai_generate_image input schema", () => {
  it("accepts preset names and numeric width/height", () => {
    expect(
      naiGenerateImageInputSchema.safeParse({
        prompt: "1girl",
        resolution: "normal_portrait",
      }).success,
    ).toBe(true);
    expect(
      naiGenerateImageInputSchema.safeParse({
        prompt: "1girl",
        width: 1024,
        height: 1024,
      }).success,
    ).toBe(true);
  });

  it("rejects 1024x1024, portrait, and other non-preset size strings", () => {
    for (const resolution of ["1024x1024", "portrait", "512x768", "landscape"]) {
      const parsed = naiGenerateImageInputSchema.safeParse({
        prompt: "1girl",
        resolution,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("exposes resolution as a preset enum in JSON Schema", () => {
    const schema = z.toJSONSchema(naiGenerateImageInputSchema);
    const resolution = (schema as { properties?: { resolution?: unknown } })
      .properties?.resolution;
    const values = jsonSchemaEnum(resolution);
    expect(values).toEqual([...RESOLUTION_PRESET_IDS]);
    expect(values).toContain("normal_portrait");
    expect(values).not.toContain("1024x1024");
    expect(values).not.toContain("portrait");
  });
});

describe("MCP tools/list schemas", () => {
  it("advertises resolution enum and outputSchema on every tool", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createNaiMcpServer(testEnv(), "Bearer header-token-xx");
    const client = new Client({ name: "schema-test", version: "0.0.1" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.outputSchema, tool.name).toBeDefined();
        expect(tool.outputSchema?.type, tool.name).toBe("object");
      }

      const generate = tools.find((t) => t.name === "nai_generate_image");
      expect(generate).toBeDefined();
      const resolution = generate?.inputSchema.properties?.resolution;
      const values = jsonSchemaEnum(resolution);
      expect(values).toContain("normal_portrait");
      expect(values).not.toContain("1024x1024");
      expect(values).not.toContain("portrait");
      expect(generate?.outputSchema?.properties).toHaveProperty("image_id");
      expect(generate?.outputSchema?.properties).toHaveProperty("images");
      expect(generate?.outputSchema?.properties).toHaveProperty("seed");
      expect(generate?.outputSchema?.properties).not.toHaveProperty("files");
      for (const name of [
        "nai_generate_image",
        "nai_upscale",
        "nai_director",
        "nai_get_image",
      ]) {
        expect(
          tools.find((tool) => tool.name === name)?._meta,
          name,
        ).toMatchObject({
          ui: { resourceUri: IMAGE_WIDGET_URI },
          "openai/outputTemplate": IMAGE_WIDGET_URI,
        });
      }

      const getImage = tools.find((t) => t.name === "nai_get_image");
      expect(getImage).toBeDefined();
      expect(getImage?.outputSchema?.properties).toHaveProperty("image_id");

      const preview = await client.readResource({ uri: IMAGE_WIDGET_URI });
      expect(preview.contents[0]).toMatchObject({
        uri: IMAGE_WIDGET_URI,
        mimeType: IMAGE_WIDGET_MIME_TYPE,
        text: IMAGE_WIDGET_HTML,
      });
      const previewContent = preview.contents[0];
      const html =
        previewContent && "text" in previewContent ? previewContent.text : "";
      expect(html).toContain("ui/initialize");
      expect(html).toContain("ui/notifications/initialized");
      expect(html).toContain("ui/notifications/tool-result");
      expect(html).toContain("openai:set_globals");
      expect(html).toContain("toolResponseMetadata");
      expect(html).toContain("mcp_tool_result");
      expect(html).toContain("result.isError");
      expect(html).toContain('block.type !== "image"');
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBeDefined();
      expect(() => new Function(script!)).not.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns the same schemas over HTTP with a Bearer token", async () => {
    const env = testEnv();
    const ctx = testExecutionContext();
    const transport = new StreamableHTTPClientTransport(
      new URL("https://nai.hoshinoaya.com/mcp"),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer header-token-xx",
            Host: "nai.hoshinoaya.com",
          },
        },
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          if (!headers.has("Host")) headers.set("Host", "nai.hoshinoaya.com");
          return handleMcp(new Request(input, { ...init, headers }), env, ctx);
        },
      },
    );
    const client = new Client({ name: "http-schema-test", version: "0.0.1" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const generate = tools.find((t) => t.name === "nai_generate_image");
      expect(
        jsonSchemaEnum(generate?.inputSchema.properties?.resolution),
      ).toContain("normal_portrait");
      expect(generate?.outputSchema).toBeDefined();
      expect(generate?._meta).toMatchObject({
        ui: { resourceUri: IMAGE_WIDGET_URI },
        "openai/outputTemplate": IMAGE_WIDGET_URI,
      });
    } finally {
      await client.close();
    }
  });
});
