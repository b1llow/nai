import { describe, expect, it } from "vitest";
import { BAKED_REVISION } from "../src/baked-revision";
import { parseRevision } from "../src/revision";
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
    expect(await res.json()).toEqual({
      ok: true,
      revision: parseRevision(BAKED_REVISION),
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
    expect(body.endpoints).toContain("/i/:file");
  });
});
