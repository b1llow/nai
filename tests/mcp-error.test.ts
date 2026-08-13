import { describe, expect, it, vi } from "vitest";
import { openaiError } from "../src/errors";
import { mcpError } from "../src/mcp/result";

describe("mcpError", () => {
  it("returns client HttpError text without logging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = mcpError(openaiError(400, "image is required", { param: "image" }));
      expect(out.isError).toBe(true);
      expect(out.content[0]).toEqual({ type: "text", text: "image is required" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("logs unexpected throws and hides internals from the tool result", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      if (typeof msg === "string") lines.push(msg);
    });
    const out = mcpError(new Error("db exploded"));
    spy.mockRestore();
    expect(out.isError).toBe(true);
    expect(out.content[0]).toEqual({ type: "text", text: "Internal Server Error" });
    expect(JSON.parse(lines[0]!)).toEqual({
      message: "unhandled mcp tool error",
      error: "db exploded",
    });
  });
});
