import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { base64ToBytes, bytesToBase64, isPng, pngSize } from "../src/nai/binary";
import { extractPngs } from "../src/nai/zip";

const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("png + zip extraction", () => {
  it("reads IHDR width and height", () => {
    const bytes = base64ToBytes(PNG_1X1_B64);
    expect(isPng(bytes)).toBe(true);
    expect(pngSize(bytes)).toEqual({ width: 1, height: 1 });
  });

  it("returns a raw PNG as a single file", () => {
    const bytes = base64ToBytes(PNG_1X1_B64);
    const files = extractPngs(bytes);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("image_0.png");
  });

  it("round-trips bytes through base64 including subarray views", () => {
    const bytes = base64ToBytes(PNG_1X1_B64);
    expect(bytesToBase64(bytes)).toBe(PNG_1X1_B64);
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 2);
    expect(bytesToBase64(padded.subarray(2, 2 + bytes.length))).toBe(PNG_1X1_B64);
  });

  it("rejects invalid base64 alphabets", () => {
    expect(() => base64ToBytes("!!!!")).toThrow(/invalid base64/i);
  });

  it("unzips NovelAI-style image_0.png archives", () => {
    const png = base64ToBytes(PNG_1X1_B64);
    const zip = zipSync({ "image_0.png": png });
    const files = extractPngs(zip);
    expect(files.map((f) => f.name)).toEqual(["image_0.png"]);
    expect(Array.from(files[0]!.bytes)).toEqual(Array.from(png));
  });
});
