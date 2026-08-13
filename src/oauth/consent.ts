import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAUTH_CONSENT_TTL_SECONDS } from "../limits";

const KV_PREFIX = "consent:";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConsentRecord = {
  request: AuthRequest;
  csrf: string;
};

export function isConsentId(value: string): boolean {
  return UUID_RE.test(value);
}

export async function putConsent(
  kv: KVNamespace,
  consentId: string,
  record: ConsentRecord,
): Promise<void> {
  await kv.put(`${KV_PREFIX}${consentId}`, JSON.stringify(record), {
    expirationTtl: OAUTH_CONSENT_TTL_SECONDS,
  });
}

export async function takeConsent(
  kv: KVNamespace,
  consentId: string,
): Promise<ConsentRecord | null> {
  const key = `${KV_PREFIX}${consentId}`;
  const raw = await kv.get(key, "json");
  await kv.delete(key);
  return parseConsentRecord(raw);
}

function parseConsentRecord(raw: unknown): ConsentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { request?: AuthRequest; csrf?: unknown };
  if (!rec.request || typeof rec.csrf !== "string" || !rec.csrf) return null;
  if (typeof rec.request.clientId !== "string") return null;
  if (typeof rec.request.redirectUri !== "string") return null;
  return { request: rec.request, csrf: rec.csrf };
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Same-origin POST check so a cross-site form cannot submit a stolen consent id. */
export function isSameOriginRequest(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === url.origin;
  } catch {
    return false;
  }
}
