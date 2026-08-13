export const DEFAULT_IMAGE_MODEL = "nai-diffusion-4-5-full";
export const DEFAULT_TEXT_MODEL = "xialong-v1";
export const DEFAULT_STORY_MODEL = "llama-3-erato-v1";

export type ImageModelInfo = {
  id: string;
  label: string;
  inpainting: string;
  v4: boolean;
};

export const IMAGE_MODELS: ImageModelInfo[] = [
  {
    id: "nai-diffusion-4-5-full",
    label: "V4.5 Full",
    inpainting: "nai-diffusion-4-5-full-inpainting",
    v4: true,
  },
  {
    id: "nai-diffusion-4-5-curated",
    label: "V4.5 Curated",
    inpainting: "nai-diffusion-4-5-curated-inpainting",
    v4: true,
  },
  {
    id: "nai-diffusion-4-full",
    label: "V4 Full",
    inpainting: "nai-diffusion-4-full-inpainting",
    v4: true,
  },
  {
    id: "nai-diffusion-4-curated-preview",
    label: "V4 Curated",
    inpainting: "nai-diffusion-4-curated-inpainting",
    v4: true,
  },
  {
    id: "nai-diffusion-3",
    label: "V3 Anime",
    inpainting: "nai-diffusion-3-inpainting",
    v4: false,
  },
  {
    id: "nai-diffusion-furry-3",
    label: "Furry V3",
    inpainting: "nai-diffusion-furry-3-inpainting",
    v4: false,
  },
];

export const RESOLUTION_PRESETS: Record<string, { width: number; height: number }> =
  {
    small_portrait: { width: 512, height: 768 },
    small_landscape: { width: 768, height: 512 },
    small_square: { width: 640, height: 640 },
    normal_portrait: { width: 832, height: 1216 },
    normal_landscape: { width: 1216, height: 832 },
    normal_square: { width: 1024, height: 1024 },
    large_portrait: { width: 1024, height: 1536 },
    large_landscape: { width: 1536, height: 1024 },
    large_square: { width: 1472, height: 1472 },
    wallpaper_portrait: { width: 1088, height: 1920 },
    wallpaper_landscape: { width: 1920, height: 1088 },
  };

export const DEFAULT_RESOLUTION = "normal_portrait";

export const SAMPLERS = [
  "k_euler_ancestral",
  "k_euler",
  "k_dpmpp_2s_ancestral",
  "k_dpmpp_2m",
  "k_dpmpp_sde",
  "k_dpmpp_2m_sde",
  "ddim_v3",
] as const;

export const NOISE_SCHEDULES = [
  "karras",
  "native",
  "exponential",
  "polyexponential",
] as const;

export const UC_PRESETS = [
  { id: 0, label: "Heavy" },
  { id: 1, label: "Light" },
  { id: 2, label: "None" },
  { id: 3, label: "Human Focus" },
] as const;

export const DIRECTOR_TYPES = [
  "lineart",
  "sketch",
  "colorize",
  "emotion",
  "declutter",
  "bg-removal",
] as const;

export const EMOTIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "scared",
  "surprised",
  "tired",
  "excited",
  "nervous",
  "thinking",
  "confused",
  "smug",
  "amused",
  "embarrassed",
  "aroused",
  "annoyed",
  "proud",
  "panicked",
  "crying",
  "determined",
  "shy",
  "disgusted",
  "bored",
  "relieved",
] as const;

export const DIRECTOR_REFERENCE_TYPES = [
  "character",
  "style",
  "character&style",
] as const;

export function isV4Model(model: string): boolean {
  return /nai-diffusion-4/.test(model);
}

export function inpaintingModel(model: string): string {
  if (model.includes("inpainting")) return model;
  const known = IMAGE_MODELS.find((m) => m.id === model);
  if (known) return known.inpainting;
  return `${model}-inpainting`;
}

export function align64(n: number): number {
  return Math.max(64, Math.floor(n / 64) * 64);
}

export function clampDim(n: number): number {
  return Math.min(1920, align64(n));
}
