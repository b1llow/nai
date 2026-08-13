import type { Context } from "hono";
import type { Env } from "./env";
import type { AppEnv } from "./types";
import { HttpError, openaiError } from "./errors";
import { NAI_OA, naiFetch, readBodyCapped, throwMappedUpstreamError } from "./upstream";
import { MAX_MODEL_LEN, MAX_MODELS_RESPONSE_BYTES, safeIdent } from "./limits";

export const FALLBACK_MODELS = [
  {
    id: "xialong-v1",
    object: "model" as const,
    created: 1735689600,
    owned_by: "novelai",
  },
  {
    id: "glm-4-6",
    object: "model" as const,
    created: 1735689600,
    owned_by: "novelai",
  },
];

export type ModelItem = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

function normalizeModel(item: unknown): ModelItem | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || o.id.length > MAX_MODEL_LEN) return null;
  return {
    id: o.id,
    object: "model",
    created: typeof o.created === "number" && Number.isFinite(o.created) ? o.created : 1735689600,
    owned_by:
      typeof o.owned_by === "string" && o.owned_by.length <= 64
        ? o.owned_by
        : "novelai",
  };
}

export async function fetchModels(
  env: Env,
  auth: string,
  signal?: AbortSignal,
): Promise<ModelItem[]> {
  try {
    const res = await naiFetch(env, NAI_OA.models, {
      method: "GET",
      auth,
      signal,
    });
    if (!res.ok) {
      // Auth/rate-limit failures must surface so clients can validate keys.
      // Other upstream failures fall back to the known model list.
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        await throwMappedUpstreamError(res);
      }
      return FALLBACK_MODELS.slice();
    }
    const { text, truncated } = await readBodyCapped(
      res,
      MAX_MODELS_RESPONSE_BYTES,
    );
    if (truncated) return FALLBACK_MODELS.slice();
    let body: { data?: unknown };
    try {
      body = JSON.parse(text) as { data?: unknown };
    } catch {
      return FALLBACK_MODELS.slice();
    }
    if (!Array.isArray(body.data) || body.data.length === 0) {
      return FALLBACK_MODELS.slice();
    }
    const models = body.data
      .slice(0, 256)
      .map(normalizeModel)
      .filter((m): m is ModelItem => m !== null);
    return models.length > 0 ? models : FALLBACK_MODELS.slice();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name === "AbortError") throw err;
    return FALLBACK_MODELS.slice();
  }
}

export async function listModels(c: Context<AppEnv>) {
  const auth = c.get("auth") as string;
  const data = await fetchModels(c.env, auth, c.req.raw.signal);
  return c.json({ object: "list", data });
}

export async function getModel(c: Context<AppEnv>) {
  const auth = c.get("auth") as string;
  const id = c.req.param("id") ?? "";
  if (!id || id.length > MAX_MODEL_LEN) {
    throw openaiError(404, "The model does not exist", {
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }
  const data = await fetchModels(c.env, auth, c.req.raw.signal);
  const found = data.find((m) => m.id === id);
  if (!found) {
    throw openaiError(404, `The model '${safeIdent(id, MAX_MODEL_LEN)}' does not exist`, {
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }
  return c.json(found);
}
