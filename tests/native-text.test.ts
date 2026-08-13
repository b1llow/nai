import { describe, expect, it } from "vitest";
import { HttpError } from "../src/errors";
import { generateNativeText } from "../src/nai/text";
import { testEnv } from "./helpers";

describe("generateNativeText", () => {
  it("rejects min_length greater than max_length", async () => {
    try {
      await generateNativeText(testEnv(), "Bearer faketokenxxxxxxxx", {
        input: "Once upon a time",
        min_length: 80,
        max_length: 20,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).param).toBe("min_length");
    }
  });
});
