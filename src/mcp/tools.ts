import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env";
import { sanitizeChatBody, runChatCompletion } from "../chat";
import { fetchModels } from "../models";
import { runTokenCount } from "../tokenize";
import { getSubscription } from "../nai/account";
import { runDirector, upscaleImage } from "../nai/augment";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_RESOLUTION,
  DEFAULT_STORY_MODEL,
  DEFAULT_TEXT_MODEL,
  DIRECTOR_REFERENCE_TYPES,
  DIRECTOR_TYPES,
  EMOTIONS,
  IMAGE_MODELS,
  NOISE_SCHEDULES,
  RESOLUTION_PRESET_IDS,
  RESOLUTION_PRESETS,
  SAMPLERS,
  UC_PRESETS,
  resolutionPresetDescribe,
} from "../nai/catalog";
import { encodeVibe, generateImage, suggestTags } from "../nai/image";
import { decodeUserImage } from "../nai/image-input";
import { generateNativeText } from "../nai/text";
import { generateVoice } from "../nai/voice";
import { mcpJson, mcpText, runTool, withImages } from "./result";

const pixelDim = z
  .number()
  .int()
  .multipleOf(64)
  .min(64)
  .max(1920)
  .describe(
    "Pixels, multiple of 64, 64–1920. Pair with the other dimension. If set, overrides resolution. Do not put size in the resolution field.",
  );

const characterPromptSchema = z.object({
  prompt: z.string(),
  uc: z.string().optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});

const referenceImageSchema = z.object({
  image: z.string().describe("PNG base64, data URL, or pre-encoded vibe token"),
  strength: z.number().min(0).max(1).optional(),
  information_extracted: z.number().min(0.01).max(1).optional(),
  encoded: z.boolean().optional(),
});

const directorReferenceSchema = z.object({
  image: z.string(),
  type: z.enum(DIRECTOR_REFERENCE_TYPES),
  strength: z.number().min(0).max(1).optional(),
  fidelity: z.number().min(0).max(1).optional(),
});

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const naiGenerateImageInputSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  action: z.enum(["generate", "img2img", "infill"]).optional(),
  resolution: z.enum(RESOLUTION_PRESET_IDS).optional().describe(resolutionPresetDescribe()),
  width: pixelDim.optional(),
  height: pixelDim.optional(),
  negative_prompt: z.string().optional(),
  qualityToggle: z.boolean().optional(),
  ucPreset: z.number().int().min(0).max(3).optional(),
  sampler: z.enum(SAMPLERS).optional(),
  steps: z.number().int().optional(),
  scale: z.number().optional(),
  seed: z.number().int().optional(),
  n_samples: z.number().int().min(1).max(4).optional(),
  noise_schedule: z.enum(NOISE_SCHEDULES).optional(),
  character_prompts: z.array(characterPromptSchema).optional(),
  image: z.string().optional().describe("Source PNG base64 for img2img/infill"),
  mask: z.string().optional().describe("Inpaint mask PNG base64 (white = edit)"),
  strength: z.number().min(0).max(1).optional(),
  noise: z.number().min(0).max(1).optional(),
  add_original_image: z.boolean().optional(),
  variety_boost: z.boolean().optional(),
  skip_cfg_above_sigma: z.number().optional(),
  reference_images: z.array(referenceImageSchema).optional(),
  director_references: z.array(directorReferenceSchema).optional(),
  cfg_rescale: z.number().min(0).max(1).optional(),
  dynamic_thresholding: z.boolean().optional(),
  sm: z.boolean().optional(),
  sm_dyn: z.boolean().optional(),
});

const imageMetaOutputSchema = z.object({
  seed: z.number(),
  model: z.string(),
  action: z.string(),
  width: z.number(),
  height: z.number(),
  files: z.array(z.string()),
});

const filesMetaOutputSchema = z.object({
  files: z.array(z.string()),
});

const upscaleOutputSchema = filesMetaOutputSchema.extend({
  scale: z.union([z.literal(2), z.literal(4)]),
});

const directorOutputSchema = filesMetaOutputSchema.extend({
  req_type: z.string(),
});

const tagsOutputSchema = z.object({
  tags: z.unknown(),
});

const vibeOutputSchema = z.object({
  vibe: z.string(),
  model: z.string(),
  information_extracted: z.number(),
});

const textOutputSchema = z.object({
  text: z.string(),
});

const tokenizeOutputSchema = z.looseObject({
  token_count: z.number(),
});

const voiceOutputSchema = z.object({
  voice: z.string(),
  version: z.enum(["v1", "v2"]),
  mimeType: z.string(),
});

const subscriptionOutputSchema = z.record(z.string(), z.unknown());

const modelsOutputSchema = z.object({
  kind: z.enum(["text", "image"]),
  items: z.array(z.unknown()),
});

export function registerNaiTools(
  server: McpServer,
  env: Env,
  auth: string | null,
): void {
  server.registerTool(
    "nai_generate_image",
    {
      title: "Generate image",
      description:
        "NovelAI Diffusion image generation (txt2img, img2img, inpaint). Default model is nai-diffusion-4-5-full. Size: pass resolution as a preset name such as normal_portrait, or numeric width+height; never 1024x1024 or portrait. V4+ character prompts, vibe transfer (PNG refs are auto-encoded via /ai/encode-vibe, costing Anlas), and director references are supported. Returns PNG images plus seed/model metadata.",
      inputSchema: naiGenerateImageInputSchema,
      outputSchema: imageMetaOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const result = await generateImage(env, token, args);
        return withImages(
          {
            seed: result.seed,
            model: result.model,
            action: result.action,
            width: result.width,
            height: result.height,
            files: result.images.map((i) => i.name),
          },
          result.images,
        );
      }),
  );

  server.registerTool(
    "nai_upscale",
    {
      title: "Upscale image",
      description: "NovelAI 2x or 4x upscale. Costs Anlas. Image is PNG base64.",
      inputSchema: z.object({
        image: z.string(),
        scale: z.union([z.literal(2), z.literal(4)]).optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
      }),
      outputSchema: upscaleOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const images = await upscaleImage(env, token, args);
        return withImages(
          {
            scale: args.scale === 4 ? 4 : 2,
            files: images.map((i) => i.name),
          },
          images,
        );
      }),
  );

  server.registerTool(
    "nai_director",
    {
      title: "Director tools",
      description:
        "NovelAI Director Tools: lineart, sketch, colorize, emotion, declutter, bg-removal. Width/height default from the PNG IHDR.",
      inputSchema: z.object({
        req_type: z.enum(DIRECTOR_TYPES),
        image: z.string(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        prompt: z.string().optional(),
        defry: z.number().int().min(0).max(5).optional(),
        emotion: z.enum(EMOTIONS).optional(),
        emotion_level: z.number().int().min(0).max(5).optional(),
      }),
      outputSchema: directorOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const images = await runDirector(env, token, args);
        return withImages(
          {
            req_type: args.req_type,
            files: images.map((i) => i.name),
          },
          images,
        );
      }),
  );

  server.registerTool(
    "nai_suggest_tags",
    {
      title: "Suggest tags",
      description: "Autocomplete Danbooru-style tags from a partial prompt.",
      inputSchema: z.object({
        prompt: z.string(),
        model: z.string().optional(),
      }),
      outputSchema: tagsOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) =>
        mcpJson({ tags: await suggestTags(env, token, args) }),
      ),
  );

  server.registerTool(
    "nai_encode_vibe",
    {
      title: "Encode vibe",
      description:
        "Encode a PNG into a V4+ vibe token (2 Anlas per unique encode). Pass the result to nai_generate_image reference_images with encoded=true to avoid re-encoding.",
      inputSchema: z.object({
        image: z.string(),
        model: z.string().optional(),
        information_extracted: z.number().min(0.01).max(1).optional(),
      }),
      outputSchema: vibeOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const decoded = decodeUserImage(args.image, "image");
        const tokenB64 = await encodeVibe(env, token, {
          image: decoded.base64,
          model: args.model ?? DEFAULT_IMAGE_MODEL,
          information_extracted: args.information_extracted,
        });
        return mcpJson({
          vibe: tokenB64,
          model: args.model ?? DEFAULT_IMAGE_MODEL,
          information_extracted: args.information_extracted ?? 1,
        });
      }),
  );

  server.registerTool(
    "nai_chat",
    {
      title: "Chat completion",
      description:
        "NovelAI OpenAI-compatible chat (xialong-v1, glm-4-6, …). Provide prompt or messages. Non-streaming; the worker aggregates upstream SSE.",
      inputSchema: z.object({
        model: z.string().optional(),
        prompt: z.string().optional(),
        messages: z.array(chatMessageSchema).optional(),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        max_tokens: z.number().int().optional(),
        enable_thinking: z.boolean().optional(),
      }),
      outputSchema: textOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const messages =
          args.messages ??
          (args.prompt
            ? [{ role: "user", content: args.prompt }]
            : undefined);
        const { body } = sanitizeChatBody({
          model: args.model ?? DEFAULT_TEXT_MODEL,
          messages,
          temperature: args.temperature,
          top_p: args.top_p,
          max_tokens: args.max_tokens,
          enable_thinking: args.enable_thinking,
        });
        const result = await runChatCompletion(env, token, body, {
          stream: false,
        });
        if (result.kind !== "json") {
          return { ...mcpText("Unexpected streaming response"), isError: true };
        }
        const text = result.completion.choices[0]?.message.content ?? "";
        return mcpJson({ text });
      }),
  );

  server.registerTool(
    "nai_generate_text",
    {
      title: "Story text generation",
      description:
        "Native NovelAI /ai/generate story continuation (Erato, Kayra, Clio). Plain text in, plain text out.",
      inputSchema: z.object({
        input: z.string(),
        model: z.string().optional(),
        max_length: z.number().int().optional(),
        min_length: z.number().int().optional(),
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        top_k: z.number().int().optional(),
        top_a: z.number().optional(),
        typical_p: z.number().optional(),
        repetition_penalty: z.number().optional(),
        generate_until_sentence: z.boolean().optional(),
        seed: z.number().int().optional(),
      }),
      outputSchema: textOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const result = await generateNativeText(env, token, args);
        return mcpJson({ text: result.text });
      }),
  );

  server.registerTool(
    "nai_tokenize",
    {
      title: "Token count",
      description: "Count tokens for a NovelAI text model.",
      inputSchema: z.object({
        model: z.string().optional(),
        prompt: z.string().optional(),
        messages: z.array(chatMessageSchema).optional(),
      }),
      outputSchema: tokenizeOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) =>
        mcpJson(
          await runTokenCount(env, token, {
            model: args.model ?? DEFAULT_TEXT_MODEL,
            prompt: args.prompt,
            messages: args.messages,
          }),
        ),
      ),
  );

  server.registerTool(
    "nai_generate_voice",
    {
      title: "Text to speech",
      description:
        "NovelAI TTS (v2). voice is a seed/name such as Aini. opus=true returns WebM, false returns MP3.",
      inputSchema: z.object({
        text: z.string(),
        voice: z.string().optional(),
        version: z.enum(["v1", "v2"]).optional(),
        opus: z.boolean().optional(),
      }),
      outputSchema: voiceOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const audio = await generateVoice(env, token, args);
        const voice = args.voice ?? "Aini";
        const version = args.version ?? "v2";
        const structuredContent = {
          voice,
          version,
          mimeType: audio.mimeType,
        };
        return {
          content: [
            { type: "text", text: JSON.stringify(structuredContent) },
            { type: "audio", data: audio.base64, mimeType: audio.mimeType },
          ],
          structuredContent,
        };
      }),
  );

  server.registerTool(
    "nai_subscription",
    {
      title: "Subscription",
      description: "NovelAI subscription tier and remaining Anlas/priority (safe fields only).",
      inputSchema: z.object({}),
      outputSchema: subscriptionOutputSchema,
    },
    async () =>
      runTool(auth, async (token) => mcpJson(await getSubscription(env, token))),
  );

  server.registerTool(
    "nai_list_models",
    {
      title: "List models",
      description:
        "List models. Default kind is text (upstream /oa/v1/models, with static fallback). Pass kind=image for the static Diffusion catalog.",
      inputSchema: z.object({
        kind: z.enum(["text", "image"]).optional(),
      }),
      outputSchema: modelsOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        if (args.kind === "image") {
          return mcpJson({ kind: "image" as const, items: IMAGE_MODELS });
        }
        const models = await fetchModels(env, token);
        return mcpJson({ kind: "text" as const, items: models });
      }),
  );

  server.registerResource(
    "image-models",
    "nai://catalog/image-models",
    {
      title: "Image models",
      description: "NovelAI Diffusion model ids including inpainting variants",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(IMAGE_MODELS, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "resolutions",
    "nai://catalog/resolutions",
    {
      title: "Resolution presets",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(RESOLUTION_PRESETS, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "samplers",
    "nai://catalog/samplers",
    {
      title: "Samplers and noise schedules",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ samplers: SAMPLERS, noise_schedules: NOISE_SCHEDULES }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "uc-presets",
    "nai://catalog/uc-presets",
    {
      title: "Undesired-content presets",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(UC_PRESETS, null, 2),
        },
      ],
    }),
  );

  server.registerPrompt(
    "txt2img_v45",
    {
      title: "V4.5 text-to-image",
      description: "Fill a NovelAI V4.5 txt2img request, then call nai_generate_image.",
      argsSchema: z.object({
        prompt: z.string(),
        negative_prompt: z.string().optional(),
      }),
    },
    ({ prompt, negative_prompt }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call nai_generate_image with model=${DEFAULT_IMAGE_MODEL}, resolution=${DEFAULT_RESOLUTION}, prompt=${JSON.stringify(prompt)}${negative_prompt ? `, negative_prompt=${JSON.stringify(negative_prompt)}` : ""}.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "multi_character",
    {
      title: "Multi-character scene",
      description: "V4.5 multi-character generation with canvas positions.",
      argsSchema: z.object({
        scene: z.string(),
        char1: z.string(),
        char2: z.string(),
      }),
    },
    ({ scene, char1, char2 }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call nai_generate_image with prompt=${JSON.stringify(scene)}, character_prompts=[{prompt:${JSON.stringify(char1)},x:0.3,y:0.5},{prompt:${JSON.stringify(char2)},x:0.7,y:0.5}], model=${DEFAULT_IMAGE_MODEL}.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "story_continue",
    {
      title: "Continue a story",
      description: "Continue prose with NovelAI native text generation.",
      argsSchema: z.object({
        input: z.string(),
      }),
    },
    ({ input }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Call nai_generate_text with model=${DEFAULT_STORY_MODEL} and input=${JSON.stringify(input)}.`,
          },
        },
      ],
    }),
  );
}
