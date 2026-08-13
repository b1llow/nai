import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

const env = {
  NAI_BASE_URL: "https://text.novelai.net",
  NAI_IMAGE_BASE_URL: "https://image.novelai.net",
  NAI_API_BASE_URL: "https://api.novelai.net",
} as Env;

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe("worker fetch routing", () => {
  it("serves Hono health on /health", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/health"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("lists /mcp on the root info document", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/"),
      env,
      ctx,
    );
    const body = (await res.json()) as { endpoints?: string[] };
    expect(body.endpoints).toContain("/mcp");
  });
});
