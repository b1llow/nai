import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("scripts/deploy.mjs", () => {
  it("bakes the git SHA with --define and does not replace wrangler vars", () => {
    const source = readFileSync(resolve("scripts/deploy.mjs"), "utf8");
    expect(source).toContain("--define");
    expect(source).toContain("__NAI_REVISION__");
    expect(source).not.toMatch(/--var\b/);
  });
});
