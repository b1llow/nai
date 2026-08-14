import { describe, expect, it } from "vitest";
import { healthPayload, workerRevision } from "../src/revision";

describe("workerRevision", () => {
  it("accepts full and abbreviated git SHAs", () => {
    expect(workerRevision({ GIT_SHA: "364de92" })).toBe("364de92");
    expect(
      workerRevision({ GIT_SHA: "364de92A1BC5A46BACD9AD29791CBB0E4B85FFBD" }),
    ).toBe("364de92a1bc5a46bacd9ad29791cbb0e4b85ffbd");
  });

  it("rejects missing or non-sha values", () => {
    expect(workerRevision({})).toBeNull();
    expect(workerRevision({ GIT_SHA: "  " })).toBeNull();
    expect(workerRevision({ GIT_SHA: "not-a-sha" })).toBeNull();
    expect(workerRevision({ GIT_SHA: "latest" })).toBeNull();
  });
});

describe("healthPayload", () => {
  it("always includes ok and a revision field", () => {
    expect(healthPayload({})).toEqual({ ok: true, revision: null });
    expect(healthPayload({ GIT_SHA: "abc1234" })).toEqual({
      ok: true,
      revision: "abc1234",
    });
  });
});
