import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("deploy scripts", () => {
  it("stamps the git SHA into source instead of replacing wrangler vars", () => {
    const deploy = readFileSync(resolve("scripts/deploy.mjs"), "utf8");
    const stamp = readFileSync(resolve("scripts/stamp-revision.mjs"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.postinstall).toBe("node scripts/stamp-revision.mjs");
    expect(deploy).toContain("stampRevision");
    expect(deploy).not.toMatch(/--var\b/);
    expect(deploy).not.toMatch(/--define\b/);
    expect(stamp).toContain("WORKERS_CI_COMMIT_SHA");
    expect(stamp).toContain("git rev-parse HEAD");
    expect(stamp).toContain("src/baked-revision.ts");
  });
});
