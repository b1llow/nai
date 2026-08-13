import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/limits";
import app from "../src/app";

const env = { NAI_BASE_URL: "https://text.novelai.net" };

describe("app security gates", () => {
  it("rejects missing or short Authorization on /v1", async () => {
    const missing = await app.request("/v1/models", {}, env);
    expect(missing.status).toBe(401);

    const short = await app.request(
      "/v1/models",
      { headers: { Authorization: "Bearer x" } },
      env,
    );
    expect(short.status).toBe(401);
  });

  it("rejects oversized POST bodies", async () => {
    const res = await app.request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer faketoken",
          "Content-Type": "application/json",
        },
        body: "x".repeat(MAX_BODY_BYTES + 16),
      },
      env,
    );
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toMatch(/too large/i);
  });

  it("sets private no-store on authenticated-route errors", async () => {
    const res = await app.request("/v1/models", {}, env);
    expect(res.headers.get("Cache-Control")).toMatch(/private/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not require auth on health", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
  });
});
