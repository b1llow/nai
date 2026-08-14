import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { HttpError, openaiError } from "../errors";
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
  inpaintingModel,
  resolutionPresetDescribe,
} from "../nai/catalog";
import { encodeVibe, generateImage, suggestTags } from "../nai/image";
import { generateNativeText } from "../nai/text";
import { generateVoice } from "../nai/voice";
import type { GenerateImageInput } from "../nai/image-payload";
import { imageResourceUri } from "../nai/image-input";
import { MAX_IMAGE_SAMPLES } from "../limits";
import {
  artifactOwner,
  getCachedVibe,
  getImage,
  putCachedVibe,
  putVibe,
  resolveImageOrVibeRef,
  resolveImageRef,
  vibeIeKey,
} from "./artifacts";
import {
  IMAGE_WIDGET_RENDER_TOOL,
  IMAGE_WIDGET_URI,
  imageToolStatusMeta,
  imageWidgetToolMeta,
  registerImageWidget,
} from "./image-widget";
import { publishImage } from "./public-image";
import { mcpJson, mcpText, runTool, withImages, type McpContent } from "./result";

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

const IMAGE_REF_HINT =
  "Preferred: image_id from a previous image tool (img_<32 hex>) or nai://image/img_.... Also accepts PNG base64 / data URL. Do not pass a filename such as image_0.png.";

const REF_IMAGE_HINT =
  "image_id, vibe_id from nai_encode_vibe, PNG base64 / data URL, or a pre-encoded vibe token (set encoded=true). Do not pass a filename.";

const referenceImageSchema = z.object({
  image: z.string().describe(REF_IMAGE_HINT),
  strength: z.number().min(0).max(1).optional(),
  information_extracted: z.number().min(0.01).max(1).optional(),
  encoded: z.boolean().optional(),
});

const directorReferenceSchema = z.object({
  image: z.string().describe(IMAGE_REF_HINT),
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
  image: z.string().optional().describe(`Source for img2img/infill. ${IMAGE_REF_HINT}`),
  mask: z.string().optional().describe(`Inpaint mask (white = edit). ${IMAGE_REF_HINT}`),
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

const storedImageOutputSchema = z.object({
  image_id: z.string().nullable(),
  filename: z.string(),
  mime_type: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  resource_uri: z.string().optional(),
  url: z.string().optional(),
  skipped: z.string().optional(),
});

const imageMetaOutputSchema = z.object({
  image_id: z.string().nullable(),
  image_url: z.string().optional(),
  images: z.array(storedImageOutputSchema),
  seed: z.number(),
  model: z.string(),
  action: z.string(),
  width: z.number(),
  height: z.number(),
});

const upscaleOutputSchema = z.object({
  image_id: z.string().nullable(),
  image_url: z.string().optional(),
  images: z.array(storedImageOutputSchema),
  scale: z.union([z.literal(2), z.literal(4)]),
});

const directorOutputSchema = z.object({
  image_id: z.string().nullable(),
  image_url: z.string().optional(),
  images: z.array(storedImageOutputSchema),
  req_type: z.string(),
});

const getImageOutputSchema = z.object({
  image_id: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  resource_uri: z.string(),
  url: z.string().optional(),
  image_url: z.string().optional(),
});

const renderImageOutputSchema = z.object({
  image_id: z.string(),
  image_url: z.string().optional(),
  images: z.array(storedImageOutputSchema),
  model: z.string().optional(),
  seed: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const RENDER_AFTER =
  "After success, call nai_render_image_preview with the image_id (or image_ids) so ChatGPT can mount the preview UI. If image_id is null, this result already binds the preview — do not call nai_render_image_preview. Do not open ui:// URIs.";

export function collectPreviewImageIds(args: {
  image_id?: string;
  image_ids?: string[];
}): string[] {
  const ids: string[] = [];
  if (args.image_id?.trim()) ids.push(args.image_id.trim());
  for (const raw of args.image_ids ?? []) {
    const id = raw.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_IMAGE_SAMPLES) {
    throw openaiError(
      400,
      `Pass at most ${MAX_IMAGE_SAMPLES} unique images across image_id and image_ids.`,
      { type: "invalid_request_error", param: "image_ids" },
    );
  }
  return ids;
}

const tagsOutputSchema = z.object({
  tags: z.unknown(),
});

const vibeOutputSchema = z.object({
  vibe_id: z.string(),
  model: z.string(),
  information_extracted: z.number(),
  usage: z.string(),
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
  origin: string,
): void {
  registerImageWidget(server, origin);

  server.registerTool(
    "nai_generate_image",
    {
      title: "Generate image",
      description:
        `NovelAI Diffusion image generation (txt2img, img2img, inpaint). Default model is nai-diffusion-4-5-full. Size: pass resolution as a preset name such as normal_portrait, or numeric width+height; never 1024x1024 or portrait. V4+ character prompts, vibe transfer (PNG refs are auto-encoded via /ai/encode-vibe, costing Anlas), and director references are supported. Returns a public image_url (WebP) — embed that URL in markdown so the user can see the image. Also returns image_id — pass that image_id to nai_upscale, nai_director, nai_encode_vibe, nai_get_image, nai_render_image_preview, or img2img. Do not pass filenames such as image_0.png, and do not echo image bytes. ${RENDER_AFTER}`,
      inputSchema: naiGenerateImageInputSchema,
      outputSchema: imageMetaOutputSchema,
      _meta: imageToolStatusMeta("Generating image…", "Image ready"),
    },
    async (args) =>
      runTool(auth, async (token) => {
        const owner = await artifactOwner(token);
        const input = await resolveGenerateInput(env, owner, args);
        const result = await generateImage(env, token, input);
        return withImages(
          { env, owner, origin },
          {
            seed: result.seed,
            model: result.model,
            action: result.action,
            width: result.width,
            height: result.height,
          },
          result.images,
        );
      }),
  );

  server.registerTool(
    "nai_upscale",
    {
      title: "Upscale image",
      description:
        `NovelAI 2x or 4x upscale. Costs Anlas. Pass image_id from a previous image tool (preferred) or PNG base64. Returns a public image_url and a new image_id. ${RENDER_AFTER}`,
      inputSchema: z.object({
        image: z.string().describe(IMAGE_REF_HINT),
        scale: z.union([z.literal(2), z.literal(4)]).optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
      }),
      outputSchema: upscaleOutputSchema,
      _meta: imageToolStatusMeta("Upscaling image…", "Upscaled image ready"),
    },
    async (args) =>
      runTool(auth, async (token) => {
        const owner = await artifactOwner(token);
        const decoded = await resolveImageRef(env, owner, args.image, "image");
        const images = await upscaleImage(env, token, {
          ...args,
          image: decoded.base64,
          width: args.width ?? decoded.width,
          height: args.height ?? decoded.height,
        });
        return withImages(
          { env, owner, origin },
          { scale: args.scale === 4 ? 4 : 2 },
          images,
        );
      }),
  );

  server.registerTool(
    "nai_director",
    {
      title: "Director tools",
      description:
        `NovelAI Director Tools: lineart, sketch, colorize, emotion, declutter, bg-removal. Pass image_id from a previous image tool (preferred) or PNG base64. Width/height default from stored metadata or the PNG IHDR. Returns a public image_url and a new image_id. ${RENDER_AFTER}`,
      inputSchema: z.object({
        req_type: z.enum(DIRECTOR_TYPES),
        image: z.string().describe(IMAGE_REF_HINT),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        prompt: z.string().optional(),
        defry: z.number().int().min(0).max(5).optional(),
        emotion: z.enum(EMOTIONS).optional(),
        emotion_level: z.number().int().min(0).max(5).optional(),
      }),
      outputSchema: directorOutputSchema,
      _meta: imageToolStatusMeta("Editing image…", "Edited image ready"),
    },
    async (args) =>
      runTool(auth, async (token) => {
        const owner = await artifactOwner(token);
        const decoded = await resolveImageRef(env, owner, args.image, "image");
        const images = await runDirector(env, token, {
          ...args,
          image: decoded.base64,
          width: args.width ?? decoded.width,
          height: args.height ?? decoded.height,
        });
        return withImages({ env, owner, origin }, { req_type: args.req_type }, images);
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
        "Encode a PNG into a V4+ vibe token (2 Anlas per unique encode; repeats of the same PNG+model+information_extracted are cached). Pass image_id or PNG. Returns vibe_id — pass that as nai_generate_image reference_images[].image. The raw token is not returned.",
      inputSchema: z.object({
        image: z.string().describe(IMAGE_REF_HINT),
        model: z.string().optional(),
        information_extracted: z.number().min(0.01).max(1).optional(),
      }),
      outputSchema: vibeOutputSchema,
    },
    async (args) =>
      runTool(auth, async (token) => {
        const owner = await artifactOwner(token);
        const decoded = await resolveImageRef(env, owner, args.image, "image");
        const model = args.model ?? DEFAULT_IMAGE_MODEL;
        const information_extracted = args.information_extracted ?? 1;
        const cached = await getCachedVibe(
          env,
          owner,
          decoded.bytes,
          model,
          information_extracted,
        );
        const tokenB64 =
          cached ??
          (await encodeVibe(env, token, {
            image: decoded.base64,
            model,
            information_extracted,
          }));
        if (!cached) {
          await putCachedVibe(
            env,
            owner,
            decoded.bytes,
            model,
            information_extracted,
            tokenB64,
          );
        }
        const vibe_id = await putVibe(env, owner, tokenB64, {
          model,
          information_extracted,
        });
        if (!vibe_id) {
          throw openaiError(
            400,
            "vibe_id could not be stored. Retry nai_encode_vibe, or pass the same PNG as reference_images[].image (the encode is cached).",
          );
        }
        return mcpJson({
          vibe_id,
          model,
          information_extracted,
          usage:
            "Pass vibe_id as nai_generate_image reference_images[].image. The encoded token is stored server-side.",
        });
      }),
  );

  server.registerTool(
    "nai_get_image",
    {
      title: "Get stored image",
      description:
        "Reload a previously generated image by image_id. Returns the public image_url (re-publishes the WebP if needed). Pass image_id — not a filename. This does not mount the ChatGPT preview widget; call nai_render_image_preview for that.",
      inputSchema: z.object({
        image_id: z
          .string()
          .describe("image_id or nai://image/img_... URI from a previous image tool"),
      }),
      outputSchema: getImageOutputSchema,
      _meta: imageToolStatusMeta("Loading image…", "Image loaded"),
    },
    async (args) =>
      runTool(auth, async (token) => {
        const owner = await artifactOwner(token);
        const img = await getImage(env, owner, args.image_id, "image_id");
        const published = await publishImage(env, origin, img.id, img.bytes);
        const structuredContent: {
          image_id: string;
          filename: string;
          mime_type: string;
          width?: number;
          height?: number;
          resource_uri: string;
          url?: string;
          image_url?: string;
        } = {
          image_id: img.id,
          filename: img.name,
          mime_type: published?.mime ?? img.mime,
          width: img.width,
          height: img.height,
          resource_uri: imageResourceUri(img.id),
        };
        if (published) {
          structuredContent.url = published.url;
          structuredContent.image_url = published.url;
        }
        const content: McpContent[] = [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        ];
        if (published) {
          content.push({
            type: "resource_link",
            uri: published.url,
            name: published.filename,
            mimeType: published.mime,
          });
        } else {
          content.push({
            type: "image",
            data: img.base64,
            mimeType: img.mime,
            annotations: { audience: ["user"] },
          });
          content.push({
            type: "resource_link",
            uri: structuredContent.resource_uri,
            name: img.name,
            mimeType: img.mime,
          });
        }
        return { content, structuredContent };
      }),
  );

  server.registerTool(
    IMAGE_WIDGET_RENDER_TOOL,
    {
      title: "Render image preview",
      description:
        "Mount the NovelAI image preview UI in ChatGPT. Always call this after nai_generate_image, nai_upscale, or nai_director when the user should see the image. Pass image_id (and image_ids when n_samples > 1). You cannot open ui:// URIs yourself — this tool is what binds ui://novelai/image-preview-v4.html. Do not pass PNG base64 or filenames.",
      inputSchema: z.object({
        image_id: z
          .string()
          .describe(
            "image_id or nai://image/img_... from a previous image tool. Required unless image_ids is set.",
          )
          .optional(),
        image_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_IMAGE_SAMPLES)
          .optional()
          .describe(
            `Additional image_ids when n_samples > 1. Combined with image_id, at most ${MAX_IMAGE_SAMPLES} unique ids.`,
          ),
        model: z.string().optional().describe("Optional caption from the generate result."),
        seed: z.number().optional().describe("Optional caption from the generate result."),
      }),
      outputSchema: renderImageOutputSchema,
      _meta: imageWidgetToolMeta("Rendering preview…", "Preview ready"),
    },
    async (args) =>
      runTool(
        auth,
        async (token) => {
          const ids = collectPreviewImageIds(args);
          if (!ids.length) {
            throw openaiError(
              400,
              "Pass image_id or image_ids from a previous image tool.",
              { type: "invalid_request_error", param: "image_id" },
            );
          }
          const owner = await artifactOwner(token);
          const loaded: Array<{
            image_id: string;
            filename: string;
            mime_type: string;
            width?: number;
            height?: number;
            resource_uri: string;
            url?: string;
          }> = [];
          const content: McpContent[] = [];
          for (const raw of ids) {
            const img = await getImage(env, owner, raw, "image_id");
            const published = await publishImage(env, origin, img.id, img.bytes);
            const resource_uri = imageResourceUri(img.id);
            loaded.push({
              image_id: img.id,
              filename: img.name,
              mime_type: published?.mime ?? img.mime,
              width: img.width,
              height: img.height,
              resource_uri,
              ...(published ? { url: published.url } : {}),
            });
            if (published) {
              content.push({
                type: "resource_link",
                uri: published.url,
                name: published.filename,
                mimeType: published.mime,
              });
            } else {
              content.push({
                type: "image",
                data: img.base64,
                mimeType: img.mime,
                annotations: { audience: ["user"] },
              });
              content.push({
                type: "resource_link",
                uri: resource_uri,
                name: img.name,
                mimeType: img.mime,
              });
            }
          }
          const first = loaded[0]!;
          const structuredContent = {
            image_id: first.image_id,
            images: loaded,
            ...(first.url ? { image_url: first.url } : {}),
            ...(args.model ? { model: args.model } : {}),
            ...(typeof args.seed === "number" ? { seed: args.seed } : {}),
            ...(first.width !== undefined ? { width: first.width } : {}),
            ...(first.height !== undefined ? { height: first.height } : {}),
          };
          content.unshift({
            type: "text",
            text: JSON.stringify(structuredContent, null, 2),
          });
          return { content, structuredContent };
        },
        { widget: true, templateUri: IMAGE_WIDGET_URI },
      ),
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
    "generated-image",
    new ResourceTemplate("nai://image/{id}", { list: undefined }),
    {
      title: "Generated image",
      description:
        "PNG stored from a previous image tool. Pass the image_id to nai_upscale, nai_director, nai_encode_vibe, or nai_get_image. Not listed.",
      mimeType: "image/png",
    },
    async (uri, { id }) => {
      if (!auth) {
        throw new ResourceNotFoundError(uri.href);
      }
      try {
        const owner = await artifactOwner(auth);
        const img = await getImage(env, owner, String(id), "image_id");
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: img.mime,
              blob: img.base64,
            },
          ],
        };
      } catch (err) {
        if (err instanceof HttpError && err.status < 500) {
          throw new ResourceNotFoundError(uri.href, err.message);
        }
        throw err;
      }
    },
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
            text: `Call nai_generate_image with model=${DEFAULT_IMAGE_MODEL}, resolution=${DEFAULT_RESOLUTION}, prompt=${JSON.stringify(prompt)}${negative_prompt ? `, negative_prompt=${JSON.stringify(negative_prompt)}` : ""}. Then call nai_render_image_preview with the returned image_id.`,
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
            text: `Call nai_generate_image with prompt=${JSON.stringify(scene)}, character_prompts=[{prompt:${JSON.stringify(char1)},x:0.3,y:0.5},{prompt:${JSON.stringify(char2)},x:0.7,y:0.5}], model=${DEFAULT_IMAGE_MODEL}. Then call nai_render_image_preview with the returned image_id.`,
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

async function resolveGenerateInput(
  env: Env,
  owner: string,
  args: GenerateImageInput,
): Promise<GenerateImageInput> {
  const image = args.image
    ? (await resolveImageRef(env, owner, args.image, "image")).base64
    : undefined;
  const mask = args.mask
    ? (await resolveImageRef(env, owner, args.mask, "mask")).base64
    : undefined;
  const generateModel = effectiveGenerateModel(args);
  const reference_images = args.reference_images
    ? await Promise.all(
        args.reference_images.map(async (ref) => {
          const resolved = await resolveImageOrVibeRef(
            env,
            owner,
            ref.image,
            "reference_images",
          );
          if (resolved.model && resolved.model !== generateModel) {
            throw openaiError(
              400,
              `vibe_id was encoded for ${resolved.model}, but this request uses ${generateModel}. Re-encode with nai_encode_vibe model=${generateModel}.`,
              { type: "invalid_request_error", param: "reference_images" },
            );
          }
          if (
            resolved.information_extracted !== undefined &&
            ref.information_extracted !== undefined &&
            vibeIeKey(ref.information_extracted) !==
              vibeIeKey(resolved.information_extracted)
          ) {
            throw openaiError(
              400,
              `reference_images information_extracted does not match vibe_id (stored ${resolved.information_extracted}). Omit information_extracted or re-encode with nai_encode_vibe.`,
              { type: "invalid_request_error", param: "reference_images" },
            );
          }
          return {
            ...ref,
            image: resolved.image,
            encoded: resolved.encoded || ref.encoded,
            information_extracted:
              resolved.information_extracted ?? ref.information_extracted,
          };
        }),
      )
    : undefined;
  const director_references = args.director_references
    ? await Promise.all(
        args.director_references.map(async (ref) => ({
          ...ref,
          image: (await resolveImageRef(env, owner, ref.image, "director_references"))
            .base64,
        })),
      )
    : undefined;
  return { ...args, image, mask, reference_images, director_references };
}

function effectiveGenerateModel(args: GenerateImageInput): string {
  const model = (args.model ?? DEFAULT_IMAGE_MODEL).trim();
  return args.action === "infill" ? inpaintingModel(model) : model;
}
