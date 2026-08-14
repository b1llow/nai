import { describe, expect, it } from "vitest";
import { healthPayload, parseRevision, workerRevision } from "../src/revision";

describe("parseRevision", () => {
  it("accepts full and abbreviated git SHAs", () => {
    expect(parseRevision("364de92")).toBe("364de92");
    expect(parseRevision("364de92A1BC5A46BACD9AD29791CBB0E4B85FFBD")).toBe(
      "364de92a1bc5a46bacd9ad29791cbb0e4b85ffbd",
    );
  });

  it("rejects missing or non-sha values", () => {
    expect(parseRevision(undefined)).toBeNull();
    expect(parseRevision("  ")).toBeNull();
    expect(parseRevision("not-a-sha")).toBeNull();
    expect(parseRevision("latest")).toBeNull();
  });
});

describe("healthPayload", () => {
  it("returns a null revision when wrangler did not --define one", () => {
    expect(workerRevision()).toBeNull();
    expect(healthPayload()).toEqual({ ok: true, revision: null });
  });
});
