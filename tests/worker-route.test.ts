import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { testEnv, testExecutionContext } from "./helpers";

const env = testEnv();
const ctx = testExecutionContext();

describe("worker fetch routing", () => {
  it("serves Hono health on /health", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/health"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, revision: null });
  });

  it("exposes GIT_SHA on /health as revision", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/health"),
      testEnv({ GIT_SHA: "364de92a1bc5a46bacd9ad29791cbb0e4b85ffbd" }),
      ctx,
    );
    expect(await res.json()).toEqual({
      ok: true,
      revision: "364de92a1bc5a46bacd9ad29791cbb0e4b85ffbd",
    });
  });

  it("lists /mcp on the root info document", async () => {
    const res = await worker.fetch(
      new Request("https://nai.hoshinoaya.com/"),
      env,
      ctx,
    );
    const body = (await res.json()) as { endpoints?: string[] };
    expect(body.endpoints).toContain("/mcp");
    expect(body.endpoints).toContain("/authorize");
  });
});
