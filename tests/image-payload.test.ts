import { describe, expect, it } from "vitest";
import { prepareGenerateImage } from "../src/nai/image-payload";
import { HttpError } from "../src/errors";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("prepareGenerateImage", () => {
  it("builds a V4.5 txt2img payload with v4_prompt", () => {
    const prepared = prepareGenerateImage({
      prompt: "1girl, solo, portrait",
      seed: 42,
      n_samples: 1,
    });
    expect(prepared.body.model).toBe("nai-diffusion-4-5-full");
    expect(prepared.body.action).toBe("generate");
    expect(prepared.body.input).toBe("1girl, solo, portrait");
    expect(prepared.width).toBe(832);
    expect(prepared.height).toBe(1216);
    expect(prepared.seed).toBe(42);
    const p = prepared.body.parameters;
    expect(p.params_version).toBe(3);
    expect(p.sampler).toBe("k_euler_ancestral");
    expect(p.steps).toBe(28);
    expect(p.qualityToggle).toBe(true);
    expect(p.v4_prompt).toEqual({
      caption: {
        base_caption: "1girl, solo, portrait",
        char_captions: [],
      },
      use_coords: false,
      use_order: true,
    });
    expect(p.v4_negative_prompt).toMatchObject({
      caption: { base_caption: "", char_captions: [] },
    });
  });

  it("assembles multi-character captions and coordinates", () => {
    const prepared = prepareGenerateImage({
      prompt: "2girls, park",
      seed: 1,
      character_prompts: [
        { prompt: "blonde hair", uc: "red hair", x: 0.3, y: 0.5 },
        { prompt: "black hair", x: 0.7, y: 0.5 },
      ],
    });
    const p = prepared.body.parameters;
    expect(p.use_coords).toBe(true);
    expect(p.characterPrompts).toEqual([
      {
        prompt: "blonde hair",
        uc: "red hair",
        center: { x: 0.3, y: 0.5 },
        enabled: true,
      },
      {
        prompt: "black hair",
        uc: "",
        center: { x: 0.7, y: 0.5 },
        enabled: true,
      },
    ]);
    const v4 = p.v4_prompt as {
      caption: { char_captions: Array<{ char_caption: string }> };
    };
    expect(v4.caption.char_captions.map((c) => c.char_caption)).toEqual([
      "blonde hair",
      "black hair",
    ]);
  });

  it("builds img2img with source image and strength", () => {
    const prepared = prepareGenerateImage({
      prompt: "fantasy outfit",
      action: "img2img",
      image: PNG_1X1,
      seed: 7,
      strength: 0.4,
      noise: 0.1,
    });
    expect(prepared.body.action).toBe("img2img");
    expect(prepared.body.parameters.image).toBe(PNG_1X1);
    expect(prepared.body.parameters.strength).toBe(0.4);
    expect(prepared.body.parameters.noise).toBe(0.1);
    expect(prepared.width).toBe(64);
    expect(prepared.height).toBe(64);
  });

  it("switches to an inpainting model on infill", () => {
    const prepared = prepareGenerateImage({
      prompt: "detailed background",
      action: "infill",
      image: PNG_1X1,
      mask: PNG_1X1,
      seed: 3,
      width: 832,
      height: 1216,
    });
    expect(prepared.model).toBe("nai-diffusion-4-5-full-inpainting");
    expect(prepared.body.parameters.mask).toBe(PNG_1X1);
  });

  it("queues V4 PNG vibes for encode-vibe", () => {
    const prepared = prepareGenerateImage({
      prompt: "landscape",
      seed: 9,
      reference_images: [{ image: PNG_1X1, strength: 0.7 }],
    });
    expect(prepared.vibesToEncode).toHaveLength(1);
    expect(prepared.vibesToEncode[0]?.index).toBe(0);
    expect(prepared.referenceImages[0]).toBe("");
    expect(prepared.body.parameters.reference_strength_multiple).toEqual([0.7]);
  });

  it("rejects missing prompt and missing img2img image", () => {
    expect(() => prepareGenerateImage({ prompt: "" })).toThrow(HttpError);
    expect(() =>
      prepareGenerateImage({ prompt: "x", action: "img2img" }),
    ).toThrow(/image is required/);
  });

  it("rejects unknown resolution presets such as 1024x1024 or portrait", () => {
    expect(() =>
      prepareGenerateImage({ prompt: "1girl", resolution: "1024x1024" }),
    ).toThrow(/unknown resolution preset/);
    expect(() =>
      prepareGenerateImage({ prompt: "1girl", resolution: "portrait" }),
    ).toThrow(/unknown resolution preset/);
  });

  it("rejects width without height", () => {
    expect(() =>
      prepareGenerateImage({ prompt: "1girl", width: 1024 }),
    ).toThrow(/width and height must be numbers/);
  });

  it("uses a named preset for size", () => {
    const prepared = prepareGenerateImage({
      prompt: "1girl",
      resolution: "normal_square",
      seed: 1,
    });
    expect(prepared.width).toBe(1024);
    expect(prepared.height).toBe(1024);
  });

  it("lets numeric width and height override the preset", () => {
    const prepared = prepareGenerateImage({
      prompt: "1girl",
      resolution: "small_portrait",
      width: 1024,
      height: 1024,
      seed: 1,
    });
    expect(prepared.width).toBe(1024);
    expect(prepared.height).toBe(1024);
  });

  it("rejects more than four director_references instead of truncating", () => {
    const refs = Array.from({ length: 5 }, () => ({
      image: PNG_1X1,
      type: "character" as const,
    }));
    expect(() =>
      prepareGenerateImage({ prompt: "1girl", director_references: refs }),
    ).toThrow(/too many director_references/);
  });
});
