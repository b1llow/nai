import { openaiError } from "../errors";
import {
  MAX_CHARACTER_PROMPTS,
  MAX_IMAGE_SAMPLES,
  MAX_REFERENCE_IMAGES,
} from "../limits";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RESOLUTION,
  RESOLUTION_PRESETS,
  SAMPLERS,
  align64,
  clampDim,
  inpaintingModel,
  isV4Model,
} from "./catalog";
import { decodeUserImage, clampPrompt } from "./image-input";

export type ImageAction = "generate" | "img2img" | "infill";

export type CharacterPromptInput = {
  prompt: string;
  uc?: string;
  x?: number;
  y?: number;
};

export type ReferenceImageInput = {
  image: string;
  strength?: number;
  information_extracted?: number;
  /** When true, `image` is already an encoded vibe token (base64). */
  encoded?: boolean;
};

export type DirectorReferenceInput = {
  image: string;
  type: "character" | "style" | "character&style";
  strength?: number;
  fidelity?: number;
};

export type GenerateImageInput = {
  prompt: string;
  model?: string;
  action?: ImageAction;
  width?: number;
  height?: number;
  resolution?: string;
  negative_prompt?: string;
  qualityToggle?: boolean;
  ucPreset?: number;
  sampler?: string;
  steps?: number;
  scale?: number;
  seed?: number;
  n_samples?: number;
  noise_schedule?: string;
  character_prompts?: CharacterPromptInput[];
  image?: string;
  mask?: string;
  strength?: number;
  noise?: number;
  add_original_image?: boolean;
  variety_boost?: boolean;
  skip_cfg_above_sigma?: number;
  reference_images?: ReferenceImageInput[];
  director_references?: DirectorReferenceInput[];
  cfg_rescale?: number;
  dynamic_thresholding?: boolean;
  sm?: boolean;
  sm_dyn?: boolean;
};

export type GenerateImageBody = {
  input: string;
  model: string;
  action: ImageAction;
  parameters: Record<string, unknown>;
};

export type PreparedGenerateImage = {
  body: GenerateImageBody;
  seed: number;
  model: string;
  action: ImageAction;
  width: number;
  height: number;
  /** Raw PNG base64 vibes that still need /ai/encode-vibe on V4+. */
  vibesToEncode: Array<{
    index: number;
    image: string;
    information_extracted: number;
  }>;
  /** Parallel arrays already filled; vibe slots at `vibesToEncode` indices are placeholders. */
  referenceImages: string[];
  referenceStrengths: number[];
  referenceExtracted: number[];
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

function resolveSize(input: GenerateImageInput): { width: number; height: number } {
  if (input.width != null || input.height != null) {
    const w = finiteNumber(input.width);
    const h = finiteNumber(input.height);
    if (w === undefined || h === undefined) {
      throw openaiError(400, "width and height must be numbers", {
        type: "invalid_request_error",
        param: "width",
      });
    }
    return { width: clampDim(w), height: clampDim(h) };
  }
  const presetName = input.resolution ?? DEFAULT_RESOLUTION;
  const preset = RESOLUTION_PRESETS[presetName];
  if (!preset) {
    throw openaiError(400, "unknown resolution preset", {
      type: "invalid_request_error",
      param: "resolution",
    });
  }
  return preset;
}

/**
 * Build a NovelAI /ai/generate-image JSON body. Does not call encode-vibe;
 * returns placeholders for V4 vibe images that still need encoding.
 */
export function prepareGenerateImage(input: GenerateImageInput): PreparedGenerateImage {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw openaiError(400, "prompt is required", {
      type: "invalid_request_error",
      param: "prompt",
    });
  }
  const prompt = clampPrompt(input.prompt.trim(), "prompt");
  const negative = clampPrompt(input.negative_prompt?.trim() ?? "", "negative_prompt");
  const action: ImageAction = input.action ?? "generate";
  if (action !== "generate" && action !== "img2img" && action !== "infill") {
    throw openaiError(400, "action must be generate, img2img, or infill", {
      type: "invalid_request_error",
      param: "action",
    });
  }

  let model = (input.model ?? DEFAULT_IMAGE_MODEL).trim();
  if (!model || model.length > 256) {
    throw openaiError(400, "model is invalid", {
      type: "invalid_request_error",
      param: "model",
    });
  }
  if (action === "infill") model = inpaintingModel(model);

  const sampler = input.sampler ?? "k_euler_ancestral";
  if (!(SAMPLERS as readonly string[]).includes(sampler) && sampler.length > 64) {
    throw openaiError(400, "sampler is invalid", {
      type: "invalid_request_error",
      param: "sampler",
    });
  }

  const steps = Math.trunc(clamp(finiteNumber(input.steps) ?? 28, 1, 50));
  const scale = clamp(finiteNumber(input.scale) ?? 5, 0, 20);
  const seed = Math.trunc(
    clamp(finiteNumber(input.seed) ?? randomSeed(), 0, 4_294_967_295),
  );
  const nSamples = Math.trunc(
    clamp(finiteNumber(input.n_samples) ?? 1, 1, MAX_IMAGE_SAMPLES),
  );
  const ucPreset = Math.trunc(clamp(finiteNumber(input.ucPreset) ?? 0, 0, 3));
  const qualityToggle = input.qualityToggle !== false;
  const noiseSchedule = input.noise_schedule ?? "karras";

  let decodedSource: ReturnType<typeof decodeUserImage> | undefined;
  if (action === "img2img" || action === "infill") {
    if (!input.image) {
      throw openaiError(400, "image is required for img2img/infill", {
        type: "invalid_request_error",
        param: "image",
      });
    }
    decodedSource = decodeUserImage(input.image, "image");
  }

  let { width, height } = resolveSize(input);
  if (
    decodedSource?.width &&
    decodedSource.height &&
    input.width == null &&
    input.height == null &&
    input.resolution == null
  ) {
    width = clampDim(decodedSource.width);
    height = clampDim(decodedSource.height);
  }

  const characters = (input.character_prompts ?? []).slice(0, MAX_CHARACTER_PROMPTS);
  if ((input.character_prompts?.length ?? 0) > MAX_CHARACTER_PROMPTS) {
    throw openaiError(400, "too many character_prompts", {
      type: "invalid_request_error",
      param: "character_prompts",
    });
  }
  const charPayload = characters.map((c) => {
    if (typeof c.prompt !== "string" || !c.prompt.trim()) {
      throw openaiError(400, "character prompt is required", {
        type: "invalid_request_error",
        param: "character_prompts",
      });
    }
    const x = clamp(finiteNumber(c.x) ?? 0.5, 0, 1);
    const y = clamp(finiteNumber(c.y) ?? 0.5, 0, 1);
    return {
      prompt: clampPrompt(c.prompt.trim(), "character_prompts"),
      uc: clampPrompt((c.uc ?? "").trim(), "character_prompts"),
      center: { x, y },
      enabled: true,
    };
  });
  const useCoords = characters.some(
    (c) => finiteNumber(c.x) !== undefined || finiteNumber(c.y) !== undefined,
  );

  const parameters: Record<string, unknown> = {
    params_version: 3,
    width,
    height,
    scale,
    sampler,
    steps,
    seed,
    n_samples: nSamples,
    ucPreset,
    qualityToggle,
    autoSmea: false,
    dynamic_thresholding: input.dynamic_thresholding === true,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: input.add_original_image !== false,
    cfg_rescale: clamp(finiteNumber(input.cfg_rescale) ?? 0, 0, 1),
    noise_schedule: noiseSchedule,
    legacy_v3_extend: false,
    skip_cfg_above_sigma: null as number | null,
    use_coords: useCoords,
    legacy_uc: false,
    normalize_reference_strength_multiple: true,
    inpaintImg2ImgStrength: 1,
    negative_prompt: negative,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
    sm: input.sm === true,
    sm_dyn: input.sm_dyn === true,
  };

  if (input.variety_boost === true) {
    parameters.skip_cfg_above_sigma = finiteNumber(input.skip_cfg_above_sigma) ?? 19;
  } else if (finiteNumber(input.skip_cfg_above_sigma) !== undefined) {
    parameters.skip_cfg_above_sigma = input.skip_cfg_above_sigma;
  }

  if (isV4Model(model)) {
    parameters.characterPrompts = charPayload;
    parameters.v4_prompt = {
      caption: {
        base_caption: prompt,
        char_captions: charPayload.map((c) => ({
          char_caption: c.prompt,
          centers: [{ x: c.center.x, y: c.center.y }],
        })),
      },
      use_coords: useCoords,
      use_order: true,
    };
    parameters.v4_negative_prompt = {
      caption: {
        base_caption: negative,
        char_captions: charPayload.map((c) => ({
          char_caption: c.uc,
          centers: [{ x: c.center.x, y: c.center.y }],
        })),
      },
      legacy_uc: false,
    };
  }

  if (decodedSource) {
    parameters.image = decodedSource.base64;
    parameters.strength = clamp(finiteNumber(input.strength) ?? 0.5, 0, 1);
    parameters.noise = clamp(finiteNumber(input.noise) ?? 0, 0, 1);
    parameters.extra_noise_seed = seed;
  }
  if (action === "infill") {
    if (!input.mask) {
      throw openaiError(400, "mask is required for infill", {
        type: "invalid_request_error",
        param: "mask",
      });
    }
    const mask = decodeUserImage(input.mask, "mask");
    parameters.mask = mask.base64;
  }

  const refs = (input.reference_images ?? []).slice(0, MAX_REFERENCE_IMAGES);
  if ((input.reference_images?.length ?? 0) > MAX_REFERENCE_IMAGES) {
    throw openaiError(400, "too many reference_images", {
      type: "invalid_request_error",
      param: "reference_images",
    });
  }
  const referenceImages: string[] = [];
  const referenceStrengths: number[] = [];
  const referenceExtracted: number[] = [];
  const vibesToEncode: PreparedGenerateImage["vibesToEncode"] = [];
  refs.forEach((ref, index) => {
    const extracted = clamp(finiteNumber(ref.information_extracted) ?? 1, 0.01, 1);
    const strength = clamp(finiteNumber(ref.strength) ?? 0.6, 0, 1);
    if (ref.encoded) {
      referenceImages.push(stripKeepB64(ref.image, "reference_images"));
    } else {
      const decoded = decodeUserImage(ref.image, "reference_images");
      if (isV4Model(model) && decoded.isPng) {
        referenceImages.push("");
        vibesToEncode.push({
          index,
          image: decoded.base64,
          information_extracted: extracted,
        });
      } else {
        referenceImages.push(decoded.base64);
      }
    }
    referenceStrengths.push(strength);
    referenceExtracted.push(extracted);
  });
  if (referenceImages.length > 0) {
    parameters.reference_image_multiple = referenceImages;
    parameters.reference_strength_multiple = referenceStrengths;
    parameters.reference_information_extracted_multiple = referenceExtracted;
  }

  const directorRefs = (input.director_references ?? []).slice(
    0,
    MAX_REFERENCE_IMAGES,
  );
  if (directorRefs.length > 0) {
    parameters.director_reference_images = directorRefs.map((d) => {
      const decoded = decodeUserImage(d.image, "director_references");
      return decoded.base64;
    });
    parameters.director_reference_descriptions = directorRefs.map((d) => ({
      caption: {
        base_caption: d.type,
        char_captions: [],
      },
      legacy_uc: false,
    }));
    parameters.director_reference_strength_values = directorRefs.map((d) =>
      clamp(finiteNumber(d.strength) ?? 0.6, 0, 1),
    );
    parameters.director_reference_secondary_strength_values = directorRefs.map(
      (d) => {
        const fidelity = clamp(finiteNumber(d.fidelity) ?? 0.5, 0, 1);
        return clamp(1 - fidelity, 0, 1);
      },
    );
    parameters.director_reference_information_extracted = directorRefs.map(
      () => 1,
    );
  }

  return {
    body: {
      input: prompt,
      model,
      action,
      parameters,
    },
    seed,
    model,
    action,
    width,
    height,
    vibesToEncode,
    referenceImages,
    referenceStrengths,
    referenceExtracted,
  };
}

function stripKeepB64(raw: string, param: string): string {
  const t = raw.trim().replace(/\s+/g, "");
  if (!t) {
    throw openaiError(400, `${param} is required`, {
      type: "invalid_request_error",
      param,
    });
  }
  return t.replace(/^data:[a-zA-Z0-9.+/-]+;base64,/i, "");
}

export function applyEncodedVibes(
  prepared: PreparedGenerateImage,
  encoded: string[],
): GenerateImageBody {
  if (encoded.length !== prepared.vibesToEncode.length) {
    throw openaiError(500, "Server misconfigured", {
      type: "api_error",
      code: "internal_error",
    });
  }
  const images = prepared.referenceImages.slice();
  prepared.vibesToEncode.forEach((slot, i) => {
    images[slot.index] = encoded[i]!;
  });
  const parameters = {
    ...prepared.body.parameters,
    reference_image_multiple: images,
    reference_strength_multiple: prepared.referenceStrengths,
    reference_information_extracted_multiple: prepared.referenceExtracted,
  };
  return { ...prepared.body, parameters };
}
