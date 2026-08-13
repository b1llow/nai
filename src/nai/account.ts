import type { Env } from "../env";
import { MAX_MODELS_RESPONSE_BYTES } from "../limits";
import { naiFetchJson } from "../upstream";

const SUBSCRIPTION_KEYS = [
  "tier",
  "active",
  "expiresAt",
  "perks",
  "trainingStepsLeft",
  "accountAge",
] as const;

function pickSafe(obj: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return {};
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

/** Account GETs live on `image.novelai.net`; `api.novelai.net` returns 400. */
export async function getSubscription(
  env: Env,
  auth: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const data = await naiFetchJson(
    env,
    "/user/subscription",
    { method: "GET", auth, host: "image", signal },
    MAX_MODELS_RESPONSE_BYTES,
  );
  const picked = pickSafe(data, SUBSCRIPTION_KEYS);
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (o.perks && typeof o.perks === "object") {
      const perks = o.perks as Record<string, unknown>;
      picked.unlimitedMaxPriority = perks.unlimitedMaxPriority;
      picked.maxPriorityActions = perks.maxPriorityActions;
      picked.contextTokens = perks.contextTokens;
    }
    if (typeof o.trainingStepsLeft === "object" && o.trainingStepsLeft) {
      picked.trainingStepsLeft = o.trainingStepsLeft;
    }
    // Anlas / fixed training steps often live under these names.
    if ("fixedTrainingStepsLeft" in o) {
      picked.anlas = o.fixedTrainingStepsLeft;
    }
    if (typeof o.trainingStepsLeft === "number") {
      picked.anlas = o.trainingStepsLeft;
    }
  }
  return picked;
}

export async function getUserInformation(
  env: Env,
  auth: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const data = await naiFetchJson(
    env,
    "/user/information",
    { method: "GET", auth, host: "image", signal },
    MAX_MODELS_RESPONSE_BYTES,
  );
  return pickSafe(data, [
    "emailVerified",
    "email",
    "status",
    "createdAt",
    "trialActivated",
    "accountAge",
  ]);
}
