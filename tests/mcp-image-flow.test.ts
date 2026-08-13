import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNaiMcpServer } from "../src/mcp/server";
import { base64ToBytes } from "../src/nai/binary";
import { testEnv } from "./helpers";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = base64ToBytes(PNG_1X1);
const AUTH = "Bearer header-token-xx";

function pngZip(): Uint8Array {
  return zipSync({ "image_0.png": PNG_BYTES });
}

function jsonBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

async function connectedClient(env = testEnv()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createNaiMcpServer(env, AUTH);
  const client = new Client({ name: "image-flow-test", version: "0.0.1" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server, env };
}

describe("MCP image_id flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generate → upscale uses image_id and does not send a filename", async () => {
    const fetches: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetches.push(url);
        if (url.includes("/ai/generate-image") && !url.includes("suggest")) {
          return new Response(pngZip(), {
            headers: { "content-type": "application/zip" },
          });
        }
        if (url.includes("/ai/upscale")) {
          const body = jsonBody(init);
          expect(body.image).toBe(PNG_1X1);
          expect(body.image).not.toBe("image_0.png");
          return new Response(pngZip(), {
            headers: { "content-type": "application/zip" },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const { client, server } = await connectedClient();
    try {
      const generated = await client.callTool({
        name: "nai_generate_image",
        arguments: { prompt: "1girl", seed: 1 },
      });
      const gen = generated.structuredContent as {
        image_id: string;
        images: Array<{ filename: string }>;
        files?: unknown;
      };
      expect(generated.isError).not.toBe(true);
      expect(gen.files).toBeUndefined();
      expect(gen.image_id).toMatch(/^img_[a-f0-9]{32}$/);
      expect(gen.images[0]?.filename).toBe("image_0.png");

      const upscaled = await client.callTool({
        name: "nai_upscale",
        arguments: { image: gen.image_id },
      });
      const up = upscaled.structuredContent as { image_id: string };
      expect(upscaled.isError).not.toBe(true);
      expect(up.image_id).toMatch(/^img_[a-f0-9]{32}$/);
      expect(up.image_id).not.toBe(gen.image_id);
      expect(fetches.some((u) => u.includes("/ai/upscale"))).toBe(true);

      const reloaded = await client.callTool({
        name: "nai_get_image",
        arguments: { image_id: gen.image_id },
      });
      expect(reloaded.isError).not.toBe(true);
      const got = reloaded.structuredContent as { image_id: string };
      expect(got.image_id).toBe(gen.image_id);

      const resource = await client.readResource({
        uri: `nai://image/${gen.image_id}`,
      });
      expect(resource.contents[0]).toMatchObject({
        mimeType: "image/png",
        blob: PNG_1X1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("caches encode-vibe across two generate calls with the same PNG ref", async () => {
    let encodeCalls = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/ai/encode-vibe")) {
          encodeCalls += 1;
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (url.includes("/ai/generate-image") && !url.includes("suggest")) {
          return new Response(pngZip(), {
            headers: { "content-type": "application/zip" },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const { client, server } = await connectedClient();
    try {
      const args = {
        prompt: "landscape",
        seed: 9,
        reference_images: [{ image: PNG_1X1, strength: 0.7 }],
      };
      const first = await client.callTool({
        name: "nai_generate_image",
        arguments: args,
      });
      const second = await client.callTool({
        name: "nai_generate_image",
        arguments: args,
      });
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(encodeCalls).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
