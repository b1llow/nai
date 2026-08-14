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

  it("sends the vibe_id stored information_extracted to generate-image", async () => {
    let generateBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/ai/encode-vibe")) {
          return new Response(new Uint8Array([9, 8, 7, 6]), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (url.includes("/ai/generate-image") && !url.includes("suggest")) {
          generateBody = jsonBody(init);
          return new Response(pngZip(), {
            headers: { "content-type": "application/zip" },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const { client, server } = await connectedClient();
    try {
      const encoded = await client.callTool({
        name: "nai_encode_vibe",
        arguments: { image: PNG_1X1, information_extracted: 0.42 },
      });
      expect(encoded.isError).not.toBe(true);
      const vibeId = (encoded.structuredContent as { vibe_id: string }).vibe_id;
      expect(vibeId).toMatch(/^vibe_[a-f0-9]{32}$/);

      const generated = await client.callTool({
        name: "nai_generate_image",
        arguments: {
          prompt: "landscape",
          seed: 3,
          reference_images: [{ image: vibeId, strength: 0.7 }],
        },
      });
      expect(generated.isError).not.toBe(true);
      const parameters = generateBody.parameters as {
        reference_information_extracted_multiple?: number[];
      };
      expect(parameters.reference_information_extracted_multiple).toEqual([0.42]);

      const conflict = await client.callTool({
        name: "nai_generate_image",
        arguments: {
          prompt: "landscape",
          seed: 4,
          reference_images: [
            { image: vibeId, strength: 0.7, information_extracted: 0.9 },
          ],
        },
      });
      expect(conflict.isError).toBe(true);
      const conflictText = (conflict.content[0] as { text?: string }).text ?? "";
      expect(conflictText).toMatch(/does not match vibe_id/);

      const wrongModel = await client.callTool({
        name: "nai_generate_image",
        arguments: {
          prompt: "landscape",
          seed: 5,
          model: "nai-diffusion-4-full",
          reference_images: [{ image: vibeId, strength: 0.7 }],
        },
      });
      expect(wrongModel.isError).toBe(true);
      const modelText = (wrongModel.content[0] as { text?: string }).text ?? "";
      expect(modelText).toMatch(/encoded for nai-diffusion-4-5-full/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("errors when vibe_id cannot be stored after encode", async () => {
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/ai/encode-vibe")) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );

    const env = testEnv();
    const origPut = env.OAUTH_KV.put.bind(env.OAUTH_KV);
    env.OAUTH_KV.put = (async (key, value, opts) => {
      if (String(key).startsWith("vibe:vibe_")) {
        throw new Error("kv write failed");
      }
      return origPut(key, value, opts);
    }) as typeof env.OAUTH_KV.put;

    const { client, server } = await connectedClient(env);
    try {
      const encoded = await client.callTool({
        name: "nai_encode_vibe",
        arguments: { image: PNG_1X1 },
      });
      expect(encoded.isError).toBe(true);
      const text = (encoded.content[0] as { text?: string }).text ?? "";
      expect(text).toMatch(/vibe_id could not be stored/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns resource-not-found for a missing image_id", async () => {
    const { client, server } = await connectedClient();
    try {
      const missing = "img_" + "11".repeat(16);
      try {
        await client.readResource({ uri: `nai://image/${missing}` });
        throw new Error("expected readResource to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/not found or has expired/);
        expect((err as { code?: number }).code).not.toBe(-32603);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
